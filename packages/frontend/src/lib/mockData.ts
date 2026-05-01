import type { BallResult, Reconstruction3D } from '../types';

export const mockBallResults: BallResult[] = [
  {
    ballId: 0,
    mass_kg: { value: 0.05, uncertainty: 0.001 },
    v_before: { value: 1.2, uncertainty: 0.05 },
    v_after: { value: -0.8, uncertainty: 0.05 },
    p_before: { value: 0.06, uncertainty: 0.002 },
    p_after: { value: -0.04, uncertainty: 0.002 },
    ke_before: { value: 0.036, uncertainty: 0.003 },
    ke_after: { value: 0.016, uncertainty: 0.002 },
    trajectory3d: Array.from({ length: 60 }, (_, i) => ({
      frameIdx: i,
      x: i * 0.05 - 1.5,
      y: 0.5 + Math.sin(i * 0.1) * 0.2,
      z: Math.cos(i * 0.05) * 0.3,
      x_unc: 0.005,
      y_unc: 0.005,
      z_unc: 0.005,
      flagged: false,
    })),
  },
  {
    ballId: 1,
    mass_kg: { value: 0.05, uncertainty: 0.001 },
    v_before: { value: 0, uncertainty: 0 },
    v_after: { value: 0.9, uncertainty: 0.05 },
    p_before: { value: 0, uncertainty: 0 },
    p_after: { value: 0.045, uncertainty: 0.002 },
    ke_before: { value: 0, uncertainty: 0 },
    ke_after: { value: 0.02, uncertainty: 0.002 },
    trajectory3d: Array.from({ length: 60 }, (_, i) => ({
      frameIdx: i,
      x: i * 0.02 - 0.5,
      y: 0.1,
      z: -0.2 + Math.sin(i * 0.05) * 0.1,
      x_unc: 0.005,
      y_unc: 0.005,
      z_unc: 0.005,
      flagged: false,
    })),
  },
];

export const mockReconstruction3d: Reconstruction3D = {
  mode: 'STEREO_3D',
  stereoExtrinsics: {
    T: [300, 100, 50],
    R: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
  },
};
