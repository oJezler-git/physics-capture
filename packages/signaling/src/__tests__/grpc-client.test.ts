import { describe, it, expect, vi } from "vitest";
import * as grpc from "@grpc/grpc-js";

// Re-importing mapping function to test
// Assuming mapGrpcError was exported or made testable
import { mapGrpcError } from "../grpc-client.js";

describe("grpc-client error mapping", () => {
  it("should map gRPC errors correctly", () => {
    const rawError = {
      details: "Internal error",
      code: grpc.status.INTERNAL,
    } as any;

    const mapped = mapGrpcError(rawError);
    expect(mapped.message).toBe("Internal error");
    expect((mapped as any).code).toBe(grpc.status.INTERNAL);
  });
});
