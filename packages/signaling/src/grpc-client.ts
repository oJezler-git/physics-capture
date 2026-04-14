import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import { fileURLToPath } from "url";
import {
  CalibrationRequest,
  CalibrationStatus,
  TrackingRequest,
  TrackingStatus,
  PhysicsRequest,
  PhysicsResult,
  GrpcError,
} from "./types/grpc-types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROTO_PATH = path.resolve(__dirname, "../../../proto/physics.proto");

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const proto = grpc.loadPackageDefinition(packageDef) as any;
const PhysicsCapture = proto.physicscapture.v1.PhysicsCapture;

export const grpcClient = new PhysicsCapture(
  process.env.PYTHON_GRPC_PORT ? `localhost:${process.env.PYTHON_GRPC_PORT}` : "localhost:50051",
  grpc.credentials.createInsecure()
);

function mapGrpcError(raw: Error): GrpcError {
  const err = raw as any;
  return Object.assign(new Error(err.details ?? raw.message), {
    code: err.code ?? grpc.status.UNKNOWN,
    details: err.details ?? raw.message,
  }) as GrpcError;
}

async function* callStreamingRpc<TRequest, TResponse>(
  method: (req: TRequest) => grpc.ClientReadableStream<TResponse>,
  request: TRequest
): AsyncGenerator<TResponse, void, void> {
  const stream = method(request);

  const queue: Array<{ value?: TResponse; done?: boolean; error?: Error }> = [];
  let resolve: (() => void) | null = null;

  function notify() {
    if (resolve) {
      resolve();
      resolve = null;
    }
  }

  stream.on("data", (chunk: TResponse) => {
    queue.push({ value: chunk });
    notify();
  });

  stream.on("end", () => {
    queue.push({ done: true });
    notify();
  });

  stream.on("error", (err: Error) => {
    queue.push({ error: err });
    notify();
  });

  while (true) {
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.error) throw mapGrpcError(item.error);
      if (item.done) return;
      yield item.value!;
    }
    await new Promise<void>((r) => {
      resolve = r;
    });
  }
}

export function runCalibration(request: CalibrationRequest) {
  return callStreamingRpc<CalibrationRequest, CalibrationStatus>(
    (req) => grpcClient.runCalibration(req),
    request
  );
}

export function trackBalls(request: TrackingRequest) {
  return callStreamingRpc<TrackingRequest, TrackingStatus>(
    (req) => grpcClient.trackBalls(req),
    request
  );
}

export async function computePhysics(request: PhysicsRequest): Promise<PhysicsResult> {
  return new Promise((resolve, reject) => {
    grpcClient.computePhysics(
      request,
      { deadline: Date.now() + 30_000 },
      (err: any, res: PhysicsResult) => (err ? reject(mapGrpcError(err)) : resolve(res))
    );
  });
}
