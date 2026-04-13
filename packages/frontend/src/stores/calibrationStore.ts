import { create } from 'zustand';
import type {
  CalibrationProfile,
  CalibrationResult,
  CameraIntrinsics,
  StereoExtrinsics,
} from '../types';

interface CalibrationState {
  profiles: CalibrationProfile[]; // saved profiles from DB
  activeProfile: CalibrationProfile | null;
  status: 'idle' | 'running' | 'complete' | 'failed';
  reprojectionError: number | null; // pixels RMS, null if not yet computed
  intrinsics: CameraIntrinsics[]; // per camera
  stereoExtrinsics: StereoExtrinsics | null;
  rulerScaleFactor: number | null; // px/mm; null if stereo calibration used
  progress: number;
  error: string | null;

  // Actions
  setProfiles: (profiles: CalibrationProfile[]) => void;
  startCalibration: () => void;
  onCalibrationProgress: (progress: number) => void;
  onCalibrationComplete: (result: CalibrationResult) => void;
  onCalibrationFailed: (error: string) => void;
  saveProfile: (name: string) => void;
  loadProfile: (profile: CalibrationProfile) => void;
  setRulerScale: (pxPerMm: number) => void;
  reset: () => void;
}

export const useCalibrationStore = create<CalibrationState>((set) => ({
  profiles: [],
  activeProfile: null,
  status: 'idle',
  reprojectionError: null,
  intrinsics: [],
  stereoExtrinsics: null,
  rulerScaleFactor: null,
  progress: 0,
  error: null,

  setProfiles: (profiles) => set({ profiles }),

  startCalibration: () => set({ status: 'running', reprojectionError: null, progress: 0, error: null }),

  onCalibrationProgress: (progress) => set({ status: 'running', progress }),

  onCalibrationComplete: (result) =>
    set({
      status: 'complete',
      intrinsics: result.intrinsics,
      stereoExtrinsics: result.stereo,
      reprojectionError:
        result.stereo?.reprojection_error_px || result.intrinsics[0]?.reprojection_error_px || null,
      rulerScaleFactor: result.rulerScaleFactor,
      progress: 1,
      error: null,
    }),

  onCalibrationFailed: (error) => set({ status: 'failed', error }),

  saveProfile: (_name) => {
    // This would typically involve an API call, then updating the 'profiles' list
  },

  loadProfile: (profile) =>
    set({
      activeProfile: profile,
      intrinsics: profile.result.intrinsics,
      stereoExtrinsics: profile.result.stereo,
      reprojectionError:
        profile.result.stereo?.reprojection_error_px ||
        profile.result.intrinsics[0]?.reprojection_error_px ||
        null,
      rulerScaleFactor: profile.result.rulerScaleFactor,
      status: 'complete',
      progress: 1,
      error: null,
    }),

  setRulerScale: (pxPerMm) => set({ rulerScaleFactor: pxPerMm, status: 'complete', error: null }),

  reset: () =>
    set({
      activeProfile: null,
      status: 'idle',
      reprojectionError: null,
      intrinsics: [],
      stereoExtrinsics: null,
      rulerScaleFactor: null,
      progress: 0,
      error: null,
    }),
}));
