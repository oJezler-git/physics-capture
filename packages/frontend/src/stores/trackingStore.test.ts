import type { BallSeed } from '../types';
import { useTrackingStore } from './trackingStore';

const makeSeed = (ballId: number, cameraId: string): BallSeed => ({
  ballId,
  cameraId,
  frameIdx: 0,
  x: 100 + ballId,
  y: 200 + ballId,
});

describe('trackingStore addSeed', () => {
  beforeEach(() => {
    useTrackingStore.getState().reset();
  });

  it('enforces max 3 unique balls per camera', () => {
    const store = useTrackingStore.getState();

    expect(store.addSeed(makeSeed(0, 'cam-a'))).toBe(true);
    expect(store.addSeed(makeSeed(1, 'cam-a'))).toBe(true);
    expect(store.addSeed(makeSeed(2, 'cam-a'))).toBe(true);
    expect(store.addSeed(makeSeed(3, 'cam-a'))).toBe(false);

    expect(useTrackingStore.getState().seeds).toHaveLength(3);
  });

  it('allows updating existing seed for the same ball and camera', () => {
    const firstSeed = makeSeed(0, 'cam-a');
    const updatedSeed = { ...firstSeed, x: 777, y: 888 };

    useTrackingStore.getState().addSeed(firstSeed);
    expect(useTrackingStore.getState().addSeed(updatedSeed)).toBe(true);

    expect(useTrackingStore.getState().seeds).toEqual([updatedSeed]);
  });

  it('replaces existing correction for the same keyframe', () => {
    const state = useTrackingStore.getState();
    const correctionA = { ballId: 0, cameraId: 'cam-a', frameIdx: 12, x_new: 10, y_new: 20 };
    const correctionB = { ballId: 0, cameraId: 'cam-a', frameIdx: 12, x_new: 30, y_new: 40 };

    state.applyCorrection(correctionA);
    useTrackingStore.getState().applyCorrection(correctionB);

    expect(useTrackingStore.getState().corrections).toEqual([correctionB]);
  });
});
