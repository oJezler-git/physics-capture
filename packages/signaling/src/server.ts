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
import { runCalibration, trackBalls, computePhysics } from "./grpc-client.js";
import { buildTrajectoryByBall } from "./lib/reconstruction.js";
import { buildReconstructionDiagnostics } from "./lib/reconstructionDiagnostics.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXPERIMENTS_DIR = path.resolve(__dirname, "../../experiments");
const PROFILES_FILE = path.join(EXPERIMENTS_DIR, "calibration_profiles.json");

// WebSocket Signaling Hub State
const rooms = new Map<
  string,
  { members: Map<string, { ws: WebSocket; role: string }> }
>();
const clientToRoom = new Map<string, string>();
const servedFramesCount = new Map<string, number>();

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

const resolveExperimentDir = (experimentId: string): string | null => {
  if (!/^[a-zA-Z0-9_-]+$/.test(experimentId)) {
    return null;
  }
  const experimentDir = path.resolve(EXPERIMENTS_DIR, experimentId);
  const relative = path.relative(EXPERIMENTS_DIR, experimentDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return experimentDir;
};

async function runSyncMarkerDecode(experimentId: string): Promise<void> {
  const venvPython = path.resolve(
    __dirname,
    "../../../.venv/Scripts/python.exe",
  );
  const displayHz = process.env.SYNC_MARKER_DISPLAY_HZ ?? "60";
  const sampleStride = process.env.SYNC_MARKER_SAMPLE_STRIDE ?? "5";

  const experimentDir = path.join(EXPERIMENTS_DIR, experimentId);
  const framesRoot = path.join(experimentDir, "frames");
  if (!existsSync(framesRoot)) return;

  const entries = await fs.promises.readdir(framesRoot, {
    withFileTypes: true,
  });
  const cameraIds = entries
    .filter((entry) => entry.isDirectory() && /^cam\d+$/.test(entry.name))
    .map((entry) => Number(entry.name.replace("cam", "")))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (cameraIds.length === 0) return;

  const scriptPath = path.resolve(
    __dirname,
    "../../cv-service/sync/sync_marker_cli.py",
  );

  const cliArgs = [
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
  ];
  const configuredPython = process.env.PHYSICSCAPTURE_PYTHON_BIN?.trim();
  const pythonCandidates: { command: string; argsPrefix: string[] }[] = [];
  if (configuredPython) {
    pythonCandidates.push({ command: configuredPython, argsPrefix: [] });
  } else {
    if (existsSync(venvPython)) {
      pythonCandidates.push({ command: venvPython, argsPrefix: [] });
    }
    pythonCandidates.push({ command: "python", argsPrefix: [] });
    pythonCandidates.push({ command: "py", argsPrefix: ["-3"] });
  }

  let lastError: Error | null = null;
  for (const candidate of pythonCandidates) {
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stderr: string;
      spawnError?: NodeJS.ErrnoException;
    }>((resolve) => {
      const proc = spawn(
        candidate.command,
        [...candidate.argsPrefix, ...cliArgs],
        {
          stdio: ["ignore", "inherit", "pipe"],
        },
      );

      let stderr = "";
      proc.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderr += text;
        process.stderr.write(text);
      });
      proc.on("error", (err) => {
        resolve({ code: null, signal: null, stderr, spawnError: err });
      });
      proc.on("close", (code, signal) => {
        resolve({ code, signal, stderr });
      });
    });

    if (result.code === 0) return;

    const isBrokenInterpreter =
      /unable to create process/i.test(result.stderr) ||
      result.spawnError?.code === "ENOENT" ||
      result.spawnError?.code === "EACCES";
    if (isBrokenInterpreter) {
      lastError =
        result.spawnError ??
        new Error(
          `sync marker decode failed to start with interpreter "${candidate.command}"`,
        );
      continue;
    }

    throw new Error(
      `sync marker decode exited with code ${result.code ?? "null"}${result.signal ? ` (signal ${result.signal})` : ""}`,
    );
  }

  throw (
    lastError ??
    new Error(
      "sync marker decode could not be started with any Python interpreter",
    )
  );
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
  const frameMatch = req.url.match(
    /\/api\/experiments\/([^\/]+)\/frames\/([^\/]+)\//,
  );
  if (frameMatch) {
    const key = `${frameMatch[1]}-${frameMatch[2]}`;
    const count = (servedFramesCount.get(key) || 0) + 1;
    servedFramesCount.set(key, count);

    if (count <= 5) {
      console.log(`[REQ] ${req.method} ${req.url}`);
    } else if (count === 6) {
      console.log(
        `[REQ] ${req.method} ${req.url} (further logs for this camera hidden)`,
      );
    }
  } else {
    console.log(`[REQ] ${req.method} ${req.url}`);
  }
  next();
});

app.get("/api/experiments", async (req, res) => {
  try {
    console.log("[API] Listing experiments from:", EXPERIMENTS_DIR);
    const entries = await fs.promises.readdir(EXPERIMENTS_DIR, {
      withFileTypes: true,
    });
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
    .sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
    );

  // Extract physical indices from filenames like 000001.png
  const sequenceToPhysical = frames.map((filename) => {
    const match = filename.match(/(\d+)/);
    return match ? parseInt(match[0], 10) - 1 : 0;
  });

  const maxPhysicalIndex =
    sequenceToPhysical.length > 0 ? Math.max(...sequenceToPhysical) : 0;
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

app.get(
  "/api/experiments/:experimentId/calibration-debug/:cameraId",
  async (req, res) => {
    try {
      const { experimentId, cameraId } = req.params;
      if (!/^[a-zA-Z0-9_-]+$/.test(experimentId)) {
        return res.status(400).json({ error: "Invalid experiment id" });
      }
      if (!/^(cam\d+|stereo)$/.test(cameraId)) {
        return res.status(400).json({ error: "Invalid debug channel" });
      }

      const debugDir = path.join(
        EXPERIMENTS_DIR,
        experimentId,
        "calibration",
        "debug",
        cameraId,
      );
      if (!existsSync(debugDir)) {
        return res.json({ files: [] });
      }

      const files = (await fs.promises.readdir(debugDir))
        .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
        .sort((a, b) =>
          a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
        );
      res.json({ files });
    } catch (err: any) {
      console.error("Calibration debug list error:", err);
      res.status(500).json({
        error: err.message ?? "Failed to list calibration debug images",
      });
    }
  },
);

app.get(
  "/api/experiments/:experimentId/calibration-debug/:cameraId/:fileName",
  async (req, res) => {
    try {
      const { experimentId, cameraId, fileName } = req.params;
      if (!/^[a-zA-Z0-9_-]+$/.test(experimentId)) {
        return res.status(400).json({ error: "Invalid experiment id" });
      }
      if (!/^(cam\d+|stereo)$/.test(cameraId)) {
        return res.status(400).json({ error: "Invalid debug channel" });
      }
      if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) {
        return res.status(400).json({ error: "Invalid file name" });
      }

      const filePath = path.resolve(
        EXPERIMENTS_DIR,
        experimentId,
        "calibration",
        "debug",
        cameraId,
        fileName,
      );
      const relative = path.relative(
        path.resolve(
          EXPERIMENTS_DIR,
          experimentId,
          "calibration",
          "debug",
          cameraId,
        ),
        filePath,
      );
      if (
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        !existsSync(filePath)
      ) {
        return res.status(404).json({ error: "Debug image not found" });
      }
      res.sendFile(filePath);
    } catch (err: any) {
      console.error("Calibration debug image error:", err);
      res.status(500).json({
        error: err.message ?? "Failed to fetch calibration debug image",
      });
    }
  },
);

app.get("/api/network/host-hint", async (req, res) => {
  try {
    const candidates = getPrivateIPv4Candidates();
    const outboundHost = await detectOutboundIPv4();
    const preferredHost =
      outboundHost && isPrivateIPv4(outboundHost)
        ? outboundHost
        : (candidates[0]?.address ?? null);

    res.json({
      preferredHost,
      outboundHost,
      candidates: candidates.map(({ interfaceName, address }) => ({
        interfaceName,
        address,
      })),
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
    await fs.promises.writeFile(
      PROFILES_FILE,
      JSON.stringify(profiles, null, 2),
    );
    res.status(201).json({ message: "Profile saved" });
  } catch (err) {
    console.error("Profile save error:", err);
    res.status(500).json({ error: "Failed to save profile" });
  }
});

app.post("/api/calibrate", async (req, res) => {
  try {
    const { experimentId, manualScale, clientId, cameraIds } = req.body;
    if (typeof experimentId !== "string") {
      return res.status(400).json({ error: "Missing experimentId" });
    }
    const experimentDir = resolveExperimentDir(experimentId);
    if (!experimentDir) {
      return res.status(400).json({ error: "Invalid experimentId" });
    }

    const calibDir = path.join(experimentDir, "calibration");
    if (!existsSync(calibDir))
      await fs.promises.mkdir(calibDir, { recursive: true });

    // ── Ruler / manual scale path ─────────────────────────────────────────────
    if (typeof manualScale === "number" && manualScale > 0) {
      console.log(
        `[API] Applying manual scale for ${experimentId}: ${manualScale.toFixed(4)} px/mm`,
      );
      const calibPath = path.join(calibDir, "cam0_intrinsics.json");

      // Preserve any existing intrinsic data, just update the scale fields.
      let existing: Record<string, unknown> = {};
      if (existsSync(calibPath)) {
        try {
          existing = JSON.parse(await fs.promises.readFile(calibPath, "utf-8"));
        } catch {}
      }
      const calibData = {
        ...existing,
        scale_px_per_mm: manualScale,
        scale_uncertainty_px_per_mm: 0.005,
      };
      await fs.promises.writeFile(
        calibPath,
        JSON.stringify(calibData, null, 2),
      );

      return res.json({
        experimentId,
        intrinsics: [calibData],
        stereo: null,
        rulerScaleFactor: manualScale,
        completedAt: Date.now(),
      });
    }

    // ── gRPC calibration path ────────────────────────────────────────────
    // Resolve the WebSocket target for live progress pushes.
    const wsTarget = (() => {
      if (!clientId) return null;
      const roomId = clientToRoom.get(clientId);
      if (!roomId) return null;
      return rooms.get(roomId)?.members.get(clientId) ?? null;
    })();

    const pushProgress = (payload: object) => {
      if (wsTarget) {
        try {
          wsTarget.ws.send(
            JSON.stringify({ type: "calibration:progress", data: payload }),
          );
        } catch {
          /* ws closed — ignore */
        }
      }
    };

    // Detect which cameras have extracted frames in this experiment.
    const framesRoot = path.join(experimentDir, "frames");
    let detectedCameraIds: number[] = [];
    if (existsSync(framesRoot)) {
      const entries = await fs.promises.readdir(framesRoot, {
        withFileTypes: true,
      });
      detectedCameraIds = entries
        .filter((e) => e.isDirectory() && /^cam\d+$/.test(e.name))
        .map((e) => Number(e.name.replace("cam", "")))
        .sort((a, b) => a - b);
    }
    // Allow caller to override detected cameras (e.g. force single-camera mode).
    const requestedCameraIds = Array.isArray(cameraIds)
      ? cameraIds.map(Number).filter((id) => Number.isInteger(id) && id >= 0)
      : [];
    const useCameraIds: number[] =
      requestedCameraIds.length > 0
        ? requestedCameraIds
        : detectedCameraIds.length > 0
          ? detectedCameraIds
          : [0];

    console.log(
      `[API] Running calibration for ${experimentId}, cameras=${useCameraIds}`,
    );

    const calibrationStream = runCalibration({
      experiment_id: experimentId,
      camera_ids: useCameraIds,
    });

    let finalStatus: any = null;
    for await (const status of calibrationStream) {
      console.log(
        "[Calibration]",
        status.stage,
        status.progress?.toFixed(2),
        status.message,
      );
      pushProgress({
        stage: status.stage,
        progress: status.progress,
        reprojection_error_px: status.reprojection_error_px,
        message: status.message,
        camera_id: status.camera_id,
      });
      finalStatus = status;
    }

    // Check if calibration succeeded.
    if (!finalStatus || finalStatus.stage === "FAILED") {
      const msg =
        finalStatus?.message ?? "Calibration failed (no status received).";
      pushProgress({ stage: "FAILED", progress: 0, message: msg });
      return res.status(422).json({ error: msg });
    }

    // Read back the intrinsics the Python service wrote to disk.
    const intrinsicsResults: object[] = [];
    for (const camId of useCameraIds) {
      const p = path.join(calibDir, `cam${camId}_intrinsics.json`);
      if (existsSync(p)) {
        try {
          intrinsicsResults.push(
            JSON.parse(await fs.promises.readFile(p, "utf-8")),
          );
        } catch {}
      }
    }

    const stereoPath = path.join(calibDir, "stereo_extrinsics.json");
    let stereoData: object | null = null;
    if (existsSync(stereoPath)) {
      try {
        stereoData = JSON.parse(
          await fs.promises.readFile(stereoPath, "utf-8"),
        );
      } catch {}
    }

    return res.json({
      experimentId,
      intrinsics: intrinsicsResults,
      stereo: stereoData,
      rulerScaleFactor: null,
      reprojection_error_px: finalStatus.reprojection_error_px ?? 0,
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
    const outputFormat =
      process.env.FRAME_EXTRACT_FORMAT === "png" ? "png" : "jpg";

    await fs.promises.mkdir(rawDir, { recursive: true });

    const destPath = path.join(
      rawDir,
      `cam${camera_id}${path.extname(file.originalname)}`,
    );
    await fs.promises.rename(file.path, destPath);

    // Extraction
    const frameCount = await extractFrames(destPath, framesDir, outputFormat);

    res.json({
      experiment_id,
      camera_id,
      stored_path: destPath,
      frame_count: frameCount,
    });
  } catch (err: any) {
    console.error("Upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/experiments/:experimentId/physics", async (req, res) => {
  try {
    const { experimentId } = req.params;
    const massConfigs = Array.isArray(req.body?.massConfigs)
      ? req.body.massConfigs
      : [];

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
          Number.isFinite(cfg?.uncertainty_g),
      )
      .map((cfg: any) => ({
        ball_id: Number(cfg.ballId),
        mass_kg: Number(cfg.mass_g) / 1000,
        mass_uncertainty_kg: Number(cfg.uncertainty_g) / 1000,
      }));

    if (ball_configs.length === 0) {
      return res.status(400).json({ error: "No valid mass configs provided" });
    }

    const experimentDir = resolveExperimentDir(experimentId);
    if (!experimentDir) {
      return res.status(400).json({ error: "Invalid experiment id" });
    }
    const stereoPath = path.join(
      experimentDir,
      "calibration",
      "stereo_extrinsics.json",
    );
    const resultsDir = path.join(experimentDir, "results");
    const syncPath = path.join(resultsDir, "sync.json");
    const tracksPath = path.join(resultsDir, "tracks.json");
    const wantsStereo = req.body?.mode === "STEREO_3D";
    const mode =
      wantsStereo && existsSync(stereoPath)
        ? "STEREO_3D"
        : "SINGLE_CAMERA_PLANAR";

    if (mode === "STEREO_3D" && !existsSync(syncPath)) {
      try {
        await runSyncMarkerDecode(experimentId);
      } catch (err) {
        console.warn("[sync] On-demand Sync Marker decode failed:", err);
      }
    }

    if (!existsSync(syncPath)) {
      try {
        const cam0Dir = path.join(experimentDir, "frames", "cam0");
        const frameFiles = existsSync(cam0Dir)
          ? (await fs.promises.readdir(cam0Dir)).filter((f) =>
              /\.(jpg|jpeg|png)$/i.test(f),
            )
          : [];
        const frameCount = Math.max(1, frameFiles.length);
        const timestamps = Array.from(
          { length: frameCount },
          (_, i) => i * (1000 / 30),
        );
        const mockSync = {
          schema_version: "1.0",
          experiment_id: experimentId,
          is_mock: true,
          cameras: {
            cam0: {
              frame_count: frameCount,
              true_fps: 30.0,
              phase_offset_ms: 0.0,
              fit_residual_rms_ms: 0.0,
              timestamps_ms: timestamps,
            },
          },
        };
        await fs.promises.mkdir(resultsDir, { recursive: true });
        await fs.promises.writeFile(
          syncPath,
          JSON.stringify(mockSync, null, 2),
        );
      } catch (err) {
        console.warn("[sync] Failed to create fallback sync.json:", err);
      }
    }

    if (!existsSync(tracksPath)) {
      return res.status(400).json({
        error:
          "Tracks file not found. In blind-pipeline mode, run tracking first (Debug -> SAM2 -> Run Track) before Physics.",
      });
    }

    const grpcResult = await computePhysics({
      experiment_id: experimentId,
      ball_configs,
      mode,
    });

    const massByBallId = new Map<
      number,
      { value: number; uncertainty: number }
    >();
    for (const cfg of ball_configs) {
      massByBallId.set(cfg.ball_id, {
        value: cfg.mass_kg,
        uncertainty: cfg.mass_uncertainty_kg,
      });
    }

    // Read sync metadata to communicate accuracy to the frontend
    let syncStatus = { isMock: true, trueFps: 30, rmsMs: 0 };
    try {
      if (existsSync(syncPath)) {
        const syncData = JSON.parse(
          await fs.promises.readFile(syncPath, "utf-8"),
        );
        syncStatus = {
          isMock: !!syncData.is_mock,
          trueFps: syncData.cameras?.cam0?.true_fps ?? 30,
          rmsMs: syncData.cameras?.cam0?.fit_residual_rms_ms ?? 0,
        };
      }
    } catch (e) {
      console.warn("[API] Failed to read sync metadata:", e);
    }

    let trajectoryByBall = new Map<number, any[]>();
    for (const ball of grpcResult?.balls ?? []) {
      const points = Array.isArray(ball?.trajectory_3d)
        ? ball.trajectory_3d.map((point: any) => ({
            frameIdx: Number(point?.frame_idx ?? 0),
            x: Number(point?.x ?? 0),
            y: Number(point?.y ?? 0),
            z: Number(point?.z ?? 0),
            x_unc: Number(point?.x_unc ?? 0),
            y_unc: Number(point?.y_unc ?? 0),
            z_unc: Number(point?.z_unc ?? 0),
            flagged: Boolean(point?.flagged),
          }))
        : [];
      if (points.length > 0) {
        points.sort((left, right) => left.frameIdx - right.frameIdx);
        trajectoryByBall.set(Number(ball.ball_id), points);
      }
    }

    try {
      const positionsPath = path.join(
        EXPERIMENTS_DIR,
        experimentId,
        "results",
        "positions_3d.json",
      );
      if (trajectoryByBall.size === 0 && existsSync(positionsPath)) {
        const positionsData = JSON.parse(
          await fs.promises.readFile(positionsPath, "utf-8"),
        );
        trajectoryByBall = buildTrajectoryByBall(positionsData);
      }
    } catch (e) {
      console.warn("[API] Failed to read positions_3d.json:", e);
    }

    let stereoExtrinsics: any = null;
    try {
      if (existsSync(stereoPath)) {
        stereoExtrinsics = JSON.parse(
          await fs.promises.readFile(stereoPath, "utf-8"),
        );
      }
    } catch (e) {
      console.warn("[API] Failed to read stereo_extrinsics.json:", e);
    }

    let tracksData: any = null;
    try {
      if (existsSync(tracksPath)) {
        tracksData = JSON.parse(
          await fs.promises.readFile(tracksPath, "utf-8"),
        );
      }
    } catch (e) {
      console.warn("[API] Failed to read tracks.json:", e);
    }

    let intrinsicsData: any[] = [];
    try {
      const calibDir = path.join(EXPERIMENTS_DIR, experimentId, "calibration");
      for (const cameraId of [0, 1]) {
        const intrinsicsPath = path.join(
          calibDir,
          `cam${cameraId}_intrinsics.json`,
        );
        if (!existsSync(intrinsicsPath)) continue;
        intrinsicsData.push(
          JSON.parse(await fs.promises.readFile(intrinsicsPath, "utf-8")),
        );
      }
    } catch (e) {
      console.warn(
        "[API] Failed to read camera intrinsics for diagnostics:",
        e,
      );
    }

    let positions3dData: any = null;
    try {
      const positionsPath = path.join(
        EXPERIMENTS_DIR,
        experimentId,
        "results",
        "positions_3d.json",
      );
      if (existsSync(positionsPath)) {
        positions3dData = JSON.parse(
          await fs.promises.readFile(positionsPath, "utf-8"),
        );
      }
    } catch (e) {
      console.warn(
        "[API] Failed to read positions_3d.json for diagnostics:",
        e,
      );
    }

    let positions3dGtData: any = null;
    try {
      const positionsGtPath = path.join(
        EXPERIMENTS_DIR,
        experimentId,
        "results",
        "positions_3d_gt.json",
      );
      if (existsSync(positionsGtPath)) {
        positions3dGtData = JSON.parse(
          await fs.promises.readFile(positionsGtPath, "utf-8"),
        );
      }
    } catch (e) {
      console.warn("[API] Failed to read positions_3d_gt.json:", e);
    }

    const reconstructionDiagnostics = buildReconstructionDiagnostics({
      mode,
      stereoExtrinsics,
      syncStatus,
      tracksData,
      positions3d: positions3dData,
      positions3dGt: positions3dGtData,
      intrinsics: intrinsicsData,
    });

    const responsePayload = {
      experimentId,
      computedAt: Date.now(),
      syncStatus,
      balls: (grpcResult?.balls ?? []).map((ball: any) => {
        const mass = massByBallId.get(ball.ball_id) ?? {
          value: 0,
          uncertainty: 0,
        };
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
            uncertainty:
              0.7 * mass.value * Math.pow(ball.v_before_uncertainty ?? 0, 2),
          },
          ke_after: {
            value: 0.7 * mass.value * Math.pow(ball.v_after ?? 0, 2),
            uncertainty:
              0.7 * mass.value * Math.pow(ball.v_after_uncertainty ?? 0, 2),
          },
          trajectory3d: trajectoryByBall.get(ball.ball_id) ?? [],
        };
      }),
      system: {
        p_before_total: {
          value: grpcResult?.system?.total_momentum_before ?? 0,
          uncertainty:
            grpcResult?.system?.total_momentum_before_uncertainty ?? 0,
        },
        p_after_total: {
          value: grpcResult?.system?.total_momentum_after ?? 0,
          uncertainty:
            grpcResult?.system?.total_momentum_after_uncertainty ?? 0,
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
          uncertainty:
            grpcResult?.system?.momentum_conservation_error_pct_uncertainty ??
            0,
        },
        coeff_of_restitution: {
          value: grpcResult?.system?.coefficient_of_restitution ?? 0,
          uncertainty:
            grpcResult?.system?.coefficient_of_restitution_uncertainty ?? 0,
        },
        collision_frame_idx: grpcResult?.system?.collision_frame_idx ?? -1,
      },
      velocityTimeSeries: [],
      reconstruction3d: {
        mode,
        stereoExtrinsics,
      },
      reconstructionDiagnostics,
    };

    res.json(responsePayload);
  } catch (err: unknown) {
    console.error("Physics endpoint error:", err);
    const message =
      err instanceof Error ? err.message : "Failed to compute physics";
    const grpcCode =
      err &&
      typeof err === "object" &&
      "code" in err &&
      typeof err.code === "number"
        ? (err.code as number)
        : undefined;

    const isGrpcUnavailable =
      grpcCode === GrpcStatus.UNAVAILABLE ||
      message.includes("ECONNREFUSED") ||
      message.includes("No connection established") ||
      message.includes("UNAVAILABLE");

    if (isGrpcUnavailable) {
      return res.status(503).json({
        error: `Physics service unavailable at ${grpcEndpoint}. Start the CV gRPC service (\`npm run dev:cv\`) and retry.`,
      });
    }

    if (
      grpcCode === GrpcStatus.DEADLINE_EXCEEDED ||
      message.includes("DEADLINE_EXCEEDED")
    ) {
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
    console.log(
      `[API] Received correction for experiment ${experimentId}:`,
      correction,
    );

    res.json({ success: true });
  } catch (err: any) {
    console.error("Correction error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get(
  "/api/debug/sync/:experimentId/frame/:frameIndex/cam/:cameraId",
  (req, res) => {
    const { experimentId, frameIndex, cameraId } = req.params;
    const experimentDir = path.resolve(EXPERIMENTS_DIR, experimentId);
    const venvPython = path.resolve(
      __dirname,
      "../../../.venv/Scripts/python.exe",
    );
    const python =
      process.env.PHYSICSCAPTURE_PYTHON_BIN ??
      (existsSync(venvPython) ? venvPython : "python");
    const scriptPath = path.resolve(
      __dirname,
      "../../cv-service/sync/_debug_candidates_json.py",
    );

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
        console.error(
          `[DEBUG] Sync script failed with code ${code}. Output: ${output}`,
        );
        return res.status(500).json({ error: "Debug script failed" });
      }
      try {
        res.json(JSON.parse(output));
      } catch (err) {
        console.error("[DEBUG] Failed to parse JSON:", output);
        res.status(500).json({ error: "Failed to parse debug output" });
      }
    });
  },
);

app.post("/api/track", async (req, res) => {
  try {
    const {
      experiment_id,
      seeds,
      start_frame_idx,
      end_frame_idx,
      model_id,
      clientId,
    } = req.body as {
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
      return res
        .status(400)
        .json({ error: "Missing required tracking payload" });
    }
    if (
      start_frame_idx !== undefined &&
      end_frame_idx !== undefined &&
      end_frame_idx < start_frame_idx
    ) {
      return res.status(400).json({
        error: "Invalid frame range: end_frame_idx < start_frame_idx",
      });
    }

    console.log(
      `[Track] Starting tracking for experiment=${experiment_id}, seed_count=${seeds.length}, range=${start_frame_idx ?? 0}-${end_frame_idx ?? "end"}`,
    );

    // SAM2's JPG loader expects numeric stems (e.g. 000001.jpg).
    // Normalize legacy blender names (frame_000001.jpg) in-place.
    const normalizeFrameNames = async (cameraId: number) => {
      const framesDir = path.join(
        EXPERIMENTS_DIR,
        experiment_id,
        "frames",
        `cam${cameraId}`,
      );
      if (!existsSync(framesDir)) return;
      const files = await fs.promises.readdir(framesDir);
      for (const file of files) {
        const match = file.match(/^frame_(\d+)\.(jpg|jpeg|png)$/i);
        if (!match) continue;
        const nextName = `${match[1]}.${match[2].toLowerCase()}`;
        const src = path.join(framesDir, file);
        const dst = path.join(framesDir, nextName);
        if (existsSync(dst)) continue;
        await fs.promises.rename(src, dst);
      }
    };
    await normalizeFrameNames(0);
    await normalizeFrameNames(1);

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

    for await (const status of trackBalls({
      experiment_id,
      seeds,
      model_id,
      start_frame_idx,
      end_frame_idx,
    })) {
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
            target.ws.send(
              JSON.stringify({
                type: "tracking:progress",
                data: { progress: latestProgress },
              }),
            );
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
      .sort((a, b) => a.cameraId - b.cameraId || a.ballId - b.ballId)
      .map((track) => ({
        ...track,
        points: track.points.sort((a, b) => a.frameIdx - b.frameIdx),
      }));

    // Persist tracks.json for the physics pipeline
    const resultsDir = path.join(EXPERIMENTS_DIR, experiment_id, "results");
    if (!existsSync(resultsDir))
      await fs.promises.mkdir(resultsDir, { recursive: true });

    const tracksPath = path.join(resultsDir, "tracks.json");
    const tracksData = {
      experiment_id,
      balls: tracks.map((t) => ({
        ball_id: t.ballId,
        camera_id: t.cameraId,
        frames: t.points.map((p) => ({
          frame_idx: p.frameIdx,
          x_px: p.x,
          y_px: p.y,
          confidence: p.confidence,
        })),
      })),
    };
    await fs.promises.writeFile(
      tracksPath,
      JSON.stringify(tracksData, null, 2),
    );

    // Also persist sync.json with mock timestamps if it doesn't exist
    const syncPath = path.join(resultsDir, "sync.json");
    if (!existsSync(syncPath)) {
      const maxFrame = Math.max(
        ...tracks.flatMap((t) => t.points.map((p) => p.frameIdx)),
        0,
      );
      const timestamps = Array.from(
        { length: maxFrame + 1 },
        (_, i) => i * (1000 / 30),
      );
      const trackedCameraIds = [
        ...new Set(tracks.map((track) => track.cameraId)),
      ].sort((a, b) => a - b);
      const syncCameras = trackedCameraIds.length > 0 ? trackedCameraIds : [0];
      const syncData = {
        schema_version: "1.0",
        experiment_id: experiment_id,
        is_mock: true,
        cameras: Object.fromEntries(
          syncCameras.map((cameraId) => [
            `cam${cameraId}`,
            {
              frame_count: maxFrame + 1,
              true_fps: 30.0,
              phase_offset_ms: 0.0,
              timestamps_ms: timestamps,
            },
          ]),
        ),
      };
      await fs.promises.writeFile(syncPath, JSON.stringify(syncData, null, 2));
    }

    const tracksByCamera = tracks.reduce<Record<string, number>>(
      (acc, track) => {
        const key = `cam${track.cameraId}`;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      },
      {},
    );
    console.log(
      `[Track] Completed tracking for experiment=${experiment_id}, statuses=${statusCount}, tracks=${tracks.length}, cameras=${JSON.stringify(tracksByCamera)}`,
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
        error: `Tracking service unavailable at ${grpcEndpoint}. Start the CV gRPC service (\`npm run dev:cv\`) and retry.`,
      });
    }

    res.status(500).json({ error: message });
  }
});

app.get(
  "/api/experiments/:experimentId/frames/:cameraId/:frameFile",
  async (req, res) => {
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
          `frame_${frameFile}`,
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
  },
);

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
        if (role === "phone") {
          room.members.forEach((member) => {
            if (member.role === "pc") {
              member.ws.send(
                JSON.stringify({
                  type: "phone:joined",
                  data: {
                    id: clientId,
                    type: "phone",
                    label: msg.label || "Phone",
                    status: "connecting",
                    peerId: clientId,
                  },
                }),
              );
            }
          });
        }

        // Also broadcast the join to everyone in the room (for presence/WebRTC)
        room.members.forEach((member) => {
          if (member.ws !== ws) {
            member.ws.send(
              JSON.stringify({
                type: "peer:joined",
                clientId: clientId,
                role: role,
              }),
            );
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
          if (msg.type === "peer:offer") {
            targetId = "pc";
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
