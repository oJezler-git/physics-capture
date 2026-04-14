import type { CalibrationProfile, CalibrationResult } from '../types';
import { useCalibrationStore } from './calibrationStore';

const calibrationResultFixture: CalibrationResult = {
  experimentId: 'exp-1',
  intrinsics: [
    {
      cameraId: 'cam-1',
      fx: 1,
      fy: 1,
      cx: 1,
      cy: 1,
      k1: 0,
      k2: 0,
      p1: 0,
      p2: 0,
      k3: 0,
      reprojection_error_px: 0.45,
    },
  ],
  stereo: {
    R: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    T: [1, 2, 3],
    reprojection_error_px: 0.62,
  },
  rulerScaleFactor: null,
  completedAt: 123,
};

describe('calibrationStore', () => {
  beforeEach(() => {
    useCalibrationStore.getState().reset();
  });

  it('tracks calibration progress lifecycle', () => {
    const state = useCalibrationStore.getState();

    state.startCalibration();
    expect(useCalibrationStore.getState().status).toBe('running');
    expect(useCalibrationStore.getState().progress).toBe(0);

    useCalibrationStore.getState().onCalibrationProgress(0.35);
    expect(useCalibrationStore.getState().progress).toBe(0.35);

    useCalibrationStore.getState().onCalibrationComplete(calibrationResultFixture);
    const completed = useCalibrationStore.getState();
    expect(completed.status).toBe('complete');
    expect(completed.progress).toBe(1);
    expect(completed.reprojectionError).toBe(0.62);
  });

  it('stores failure state and error message', () => {
    useCalibrationStore.getState().startCalibration();
    useCalibrationStore.getState().onCalibrationFailed('calibration exploded');

    const state = useCalibrationStore.getState();
    expect(state.status).toBe('failed');
    expect(state.error).toBe('calibration exploded');
  });

  it('loads a saved profile into active calibration state', () => {
    const profile: CalibrationProfile = {
      id: 'profile-1',
      name: 'lab profile',
      result: calibrationResultFixture,
      createdAt: 123,
    };

    useCalibrationStore.getState().loadProfile(profile);
    const state = useCalibrationStore.getState();

    expect(state.activeProfile?.id).toBe('profile-1');
    expect(state.status).toBe('complete');
    expect(state.intrinsics).toEqual(calibrationResultFixture.intrinsics);
  });
});
