import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { trackBalls, runCalibration, computePhysics } from "./grpc-client.js";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

wss.on("connection", (ws: WebSocket) => {
  console.log("Client connected via WebSocket");

  ws.on("message", async (data: string) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log("Received message:", msg);

      if (msg.type === "TRACK_BALLS") {
        const { experimentId, seeds } = msg.payload;
        console.log(`Starting tracking for experiment: ${experimentId}`);
        try {
          for await (const status of trackBalls({ experiment_id: experimentId, seeds })) {
            ws.send(JSON.stringify({ type: "TRACKING_STATUS", payload: status }));
          }
          ws.send(JSON.stringify({ type: "TRACKING_COMPLETE" }));
        } catch (error: any) {
          console.error("Tracking error:", error);
          ws.send(JSON.stringify({ type: "ERROR", payload: { message: error.message, code: error.code } }));
        }
      }

      if (msg.type === "RUN_CALIBRATION") {
        const { experimentId, cameraIds } = msg.payload;
        console.log(`Starting calibration for experiment: ${experimentId}`);
        try {
          for await (const status of runCalibration({ experiment_id: experimentId, camera_ids: cameraIds })) {
            ws.send(JSON.stringify({ type: "CALIBRATION_STATUS", payload: status }));
          }
          ws.send(JSON.stringify({ type: "CALIBRATION_COMPLETE" }));
        } catch (error: any) {
          console.error("Calibration error:", error);
          ws.send(JSON.stringify({ type: "ERROR", payload: { message: error.message, code: error.code } }));
        }
      }

      if (msg.type === "COMPUTE_PHYSICS") {
        const { experimentId, ballConfigs, mode } = msg.payload;
        console.log(`Starting physics computation for experiment: ${experimentId}`);
        try {
          const result = await computePhysics({ experiment_id: experimentId, ball_configs: ballConfigs, mode });
          ws.send(JSON.stringify({ type: "PHYSICS_RESULT", payload: result }));
        } catch (error: any) {
          console.error("Physics error:", error);
          ws.send(JSON.stringify({ type: "ERROR", payload: { message: error.message, code: error.code } }));
        }
      }
    } catch (e: any) {
      console.error("Invalid message format:", e.message);
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`);
});
