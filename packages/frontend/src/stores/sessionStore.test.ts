import { useSessionStore } from './sessionStore';

describe('sessionStore.advancePhase', () => {
  beforeEach(() => {
    useSessionStore.setState({
      experimentId: null,
      cameras: [],
      ballConfigs: [],
      phase: 'setup',
    });
  });

  it('advances through each phase in order and stops at results', () => {
    const phases = ['setup', 'calibration', 'recording', 'tracking', 'results', 'results'];

    for (let index = 0; index < phases.length - 1; index++) {
      expect(useSessionStore.getState().phase).toBe(phases[index]);
      useSessionStore.getState().advancePhase();
      expect(useSessionStore.getState().phase).toBe(phases[index + 1]);
    }
  });
});
