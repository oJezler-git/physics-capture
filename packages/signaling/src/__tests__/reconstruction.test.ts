import { describe, expect, it } from "vitest";
import { buildTrajectoryByBall } from "../lib/reconstruction.js";

describe("buildTrajectoryByBall", () => {
  it("maps positions_3d frames into per-ball trajectories", () => {
    const positions3d = {
      frames: [
        {
          frame: 1,
          balls: [
            {
              ball_id: 0,
              x_m: 0.2,
              y_m: 0.1,
              z_m: 1.0,
              x_unc_m: 0.001,
              y_unc_m: 0.002,
              z_unc_m: 0.003,
              flagged: false,
            },
          ],
        },
        {
          frame: 0,
          balls: [
            {
              ball_id: 0,
              x_m: 0.1,
              y_m: 0.0,
              z_m: 1.0,
              x_unc_m: 0.001,
              y_unc_m: 0.002,
              z_unc_m: 0.003,
              flagged: true,
            },
            {
              ball_id: 1,
              x_m: -0.1,
              y_m: 0.0,
              z_m: 1.2,
              x_unc_m: 0.004,
              y_unc_m: 0.005,
              z_unc_m: 0.006,
              flagged: false,
            },
          ],
        },
      ],
    };

    const mapped = buildTrajectoryByBall(positions3d);
    expect(mapped.get(0)).toEqual([
      {
        frameIdx: 0,
        x: 0.1,
        y: 0.0,
        z: 1.0,
        x_unc: 0.001,
        y_unc: 0.002,
        z_unc: 0.003,
        flagged: true,
      },
      {
        frameIdx: 1,
        x: 0.2,
        y: 0.1,
        z: 1.0,
        x_unc: 0.001,
        y_unc: 0.002,
        z_unc: 0.003,
        flagged: false,
      },
    ]);
    expect(mapped.get(1)).toEqual([
      {
        frameIdx: 0,
        x: -0.1,
        y: 0.0,
        z: 1.2,
        x_unc: 0.004,
        y_unc: 0.005,
        z_unc: 0.006,
        flagged: false,
      },
    ]);
  });

  it("returns empty map for malformed inputs", () => {
    expect(buildTrajectoryByBall({})).toEqual(new Map());
    expect(buildTrajectoryByBall(null)).toEqual(new Map());
  });
});
