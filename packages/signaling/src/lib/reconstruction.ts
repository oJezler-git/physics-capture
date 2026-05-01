export interface TrajectoryPoint3D {
  frameIdx: number;
  x: number;
  y: number;
  z: number;
  x_unc: number;
  y_unc: number;
  z_unc: number;
  flagged: boolean;
}

export const buildTrajectoryByBall = (
  positionsData: unknown,
): Map<number, TrajectoryPoint3D[]> => {
  const result = new Map<number, TrajectoryPoint3D[]>();
  const frames = Array.isArray((positionsData as any)?.frames)
    ? (positionsData as any).frames
    : [];

  for (const frame of frames) {
    const frameIdx = Number(frame?.frame ?? 0);
    const balls = Array.isArray(frame?.balls) ? frame.balls : [];
    for (const ball of balls) {
      const ballId = Number(ball?.ball_id);
      if (!Number.isFinite(ballId)) continue;
      if (!result.has(ballId)) result.set(ballId, []);
      result.get(ballId)!.push({
        frameIdx,
        x: Number(ball?.x_m ?? 0),
        y: Number(ball?.y_m ?? 0),
        z: Number(ball?.z_m ?? 0),
        x_unc: Number(ball?.x_unc_m ?? 0),
        y_unc: Number(ball?.y_unc_m ?? 0),
        z_unc: Number(ball?.z_unc_m ?? 0),
        flagged: Boolean(ball?.flagged),
      });
    }
  }

  for (const [, points] of result) {
    points.sort((left, right) => left.frameIdx - right.frameIdx);
  }

  return result;
};
