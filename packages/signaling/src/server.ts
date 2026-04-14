// packages/signaling/src/server.ts
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { extractFrames } from "./ffmpeg.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXPERIMENTS_DIR = path.resolve(__dirname, "../../experiments");

const app = express();
const upload = multer({ dest: path.join(EXPERIMENTS_DIR, "temp") });
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// REST API for file handling
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
    
    await fs.mkdir(rawDir, { recursive: true });
    
    const destPath = path.join(rawDir, `cam${camera_id}${path.extname(file.originalname)}`);
    await fs.rename(file.path, destPath);

    // Extraction
    const frameCount = await extractFrames(destPath, framesDir);

    res.json({ experiment_id, camera_id, stored_path: destPath, frame_count: frameCount });
  } catch (err: any) {
    console.error("Upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

// WebSocket Signaling Hub
wss.on("connection", (ws: WebSocket) => {
  ws.on("message", (data: string) => {
    const msg = JSON.parse(data.toString());
    // Signaling relay implementation (from I. Orchestration Backend §4.1)
    console.log("Received signaling message:", msg.type);
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(msg));
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`Orchestration backend listening on port ${PORT}`);
});
