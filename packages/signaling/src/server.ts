// packages/signaling/src/server.ts
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import multer from "multer";
import path from "path";
import fs, { existsSync } from "fs";
import dgram from "dgram";
import os from "os";
import { fileURLToPath } from "url";
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
  console.log(`[REQ] ${req.method} ${req.url}`);
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

  const frames = fs.readdirSync(cam0Dir).filter((f: string) => f.toLowerCase().endsWith(".jpg"));
  res.json({
    id: experimentId,
    frameCount: frames.length,
    resolution: "1280x720" // default for now, could detect from first image
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
    const { experimentId } = req.body;
    const calibrationStream = runCalibration({
      experiment_id: experimentId,
      camera_ids: [0] 
    });

    let finalStatus;
    for await (const status of calibrationStream) {
        console.log("Calibration status:", status);
        finalStatus = status;
    }

    res.json({
        experimentId,
        intrinsics: [], // Should be filled from finalStatus
        stereo: null,
        rulerScaleFactor: 1.0,
        completedAt: Date.now(),
    });
  } catch (err: any) {
    console.error("Calibration error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/upload-video", upload.single("file"), async (req, res) => {
  try {
    const { experiment_id, camera_id } = req.body;
    const file = req.file;
    if (!file || !experiment_id || !camera_id) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const experimentDir = path.join(EXPERIMENTS_DIR, experiment_id);
    const rawDir = path.join(experimentDir, "raw");
    const framesDir = path.join(experimentDir, "frames", `cam${camera_id}`);
    
    await fs.promises.mkdir(rawDir, { recursive: true });
    
    const destPath = path.join(rawDir, `cam${camera_id}${path.extname(file.originalname)}`);
    await fs.promises.rename(file.path, destPath);

    // Extraction
    const frameCount = await extractFrames(destPath, framesDir);

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

    const responsePayload = {
      experimentId,
      computedAt: Date.now(),
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
    res.status(500).json({ error: message });
  }
});

app.post("/api/track", async (req, res) => {
  try {
    const { experiment_id, seeds, start_frame_idx, end_frame_idx, model_id } = req.body as {
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

    for await (const status of trackBalls({ experiment_id, seeds, model_id })) {
      if (end_frame_idx !== undefined && status.frame > end_frame_idx) {
        break;
      }

      statusCount += 1;
      latestProgress = Math.max(latestProgress, status.progress ?? 0);

      for (const point of status.points ?? []) {
        if (
          (start_frame_idx !== undefined && status.frame < start_frame_idx) ||
          (end_frame_idx !== undefined && status.frame > end_frame_idx)
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
          frameIdx: status.frame,
          x: point.x,
          y: point.y,
          confidence: point.confidence,
          isFlagged: point.confidence < 0.7,
          isCorrected: false,
        });
      }
    }

    const tracks = [...trackMap.values()].map((track) => ({
      ...track,
      points: track.points.sort((a, b) => a.frameIdx - b.frameIdx),
    }));

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

const servedFramesCount = new Map<string, number>();

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
    const count = (servedFramesCount.get(key) || 0) + 1;
    servedFramesCount.set(key, count);

    // Support both numeric-only (new) and frame_ prefixed (old) formats
    let framePath = path.join(
      EXPERIMENTS_DIR,
      experimentId,
      "frames",
      `cam${cameraId}`,
      frameFile,
    );

    if (count <= 5) {
      console.log(`[signal] [API] Serving frame: ${framePath}`);
    } else if (count === 6) {
      console.log(`[signal] [API] Serving frames for ${key} (further logs for this experiment hidden)`);
    }

    // Backward compatibility check
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

    console.log("[API] Serving frame:", framePath);

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
