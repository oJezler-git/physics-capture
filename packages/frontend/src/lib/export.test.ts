import { exportCSV } from './export';
import type { PhysicsResult } from '../types';

const fixture: PhysicsResult = {
  experimentId: 'exp-1',
  computedAt: 1,
  balls: [
    {
      ballId: 0,
      mass_kg: { value: 0.05, uncertainty: 0.001 },
      v_before: { value: 1.2, uncertainty: 0.1 },
      v_after: { value: -0.8, uncertainty: 0.08 },
      p_before: { value: 0.06, uncertainty: 0.005 },
      p_after: { value: -0.04, uncertainty: 0.004 },
      ke_before: { value: 0.03, uncertainty: 0.003 },
      ke_after: { value: 0.016, uncertainty: 0.0015 },
    },
  ],
  system: {
    p_before_total: { value: 0.06, uncertainty: 0.005 },
    p_after_total: { value: -0.04, uncertainty: 0.004 },
    ke_before_total: { value: 0.03, uncertainty: 0.003 },
    ke_after_total: { value: 0.016, uncertainty: 0.0015 },
    momentum_conserved_pct: { value: 93.2, uncertainty: 1.1 },
    coeff_of_restitution: { value: 0.76, uncertainty: 0.04 },
    collision_frame_idx: 120,
  },
  velocityTimeSeries: [],
};

describe('exportCSV', () => {
  it('serializes a physics result fixture', () => {
    const csv = exportCSV(fixture);

    expect(csv).toContain('ball_id,mass_kg,mass_uncertainty');
    expect(csv).toContain('0.0500,0.0010,1.2000,0.1000');
    expect(csv).toContain('momentum_conserved_pct,93.2000,1.1000');
  });
});
