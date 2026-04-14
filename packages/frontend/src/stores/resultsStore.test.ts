import type { PhysicsResult, SyncData } from '../types';
import { useResultsStore } from './resultsStore';

const physicsResultFixture: PhysicsResult = {
  experimentId: 'exp-results',
  computedAt: 99,
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
  velocityTimeSeries: [],
};

const syncDataFixture: SyncData = {
  experimentId: 'exp-results',
  frameToMs: { 0: 0, 1: 16.7 },
  phase_offset_ms: [0],
  true_fps: [59.9],
  fit_residual_ms: [0.2],
};

describe('resultsStore', () => {
  beforeEach(() => {
    useResultsStore.getState().reset();
  });

  it('moves from computing to complete when physics arrives', () => {
    useResultsStore.getState().requestPhysics();
    expect(useResultsStore.getState().status).toBe('computing');

    useResultsStore.getState().onPhysicsResult(physicsResultFixture);
    const state = useResultsStore.getState();
    expect(state.status).toBe('complete');
    expect(state.physicsResult?.experimentId).toBe('exp-results');
  });

  it('stores sync metadata', () => {
    useResultsStore.getState().setSyncData(syncDataFixture);
    expect(useResultsStore.getState().syncData).toEqual(syncDataFixture);
  });

  it('resets to a clean idle state', () => {
    useResultsStore.getState().requestPhysics();
    useResultsStore.getState().onPhysicsResult(physicsResultFixture);
    useResultsStore.getState().setSyncData(syncDataFixture);

    useResultsStore.getState().reset();
    const state = useResultsStore.getState();
    expect(state.status).toBe('idle');
    expect(state.physicsResult).toBeNull();
    expect(state.syncData).toBeNull();
  });
});
