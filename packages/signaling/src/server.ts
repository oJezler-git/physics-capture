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
    const data = await fs.readFile(PROFILES_FILE, "utf-8");
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
      const data = await fs.readFile(PROFILES_FILE, "utf-8");
      profiles = JSON.parse(data);
    } catch (err) {
      if ((err as any).code !== "ENOENT") throw err;
    }
    profiles.unshift(newProfile);
    await fs.writeFile(PROFILES_FILE, JSON.stringify(profiles, null, 2));
    res.status(201).json({ message: "Profile saved" });
  } catch (err) {
    console.error("Profile save error:", err);
    res.status(500).json({ error: "Failed to save profile" });
  }
});

import { grpcClient, runCalibration } from "./grpc-client.js";

// ... (other imports)

app.post("/api/calibrate", async (req, res) => {
  try {
    const { experimentId } = req.body;
    // Get camera IDs from the session store or request body
    // Assuming for now we want to calibrate all cameras in the experiment
    // For smoke test, we'll try to calibrate camera 0
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
                  status: 'live',
                  peerId: msg.peerId || clientId
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

server.listen(PORT, () => {
  console.log(`Orchestration backend listening on port ${PORT}`);
});
