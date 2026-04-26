import type { CalibrationResult } from '../types';
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

    useCalibrationStore.getState().onCalibrationProgress({
      progress: 0.35,
      stage: 'DETECTING_CORNERS',
      message: 'Searching for checkerboard corners',
    });
    expect(useCalibrationStore.getState().progress).toBe(0.35);
    expect(useCalibrationStore.getState().calibrationStage).toBe('DETECTING_CORNERS');
    expect(useCalibrationStore.getState().stageMessage).toContain('checkerboard');

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

  it('resets to idle state', () => {
    useCalibrationStore.getState().onCalibrationComplete(calibrationResultFixture);
    useCalibrationStore.getState().reset();
    
    const state = useCalibrationStore.getState();
    expect(state.status).toBe('idle');
    expect(state.reprojectionError).toBeNull();
    expect(state.intrinsics).toEqual([]);
    expect(state.rulerScaleFactor).toBeNull();
  });

  it('sets ruler scale factor correctly', () => {
    useCalibrationStore.getState().setRulerScale(1.5);
    const state = useCalibrationStore.getState();
    expect(state.rulerScaleFactor).toBe(1.5);
    expect(state.status).toBe('complete');
  });

  it('prioritizes stereo reprojection error over intrinsic error', () => {
    // Both exist, should prefer stereo
    useCalibrationStore.getState().onCalibrationComplete(calibrationResultFixture);
    expect(useCalibrationStore.getState().reprojectionError).toBe(0.62);
  });

  it('falls back to intrinsic error if stereo is null', () => {
    const intrinsicOnly = {
        ...calibrationResultFixture,
        stereo: null
    };
    useCalibrationStore.getState().onCalibrationComplete(intrinsicOnly);
    expect(useCalibrationStore.getState().reprojectionError).toBe(0.45);
  });
});
