import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import net from "net";
import {
  createClient,
  setClient,
  computePhysics,
  runCalibration,
} from "../grpc-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

describe("Signaling <-> CV gRPC Integration", () => {
  let pythonProcess: ChildProcess;
  let port: number;
  const tempExperimentsDir = path.join(__dirname, "temp_experiments");
  let pythonStderr = "";

  beforeAll(async () => {
    port = await getFreePort();
    const serverPath = path.resolve(
      __dirname,
      "../../../cv-service/grpc_server.py",
    );
    const venvPython = path.resolve(
      __dirname,
      "../../../../.venv/Scripts/python.exe",
    );
    const pythonBin =
      process.env.PHYSICSCAPTURE_PYTHON_BIN ??
      (fs.existsSync(venvPython) ? venvPython : "python");

    if (!fs.existsSync(tempExperimentsDir)) {
      fs.mkdirSync(tempExperimentsDir, { recursive: true });
    }

    // Start Python server
    pythonProcess = spawn(pythonBin, [serverPath], {
      env: {
        ...process.env,
        PYTHON_GRPC_PORT: port.toString(),
        PYTHON_GRPC_BIND_ADDR: `127.0.0.1:${port}`,
        PYTHONPATH: path.resolve(__dirname, "../../../cv-service"),
      },
      // stdio: 'inherit' // Uncomment for debugging
    });
    pythonProcess.stderr?.on("data", (chunk) => {
      pythonStderr += chunk.toString();
    });

    // Wait for server to be ready by probing the port
    const maxRetries = 60;
    let connected = false;
    for (let i = 0; i < maxRetries; i++) {
      if (pythonProcess.exitCode !== null) {
        throw new Error(
          `Python gRPC server exited early (code=${pythonProcess.exitCode}). stderr:\n${pythonStderr}`,
        );
      }
      try {
        await new Promise((resolve, reject) => {
          const socket = net.connect(port, "127.0.0.1", () => {
            socket.end();
            resolve(true);
          });
          socket.on("error", reject);
        });
        connected = true;
        break;
      } catch (err) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    if (!connected) {
      throw new Error(
        `Failed to connect to Python gRPC server on port ${port} after ${maxRetries} retries. stderr:\n${pythonStderr}`,
      );
    }

    // Update gRPC client to point to the test server
    const testClient = createClient("127.0.0.1", port.toString());
    setClient(testClient);
  }, 20000);

  afterAll(async () => {
    if (pythonProcess) {
      pythonProcess.kill();
    }
    if (fs.existsSync(tempExperimentsDir)) {
      fs.rmSync(tempExperimentsDir, { recursive: true, force: true });
    }
  });

  it("should successfully call RunCalibration", async () => {
    const generator = runCalibration({
      experiment_id: "test-exp",
      camera_ids: [0],
    });

    const results = [];
    for await (const status of generator) {
      results.push(status);
    }

    expect(results.length).toBeGreaterThan(0);
    expect(results[results.length - 1]?.stage).toBe("FAILED");
    expect(results[results.length - 1]?.message).toContain(
      "Frames directory not found",
    );
  });

  it("should handle errors for missing experiments in ComputePhysics", async () => {
    // We expect a gRPC INTERNAL error because the experiment directory doesn't exist
    await expect(
      computePhysics({
        experiment_id: "non-existent",
        ball_configs: [],
        mode: "SINGLE_CAMERA_PLANAR",
      } as any),
    ).rejects.toThrow();
  });
});
