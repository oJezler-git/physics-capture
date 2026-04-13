import { toVelocityChartData } from './results';
import type { PhysicsResult } from '../types';

const fixture: PhysicsResult = {
  experimentId: 'exp-2',
  computedAt: 2,
  balls: [],
  system: {
    p_before_total: { value: 0, uncertainty: 0 },
    p_after_total: { value: 0, uncertainty: 0 },
    ke_before_total: { value: 0, uncertainty: 0 },
    ke_after_total: { value: 0, uncertainty: 0 },
    momentum_conserved_pct: { value: 100, uncertainty: 0 },
    coeff_of_restitution: { value: 1, uncertainty: 0 },
    collision_frame_idx: 0,
  },
  velocityTimeSeries: [
    {
      ballId: 0,
      points: [{ time_ms: 10, v: 1.5, v_uncertainty: 0.2 }],
    },
  ],
};

describe('toVelocityChartData', () => {
  it('calculates uncertainty bounds for each velocity point', () => {
    const [point] = toVelocityChartData(fixture);

    expect(point.vLow).toBeCloseTo(1.3, 5);
    expect(point.vHigh).toBeCloseTo(1.7, 5);
  });
});
