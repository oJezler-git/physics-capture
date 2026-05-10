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

  it("handles metre-vs-millimetre projection matrix scale mismatch", () => {
    const points = Array.from({ length: 5 }, (_, i) => {
      const x = 0.2 + i * 0.02;
      const y = 0.25;
      const z = 1.5;
      return { frame: i, x, y, z };
    });

    const tracksCam0 = points.map((p) => ({
      frame_idx: p.frame,
      x_px: 980 * (p.x / p.z) + 960,
      y_px: 980 * (p.y / p.z) + 540,
      confidence: 1,
    }));
    // P1 translation below is in mm, so project using mm xyz for synthetic track.
    const tracksCam1 = points.map((p) => {
      const xMm = p.x * 1000;
      const yMm = p.y * 1000;
      const zMm = p.z * 1000;
      const r0 = 980 * xMm + 960 * zMm - 114448.58;
      const r1 = 980 * yMm + 540 * zMm;
      const r2 = zMm + 3.2;
      return {
        frame_idx: p.frame,
        x_px: r0 / r2,
        y_px: r1 / r2,
        confidence: 1,
      };
    });

    const diagnostics = buildReconstructionDiagnostics({
      mode: "STEREO_3D",
      stereoExtrinsics: {
        baseline_mm: 120,
        reprojection_error_px: 0,
        P0: [
          [980, 0, 960, 0],
          [0, 980, 540, 0],
          [0, 0, 1, 0],
        ],
        P1: [
          [980, 0, 960, -114448.58],
          [0, 980, 540, 0],
          [0, 0, 1, 3.2],
        ],
      },
      syncStatus: { isMock: false, rmsMs: 0.7 },
      tracksData: {
        balls: [
          { ball_id: 0, camera_id: 0, frames: tracksCam0 },
          { ball_id: 0, camera_id: 1, frames: tracksCam1 },
        ],
      },
      positions3d: {
        frames: points.map((p) => ({
          frame: p.frame,
          balls: [{ ball_id: 0, x_m: p.x, y_m: p.y, z_m: p.z, flagged: false }],
        })),
      },
      positions3dGt: null,
    });

    expect(diagnostics.metrics.reprojRmseCam0Px).not.toBeNull();
    expect(diagnostics.metrics.reprojRmseCam1Px).not.toBeNull();
    expect(diagnostics.metrics.reprojRmseCam0Px!).toBeLessThan(0.5);
    expect(diagnostics.metrics.reprojRmseCam1Px!).toBeLessThan(0.5);
  });

  it("accounts for lens distortion when computing reprojection residual", () => {
    const point = { x: 0.2, y: 0.25, z: 1.5 };
    const P0 = [
      [980, 0, 960, 0],
      [0, 980, 540, 0],
      [0, 0, 1, 0],
    ];
    const K = {
      camera_id: 0,
      fx: 980,
      fy: 980,
      cx: 960,
      cy: 540,
      k1: -0.08,
      k2: 0.02,
      p1: 0.001,
      p2: -0.001,
      k3: 0,
    };
    const u = 980 * (point.x / point.z) + 960;
    const v = 980 * (point.y / point.z) + 540;
    const x = (u - K.cx) / K.fx;
    const y = (v - K.cy) / K.fy;
    const r2 = x * x + y * y;
    const r4 = r2 * r2;
    const radial = 1 + K.k1 * r2 + K.k2 * r4;
    const xd = x * radial + 2 * K.p1 * x * y + K.p2 * (r2 + 2 * x * x);
    const yd = y * radial + K.p1 * (r2 + 2 * y * y) + 2 * K.p2 * x * y;
    const ud = xd * K.fx + K.cx;
    const vd = yd * K.fy + K.cy;

    const diagnostics = buildReconstructionDiagnostics({
      mode: "STEREO_3D",
      stereoExtrinsics: {
        baseline_mm: 120,
        reprojection_error_px: 0,
        P0,
        P1: P0,
      },
      syncStatus: { isMock: false, rmsMs: 0.7 },
      tracksData: {
        balls: [
          {
            ball_id: 0,
            camera_id: 0,
            frames: [{ frame_idx: 0, x_px: ud, y_px: vd, confidence: 1 }],
          },
          {
            ball_id: 0,
            camera_id: 1,
            frames: [{ frame_idx: 0, x_px: ud, y_px: vd, confidence: 1 }],
          },
        ],
      },
      positions3d: {
        frames: [
          {
            frame: 0,
            balls: [
              {
                ball_id: 0,
                x_m: point.x,
                y_m: point.y,
                z_m: point.z,
                flagged: false,
              },
            ],
          },
        ],
      },
      positions3dGt: null,
      intrinsics: [K, { ...K, camera_id: 1 }],
    });

    expect(diagnostics.metrics.reprojRmseCam0Px!).toBeLessThan(0.01);
    expect(diagnostics.metrics.reprojRmseCam1Px!).toBeLessThan(0.01);
  });

  it("surfaces depth scale/offset bias via GT depth fit metric", () => {
    const points = Array.from({ length: 20 }, (_, i) => ({
      frame: i,
      zGt: 1.0 + i * 0.01,
    }));
    const diagnostics = buildReconstructionDiagnostics({
      mode: "STEREO_3D",
      stereoExtrinsics: { baseline_mm: 120, reprojection_error_px: 0 },
      syncStatus: { isMock: false, rmsMs: 0.7 },
      tracksData: { balls: [] },
      positions3d: {
        frames: points.map((p) => ({
          frame: p.frame,
          balls: [
            {
              ball_id: 0,
              x_m: 0.1,
              y_m: 0.2,
              z_m: (p.zGt - 0.02) / 0.97, // biased estimate
              flagged: false,
            },
          ],
        })),
      },
      positions3dGt: {
        frames: points.map((p) => ({
          frame: p.frame,
          balls: [{ ball_id: 0, x_m: 0.1, y_m: 0.2, z_m: p.zGt }],
        })),
      },
    });

    expect(diagnostics.metrics.gtDepthFitScale).not.toBeNull();
    expect(diagnostics.metrics.gtDepthFitOffsetM).not.toBeNull();
    expect(diagnostics.metrics.gtDepthFitRmseZm).not.toBeNull();
    expect(diagnostics.metrics.gtDepthFitImprovementPct).not.toBeNull();
    expect(diagnostics.metrics.gtDepthFitImprovementPct!).toBeGreaterThan(95);
    expect(
      diagnostics.checks.some((check) => check.id === "gt-depth-fit"),
    ).toBe(true);
  });
});
