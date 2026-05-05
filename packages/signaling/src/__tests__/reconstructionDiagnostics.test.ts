import { describe, expect, it } from "vitest";
import { buildReconstructionDiagnostics } from "../lib/reconstructionDiagnostics.js";

describe("buildReconstructionDiagnostics", () => {
  it("produces high confidence for healthy stereo inputs", () => {
    const diagnostics = buildReconstructionDiagnostics({
      mode: "STEREO_3D",
      stereoExtrinsics: { baseline_mm: 120, reprojection_error_px: 0.22 },
      syncStatus: { isMock: false, rmsMs: 1.2 },
      tracksData: {
        balls: [
          {
            ball_id: 0,
            camera_id: 0,
            frames: Array.from({ length: 100 }, (_, frame_idx) => ({
              frame_idx,
              confidence: 0.97,
            })),
          },
          {
            ball_id: 0,
            camera_id: 1,
            frames: Array.from({ length: 100 }, (_, frame_idx) => ({
              frame_idx,
              confidence: 0.96,
            })),
          },
        ],
      },
      positions3d: {
        frames: Array.from({ length: 100 }, (_, frame) => ({
          frame,
          balls: [
            {
              ball_id: 0,
              x_m: frame * 0.01,
              y_m: 0.2,
              z_m: 1.5,
              flagged: false,
            },
          ],
        })),
      },
      positions3dGt: null,
    });

    expect(diagnostics.verdict).toBe("high");
    expect(diagnostics.overallConfidence).toBeGreaterThan(0.8);
    expect(diagnostics.issues).toHaveLength(0);
  });

  it("flags low confidence for weak or incomplete reconstruction setup", () => {
    const diagnostics = buildReconstructionDiagnostics({
      mode: "SINGLE_CAMERA_PLANAR",
      stereoExtrinsics: null,
      syncStatus: { isMock: true, rmsMs: 0 },
      tracksData: {
        balls: [
          {
            ball_id: 0,
            camera_id: 0,
            frames: Array.from({ length: 10 }, (_, frame_idx) => ({
              frame_idx,
              confidence: 0.6,
            })),
          },
        ],
      },
      positions3d: {
        frames: Array.from({ length: 10 }, (_, frame) => ({
          frame,
          balls: [
            {
              ball_id: 0,
              x_m: frame * 0.01,
              y_m: frame * 0.01,
              z_m: 1.5,
              flagged: true,
            },
          ],
        })),
      },
      positions3dGt: null,
    });

    expect(diagnostics.verdict).toBe("low");
    expect(diagnostics.overallConfidence).toBeLessThan(0.55);
    expect(diagnostics.issues.length).toBeGreaterThan(0);
    expect(diagnostics.checks.some((check) => check.status === "fail")).toBe(
      true,
    );
  });
});
