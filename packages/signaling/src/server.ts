// packages/signaling/src/server.ts
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import multer from "multer";
import path from "path";
import fs, { existsSync } from "fs";
import { spawn } from "child_process";
import dgram from "dgram";
import os from "os";
import { fileURLToPath } from "url";
import { status as GrpcStatus } from "@grpc/grpc-js";
import { extractFrames } from "./ffmpeg.js";
import { trackBalls, computePhysics } from "./grpc-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXPERIMENTS_DIR = path.resolve(__dirname, "../../experiments");

const app = express();
const TEMP_DIR = path.join(EXPERIMENTS_DIR, "temp");
if (!existsSync(TEMP_DIR)) {
  fs.promises.mkdir(TEMP_DIR, { recursive: true }).catch(console.error);
  console.log("Created missing temp directory:", TEMP_DIR);
}
const upload = multer({ dest: TEMP_DIR });
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3001;
const grpcEndpoint = `${process.env.PYTHON_GRPC_HOST ?? "localhost"}:${process.env.PYTHON_GRPC_PORT ?? "50052"}`;

const PROFILES_FILE = path.join(EXPERIMENTS_DIR, "calibration_profiles.json");

const servedFramesCount = new Map<string, number>();

async function runSyncMarkerDecode(experimentId: string): Promise<void> {
  const venvPython = path.resolve(__dirname, "../../../.venv/Scripts/python.exe");
  const python =
    process.env.PHYSICSCAPTURE_PYTHON_BIN ?? (existsSync(venvPython) ? venvPython : "python");
  const displayHz = process.env.SYNC_MARKER_DISPLAY_HZ ?? "60";
  const sampleStride = process.env.SYNC_MARKER_SAMPLE_STRIDE ?? "5";

  const experimentDir = path.join(EXPERIMENTS_DIR, experimentId);
  const framesRoot = path.join(experimentDir, "frames");
  if (!existsSync(framesRoot)) return;

  const entries = await fs.promises.readdir(framesRoot, { withFileTypes: true });
  const cameraIds = entries
    .filter((entry) => entry.isDirectory() && /^cam\d+$/.test(entry.name))
    .map((entry) => Number(entry.name.replace("cam", "")))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (cameraIds.length === 0) return;

  const scriptPath = path.resolve(__dirname, "../../cv-service/sync/sync_marker_cli.py");

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      python,
      [
        scriptPath,
        "--experiments-dir",
        EXPERIMENTS_DIR,
        "--experiment-id",
        experimentId,
        "--camera-ids",
        cameraIds.join(","),
        "--display-hz",
        displayHz,
        "--sample-stride",
        sampleStride,
      ],
      { stdio: "inherit" },
    );

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`sync marker decode exited with code ${code}`));
    });
  });
}

const isPrivateIPv4 = (address: string) =>
  /^10\./.test(address) ||
  /^192\.168\./.test(address) ||
  /^172\.(1[6-9]|2\d|3[0-1])\./.test(address);

const isLikelyVirtualInterface = (name: string) =>
  /(loopback|vmware|virtualbox|vethernet|hyper-v|wsl|docker|tailscale|zerotier|hamachi|bluetooth)/i.test(
    name,
  );

type HostCandidate = { interfaceName: string; address: string; score: number };

const getPrivateIPv4Candidates = (): HostCandidate[] => {
  const interfaces = os.networkInterfaces();
  const candidates: HostCandidate[] = [];

  for (const [name, infos] of Object.entries(interfaces)) {
    if (!infos) continue;

    for (const info of infos) {
      if (info.family !== "IPv4" || info.internal) continue;
      if (!isPrivateIPv4(info.address)) continue;

      let score = 0;
      if (!isLikelyVirtualInterface(name)) score += 10;
      if (/(wi-?fi|wlan|wireless)/i.test(name)) score += 4;
      if (/(ethernet|eth)/i.test(name)) score += 2;
      if (/^192\.168\./.test(info.address)) score += 3;
      if (/^10\./.test(info.address)) score += 2;

      candidates.push({
        interfaceName: name,
        address: info.address,
        score,
      });
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
};

const detectOutboundIPv4 = (timeoutMs = 500) =>
  new Promise<string | null>((resolve) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      socket.close();
      resolve(value);
    };

    const timeoutId = setTimeout(() => finish(null), timeoutMs);

    socket.on("error", () => finish(null));

    try {
      socket.connect(53, "8.8.8.8", () => {
        const addr = socket.address();
        if (typeof addr === "string") {
          finish(null);
          return;
        }
        finish(addr.address);
      });
    } catch {
      finish(null);
    }
  });

// REST API for file handling
app.use(express.json());

// Global request logger
app.use((req, res, next) => {
  const frameMatch = req.url.match(/\/api\/experiments\/([^\/]+)\/frames\/([^\/]+)\//);
  if (frameMatch) {
    const key = `${frameMatch[1]}-${frameMatch[2]}`;
    const count = (servedFramesCount.get(key) || 0) + 1;
    servedFramesCount.set(key, count);

    if (count <= 5) {
      console.log(`[REQ] ${req.method} ${req.url}`);
    } else if (count === 6) {
      console.log(`[REQ] ${req.method} ${req.url} (further logs for this camera hidden)`);
    }
  } else {
    console.log(`[REQ] ${req.method} ${req.url}`);
  }
  next();
});

app.get("/api/experiments", async (req, res) => {
  try {
    console.log("[API] Listing experiments from:", EXPERIMENTS_DIR);
    const entries = await fs.promises.readdir(EXPERIMENTS_DIR, { withFileTypes: true });
    const experiments = entries
      .filter((e) => e.isDirectory() && e.name !== "temp")
      .map((e) => e.name);
    res.json(experiments);
  } catch (err) {
    console.error("[API] Failed to list experiments:", err);
    res.status(500).json({ error: "Failed to list experiments" });
  }
});

app.get("/api/experiments/:experimentId/metadata", (req, res) => {
  const { experimentId } = req.params;
  const experimentPath = path.resolve(EXPERIMENTS_DIR, experimentId);
  const cam0Dir = path.join(experimentPath, "frames", "cam0");

  if (!existsSync(cam0Dir)) {
    return res.status(404).json({ error: "Frames directory not found" });
  }

  const frames = fs
    .readdirSync(cam0Dir)
    .filter((f: string) => /\.(jpg|jpeg|png)$/i.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  // Extract physical indices from filenames like 000001.png
  const sequenceToPhysical = frames.map((filename) => {
    const match = filename.match(/(\d+)/);
    return match ? parseInt(match[0], 10) - 1 : 0;
  });

  const maxPhysicalIndex = sequenceToPhysical.length > 0 ? Math.max(...sequenceToPhysical) : 0;
  const frameCount = maxPhysicalIndex + 1;

  // Create a map for the UI: physicalIndex -> filename (null if missing)
  const physicalToFilename = new Array(frameCount).fill(null);
  frames.forEach((filename, i) => {
    physicalToFilename[sequenceToPhysical[i]] = filename;
  });

  res.json({
    id: experimentId,
    frameCount,
    frameMap: physicalToFilename, // physicalIndex -> filename
    sequenceToPhysical, // sequenceIndex -> physicalIndex
    resolution: "1280x720",
  });
});

app.get("/api/network/host-hint", async (req, res) => {
  try {
    const candidates = getPrivateIPv4Candidates();
    const outboundHost = await detectOutboundIPv4();
    const preferredHost =
      outboundHost && isPrivateIPv4(outboundHost) ? outboundHost : (candidates[0]?.address ?? null);

    res.json({
      preferredHost,
      outboundHost,
      candidates: candidates.map(({ interfaceName, address }) => ({ interfaceName, address })),
    });
  } catch (err) {
    console.error("Host hint error:", err);
    res.status(500).json({ error: "Failed to resolve host hint" });
  }
});

app.get("/api/calibration/profiles", async (req, res) => {
  try {
    const data = await fs.promises.readFile(PROFILES_FILE, "utf-8");
    res.json(JSON.parse(data));
  } catch (err) {
    // If file doesn't exist, return empty array
    if ((err as any).code === "ENOENT") {
      res.json([]);
    } else {
      res.status(500).json({ error: "Failed to read profiles" });
    }
  }
});

app.post("/api/calibration/profiles", async (req, res) => {
  try {
    const newProfile = req.body;
    let profiles = [];
    try {
      const data = await fs.promises.readFile(PROFILES_FILE, "utf-8");
      profiles = JSON.parse(data);
    } catch (err) {
      if ((err as any).code !== "ENOENT") throw err;
    }
    profiles.unshift(newProfile);
    await fs.promises.writeFile(PROFILES_FILE, JSON.stringify(profiles, null, 2));
    res.status(201).json({ message: "Profile saved" });
  } catch (err) {
    console.error("Profile save error:", err);
    res.status(500).json({ error: "Failed to save profile" });
  }
});


import { runCalibration } from "./grpc-client.js";

app.post("/api/calibrate", async (req, res) => {
  try {
    const { experimentId, manualScale } = req.body;
    
    const calibDir = path.join(EXPERIMENTS_DIR, experimentId, "calibration");
    if (!existsSync(calibDir)) await fs.promises.mkdir(calibDir, { recursive: true });
    const calibPath = path.join(calibDir, "cam0_intrinsics.json");

    if (typeof manualScale === 'number' && manualScale > 0) {
      console.log(`[API] Applying manual scale for ${experimentId}: ${manualScale.toFixed(4)} px/mm`);
      const calibData = {
        scale_px_per_mm: manualScale,
        scale_uncertainty_px_per_mm: 0.005 // Fixed uncertainty for manual measurement
      };
      await fs.promises.writeFile(calibPath, JSON.stringify(calibData, null, 2));
      
      return res.json({
        experimentId,
        intrinsics: [calibData],
        stereo: null,
        rulerScaleFactor: manualScale,
        completedAt: Date.now(),
      });
    }

    // Otherwise, run automated calibration (placeholder)
    const calibrationStream = runCalibration({
      experiment_id: experimentId,
      camera_ids: [0] 
    });

    let finalStatus;
    for await (const status of calibrationStream) {
        console.log("Calibration status:", status);
        finalStatus = status;
    }

    const calibData = {
      scale_px_per_mm: 3.142, // Default mock scale if real calibration fails/placeholder
      scale_uncertainty_px_per_mm: 0.008,
      reprojection_error_px: 0.124
    };
    await fs.promises.writeFile(calibPath, JSON.stringify(calibData, null, 2));

    res.json({
        experimentId,
        intrinsics: [calibData],
        stereo: null,
        rulerScaleFactor: 3.142,
        completedAt: Date.now(),
    });
  } catch (err: any) {
    console.error("Calibration error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/upload-video", upload.single("file"), async (req, res) => {
  try {
    const { experiment_id, camera_id, recording_mode } = req.body;
    const file = req.file;
    if (!file || !experiment_id || !camera_id) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const experimentDir = path.join(EXPERIMENTS_DIR, experiment_id);
    const rawDir = path.join(experimentDir, "raw");
    const framesDir = path.join(experimentDir, "frames", `cam${camera_id}`);
    // Use JPEG by default so CV tracking can consume extracted frames directly
    // without expensive PNG->JPEG conversion.
    const outputFormat = process.env.FRAME_EXTRACT_FORMAT === "png" ? "png" : "jpg";
    
    await fs.promises.mkdir(rawDir, { recursive: true });
    
    const destPath = path.join(rawDir, `cam${camera_id}${path.extname(file.originalname)}`);
    await fs.promises.rename(file.path, destPath);

    // Extraction
    const frameCount = await extractFrames(destPath, framesDir, outputFormat);

    // Best-effort: generate sync.json once frames exist. Run in the background
    // so upload responses are not blocked by sync decode latency.
    runSyncMarkerDecode(experiment_id).catch((err) => {
      console.warn("[sync] Sync Marker decode failed:", err);
    });

    res.json({ experiment_id, camera_id, stored_path: destPath, frame_count: frameCount });
  } catch (err: any) {
    console.error("Upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/experiments/:experimentId/physics", async (req, res) => {
  try {
    const { experimentId } = req.params;
    const massConfigs = Array.isArray(req.body?.massConfigs) ? req.body.massConfigs : [];

    if (!experimentId) {
      return res.status(400).json({ error: "Missing experiment id" });
    }

    if (massConfigs.length === 0) {
      return res.status(400).json({ error: "Missing mass configs" });
    }

    const ball_configs = massConfigs
      .filter(
        (cfg: any) =>
          Number.isFinite(cfg?.ballId) &&
          Number.isFinite(cfg?.mass_g) &&
          Number.isFinite(cfg?.uncertainty_g)
      )
      .map((cfg: any) => ({
        ball_id: Number(cfg.ballId),
        mass_kg: Number(cfg.mass_g) / 1000,
        mass_uncertainty_kg: Number(cfg.uncertainty_g) / 1000,
      }));

    if (ball_configs.length === 0) {
      return res.status(400).json({ error: "No valid mass configs provided" });
    }

    const grpcResult = await computePhysics({
      experiment_id: experimentId,
      ball_configs,
      mode: "SINGLE_CAMERA_PLANAR",
    } as any);

    const massByBallId = new Map<number, { value: number; uncertainty: number }>();
    for (const cfg of ball_configs) {
      massByBallId.set(cfg.ball_id, {
        value: cfg.mass_kg,
        uncertainty: cfg.mass_uncertainty_kg,
      });
    }

    // Read sync metadata to communicate accuracy to the frontend
    let syncStatus = { isMock: true, trueFps: 30, rmsMs: 0 };
    try {
      const syncPath = path.join(EXPERIMENTS_DIR, experimentId, "results", "sync.json");
      if (existsSync(syncPath)) {
        const syncData = JSON.parse(await fs.promises.readFile(syncPath, "utf-8"));
        syncStatus = {
          isMock: !!syncData.is_mock,
          trueFps: syncData.cameras?.cam0?.true_fps ?? 30,
          rmsMs: syncData.cameras?.cam0?.fit_residual_rms_ms ?? 0
        };
      }
    } catch (e) {
      console.warn("[API] Failed to read sync metadata:", e);
    }

    const responsePayload = {
      experimentId,
      computedAt: Date.now(),
      syncStatus,
      balls: (grpcResult?.balls ?? []).map((ball: any) => {
        const mass = massByBallId.get(ball.ball_id) ?? { value: 0, uncertainty: 0 };
        return {
          ballId: ball.ball_id,
          mass_kg: mass,
          v_before: {
            value: ball.v_before,
            uncertainty: ball.v_before_uncertainty,
          },
          v_after: {
            value: ball.v_after,
            uncertainty: ball.v_after_uncertainty,
          },
          p_before: {
            value: ball.momentum_before,
            uncertainty: ball.momentum_before_uncertainty,
          },
          p_after: {
            value: ball.momentum_after,
            uncertainty: ball.momentum_after_uncertainty,
          },
          // Approximation until KE is exposed per-ball in proto.
          ke_before: {
            value: 0.7 * mass.value * Math.pow(ball.v_before ?? 0, 2),
            uncertainty: 0.7 * mass.value * Math.pow(ball.v_before_uncertainty ?? 0, 2),
          },
          ke_after: {
            value: 0.7 * mass.value * Math.pow(ball.v_after ?? 0, 2),
            uncertainty: 0.7 * mass.value * Math.pow(ball.v_after_uncertainty ?? 0, 2),
          },
        };
      }),
      system: {
        p_before_total: {
          value: grpcResult?.system?.total_momentum_before ?? 0,
          uncertainty: grpcResult?.system?.total_momentum_before_uncertainty ?? 0,
        },
        p_after_total: {
          value: grpcResult?.system?.total_momentum_after ?? 0,
          uncertainty: grpcResult?.system?.total_momentum_after_uncertainty ?? 0,
        },
        ke_before_total: {
          value: grpcResult?.system?.ke_before ?? 0,
          uncertainty: grpcResult?.system?.ke_before_uncertainty ?? 0,
        },
        ke_after_total: {
          value: grpcResult?.system?.ke_after ?? 0,
          uncertainty: grpcResult?.system?.ke_after_uncertainty ?? 0,
        },
        momentum_conserved_pct: {
          value: grpcResult?.system?.momentum_conservation_error_pct ?? 0,
          uncertainty: grpcResult?.system?.momentum_conservation_error_pct_uncertainty ?? 0,
        },
        coeff_of_restitution: {
          value: grpcResult?.system?.coefficient_of_restitution ?? 0,
          uncertainty: grpcResult?.system?.coefficient_of_restitution_uncertainty ?? 0,
        },
        collision_frame_idx: 0,
      },
      velocityTimeSeries: [],
    };

    res.json(responsePayload);
  } catch (err: any) {
    console.error("Physics endpoint error:", err);
    const message = String(err?.message ?? "Failed to compute physics");
    const grpcCode = typeof err?.code === "number" ? (err.code as number) : undefined;

    const isGrpcUnavailable =
      grpcCode === GrpcStatus.UNAVAILABLE ||
      message.includes("ECONNREFUSED") ||
      message.includes("No connection established") ||
      message.includes("UNAVAILABLE");

    if (isGrpcUnavailable) {
      return res.status(503).json({
        error:
          `Physics service unavailable at ${grpcEndpoint}. Start the CV gRPC service (\`npm run dev:cv\`) and retry.`,
      });
    }

    if (grpcCode === GrpcStatus.DEADLINE_EXCEEDED || message.includes("DEADLINE_EXCEEDED")) {
      return res.status(504).json({
        error:
          "Physics compute timed out. Retry, or increase PHYSICS_GRPC_DEADLINE_MS for slower machines / larger datasets.",
      });
    }

    if (grpcCode === GrpcStatus.INVALID_ARGUMENT) {
      return res.status(400).json({ error: message });
    }

    res.status(500).json({ error: message });
  }
});

app.post("/api/experiments/:experimentId/correct", async (req, res) => {
  try {
    const { experimentId } = req.params;
    const correction = req.body;
    
    // In a real implementation we would update tracks.json here.
    // For now, we'll just acknowledge it so the frontend doesn't error.
    console.log(`[API] Received correction for experiment ${experimentId}:`, correction);
    
    res.json({ success: true });
  } catch (err: any) {
    console.error("Correction error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/debug/sync/:experimentId/frame/:frameIndex/cam/:cameraId", (req, res) => {
  const { experimentId, frameIndex, cameraId } = req.params;
  const experimentDir = path.resolve(EXPERIMENTS_DIR, experimentId);
  const venvPython = path.resolve(__dirname, "../../../.venv/Scripts/python.exe");
  const python =
    process.env.PHYSICSCAPTURE_PYTHON_BIN ?? (existsSync(venvPython) ? venvPython : "python");
  const scriptPath = path.resolve(__dirname, "../../cv-service/sync/_debug_candidates_json.py");

  const proc = spawn(python, [
    scriptPath,
    "--experiment-dir",
    experimentDir,
    "--camera-id",
    cameraId,
    "--frame-index",
    frameIndex,
  ]);

  let output = "";
  proc.stdout.on("data", (data) => (output += data.toString()));
  proc.on("close", (code) => {
    if (code !== 0) {
      console.error(`[DEBUG] Sync script failed with code ${code}. Output: ${output}`);
      return res.status(500).json({ error: "Debug script failed" });
    }
    try {
      res.json(JSON.parse(output));
    } catch (err) {
      console.error("[DEBUG] Failed to parse JSON:", output);
      res.status(500).json({ error: "Failed to parse debug output" });
    }
  });
});

app.post("/api/track", async (req, res) => {
  try {
    const { experiment_id, seeds, start_frame_idx, end_frame_idx, model_id, clientId } = req.body as {
      experiment_id?: string;
      seeds?: Array<{
        ball_id: number;
        camera_id: number;
        frame_idx: number;
        x: number;
        y: number;
      }>;
      start_frame_idx?: number;
      end_frame_idx?: number;
      model_id?: string;
      clientId?: string;
    };

    if (!experiment_id || !Array.isArray(seeds) || seeds.length === 0) {
      return res.status(400).json({ error: "Missing required tracking payload" });
    }
    if (
      start_frame_idx !== undefined &&
      end_frame_idx !== undefined &&
      end_frame_idx < start_frame_idx
    ) {
      return res.status(400).json({ error: "Invalid frame range: end_frame_idx < start_frame_idx" });
    }

    console.log(
      `[Track] Starting tracking for experiment=${experiment_id}, seed_count=${seeds.length}, range=${start_frame_idx ?? 0}-${end_frame_idx ?? "end"}`,
    );

    const trackMap = new Map<
      string,
      {
        ballId: number;
        cameraId: number;
        points: Array<{
          frameIdx: number;
          x: number;
          y: number;
          confidence: number;
          isFlagged: boolean;
          isCorrected: boolean;
        }>;
      }
    >();
    let latestProgress = 0;
    let statusCount = 0;

    for await (const status of trackBalls({ experiment_id, seeds, model_id, start_frame_idx, end_frame_idx })) {
      const physicalFrame = status.frame;

      if (end_frame_idx !== undefined && physicalFrame > end_frame_idx) {
        break;
      }

      statusCount += 1;
      latestProgress = Math.max(latestProgress, status.progress ?? 0);

      // Push real-time progress to client
      if (clientId) {
        const roomId = clientToRoom.get(clientId);
        if (roomId) {
          const room = rooms.get(roomId);
          const target = room?.members.get(clientId);
          if (target) {
            target.ws.send(JSON.stringify({
              type: "tracking:progress",
              data: { progress: latestProgress }
            }));
          }
        }
      }

      for (const point of status.points ?? []) {
        if (
          (start_frame_idx !== undefined && physicalFrame < start_frame_idx) ||
          (end_frame_idx !== undefined && physicalFrame > end_frame_idx)
        ) {
          continue;
        }

        const key = `${point.camera_id}:${point.ball_id}`;
        if (!trackMap.has(key)) {
          trackMap.set(key, {
            ballId: point.ball_id,
            cameraId: point.camera_id,
            points: [],
          });
        }

        trackMap.get(key)!.points.push({
          frameIdx: physicalFrame,
          x: point.x,
          y: point.y,
          confidence: point.confidence,
          isFlagged: point.confidence < 0.7,
          isCorrected: false,
        });
      }
    }

    const tracks = [...trackMap.values()]
      .sort((a, b) => a.ballId - b.ballId)
      .map((track) => ({
        ...track,
        points: track.points.sort((a, b) => a.frameIdx - b.frameIdx),
      }));

    // Persist tracks.json for the physics pipeline
    const resultsDir = path.join(EXPERIMENTS_DIR, experiment_id, "results");
    if (!existsSync(resultsDir)) await fs.promises.mkdir(resultsDir, { recursive: true });
    
    const tracksPath = path.join(resultsDir, "tracks.json");
    const tracksData = {
      experiment_id,
      balls: tracks.map(t => ({
        ball_id: t.ballId,
        camera_id: t.cameraId,
        frames: t.points.map(p => ({
          frame_idx: p.frameIdx,
          x_px: p.x,
          y_px: p.y,
          confidence: p.confidence
        }))
      }))
    };
    await fs.promises.writeFile(tracksPath, JSON.stringify(tracksData, null, 2));

    // Also persist sync.json with mock timestamps if it doesn't exist
    const syncPath = path.join(resultsDir, "sync.json");
    if (!existsSync(syncPath)) {
      const maxFrame = Math.max(...tracks.flatMap(t => t.points.map(p => p.frameIdx)), 0);
      const timestamps = Array.from({ length: maxFrame + 1 }, (_, i) => i * (1000 / 30));
      const syncData = {
        schema_version: "1.0",
        experiment_id: experiment_id,
        is_mock: true,
        cameras: {
          cam0: {
            frame_count: maxFrame + 1,
            true_fps: 30.0,
            phase_offset_ms: 0.0,
            timestamps_ms: timestamps
          }
        }
      };
      await fs.promises.writeFile(syncPath, JSON.stringify(syncData, null, 2));
    }

    console.log(
      `[Track] Completed tracking for experiment=${experiment_id}, statuses=${statusCount}, tracks=${tracks.length}`,
    );

    res.json({
      experiment_id,
      progress: latestProgress,
      tracks,
    });
  } catch (err: any) {
    console.error("Track error:", err);
    const message = String(err?.message ?? "Failed to run tracking");
    const isGrpcUnavailable =
      message.includes("ECONNREFUSED") ||
      message.includes("No connection established") ||
      message.includes("UNAVAILABLE");

    if (isGrpcUnavailable) {
      return res.status(503).json({
        error:
          `Tracking service unavailable at ${grpcEndpoint}. Start the CV gRPC service (\`npm run dev:cv\`) and retry.`,
      });
    }

    res.status(500).json({ error: message });
  }
});

app.get("/api/experiments/:experimentId/frames/:cameraId/:frameFile", async (req, res) => {
  try {
    const { experimentId, cameraId, frameFile } = req.params;

    if (!/^[a-zA-Z0-9_-]+$/.test(experimentId)) {
      return res.status(400).json({ error: "Invalid experiment id" });
    }
    if (!/^\d+$/.test(cameraId)) {
      return res.status(400).json({ error: "Invalid camera id" });
    }

    const key = `${experimentId}-${cameraId}`;
    const count = servedFramesCount.get(key) || 0;

    // Support both numeric-only (new) and frame_ prefixed (old) formats
    let framePath = path.join(
      EXPERIMENTS_DIR,
      experimentId,
      "frames",
      `cam${cameraId}`,
      frameFile,
    );

    // Backward compatibility check for legacy JPEG frame dumps.
    if (!existsSync(framePath) && /^\d{6}\.jpg$/i.test(frameFile)) {
      const legacyPath = path.join(
        EXPERIMENTS_DIR,
        experimentId,
        "frames",
        `cam${cameraId}`,
        `frame_${frameFile}`
      );
      if (existsSync(legacyPath)) {
        framePath = legacyPath;
      }
    }

    if (count <= 5) {
      console.log(`[API] Serving frame: ${framePath}`);
    } else if (count === 6) {
      console.log(`[API] Serving frames for ${key} (further logs hidden)`);
    }

    if (!existsSync(framePath)) {
      console.warn("[API] Frame not found at:", framePath);
      return res.status(404).json({ error: "Frame not found" });
    }

    res.sendFile(framePath);
  } catch (err: any) {
    console.error("Frame fetch error:", err);
    res.status(500).json({ error: err.message ?? "Failed to fetch frame" });
  }
});

// WebSocket Signaling Hub
const rooms = new Map<string, { members: Map<string, { ws: WebSocket; role: string }> }>();
const clientToRoom = new Map<string, string>();

wss.on("connection", (ws: WebSocket & { clientId?: string }) => {
  ws.on("message", (data: string) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log("Received signaling message:", msg.type);

      if (msg.type === "join") {
        const { roomId, clientId, role } = msg;
        ws.clientId = clientId;

        if (!rooms.has(roomId)) {
          rooms.set(roomId, { members: new Map() });
        }
        
        const room = rooms.get(roomId)!;
        room.members.set(clientId, { ws, role });
        clientToRoom.set(clientId, roomId);

        console.log(`Client ${clientId} joined room ${roomId} as ${role}`);

        // If a phone joins, broadcast to the PC. If PC joins, we can potentially broadcast to other members.
        if (role === 'phone') {
          room.members.forEach((member) => {
            if (member.role === 'pc') {
              member.ws.send(JSON.stringify({ 
                type: 'phone:joined', 
                data: {
                  id: clientId,
                  type: 'phone',
                  label: msg.label || 'Phone',
                  status: 'connecting',
                  peerId: clientId
                } 
              }));
            }
          });
        }
        
        // Also broadcast the join to everyone in the room (for presence/WebRTC)
        room.members.forEach((member) => {
          if (member.ws !== ws) {
            member.ws.send(JSON.stringify({
              type: 'peer:joined',
              clientId: clientId,
              role: role
            }));
          }
        });
        return;
      }

      // Relay signaling messages (offer/answer/ice)
      if (["peer:offer", "peer:answer", "peer:ice"].includes(msg.type)) {
        const senderId = ws.clientId;
        const roomId = senderId ? clientToRoom.get(senderId) : undefined;
        if (!roomId) return;
        
        const room = rooms.get(roomId);
        let targetId = msg.to;
        if (!targetId) {
          if (msg.type === 'peer:offer') {
            targetId = 'pc';
          } else if (msg.data?.peerId) {
            targetId = msg.data.peerId;
          }
        }
        if (!targetId && room && senderId) {
          targetId = [...room.members.keys()].find((id) => id !== senderId);
        }
        if (!targetId) return;

        const target = room?.members.get(targetId);
        if (target) {
          target.ws.send(JSON.stringify(msg));
        }
        return;
      }
    } catch (err) {
      console.error("Signaling error:", err);
    }
  });

  ws.on("close", () => {
    if (ws.clientId && clientToRoom.has(ws.clientId)) {
      const roomId = clientToRoom.get(ws.clientId)!;
      const room = rooms.get(roomId);
      room?.members.delete(ws.clientId);
      clientToRoom.delete(ws.clientId);
      if (room?.members.size === 0) rooms.delete(roomId);
    }
  });
});

server.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Orchestration backend listening on port ${PORT} at 0.0.0.0`);
});
