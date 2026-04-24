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

  it('manages camera addition and status merging', () => {
    const cam = { id: 'cam-1', status: 'live' } as any;
    useSessionStore.getState().addCamera(cam);
    expect(useSessionStore.getState().cameras).toHaveLength(1);

    // Update status to disconnected
    useSessionStore.getState().addCamera({ id: 'cam-1', status: 'disconnected' } as any);
    expect(useSessionStore.getState().cameras[0].status).toBe('disconnected');
  });

  it('removes a camera correctly', () => {
    useSessionStore.getState().addCamera({ id: 'cam-1', status: 'live' } as any);
    useSessionStore.getState().removeCamera('cam-1');
    expect(useSessionStore.getState().cameras).toHaveLength(0);
  });
});
