import type { PhysicsResult } from '../types';

export interface VelocityChartPoint {
  ballId: number;
  timeMs: number;
  velocity: number;
  vLow: number;
  vHigh: number;
}

export const toVelocityChartData = (result: PhysicsResult): VelocityChartPoint[] => {
  const rows: VelocityChartPoint[] = [];

  for (const series of result.velocityTimeSeries) {
    for (const point of series.points) {
      rows.push({
        ballId: series.ballId,
        timeMs: point.time_ms,
        velocity: point.v,
        vLow: point.v - point.v_uncertainty,
        vHigh: point.v + point.v_uncertainty,
      });
    }
  }

  return rows.sort((left, right) => left.timeMs - right.timeMs || left.ballId - right.ballId);
};
