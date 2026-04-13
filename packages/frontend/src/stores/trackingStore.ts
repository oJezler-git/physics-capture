import { create } from 'zustand';
import type { BallSeed, BallTrack, CorrectionKeyframe } from '../types';

interface TrackingState {
  frameCount: number;
  currentFrame: number; // 0-indexed, scrubber position
  seeds: BallSeed[]; // user-placed seeds
  tracks: BallTrack[]; // SAM2 output per ball per camera
  corrections: CorrectionKeyframe[]; // user corrections
  status: 'idle' | 'tracking' | 'complete' | 'awaiting_correction';
  progress: number; // 0.0–1.0

  // Actions
  setFrameCount: (n: number) => void;
  setFrame: (n: number) => void;
  addSeed: (seed: BallSeed) => void;
  removeSeed: (ballId: number, cameraId: string) => void;
  startTracking: () => void;
  onTrackingUpdate: (tracks: BallTrack[], progress: number) => void;
  onTrackingComplete: (tracks: BallTrack[]) => void;
  applyCorrection: (correction: CorrectionKeyframe) => void;
  reset: () => void;
}

export const useTrackingStore = create<TrackingState>((set) => ({
  frameCount: 0,
  currentFrame: 0,
  seeds: [],
  tracks: [],
  corrections: [],
  status: 'idle',
  progress: 0,

  setFrameCount: (n) => set({ frameCount: n }),

  setFrame: (n) =>
    set((state) => ({
      currentFrame: Math.max(0, Math.min(n, state.frameCount - 1)),
    })),

  addSeed: (seed) =>
    set((state) => {
      // Limit to 3 balls per camera? (Section 8 says "Maximum 3 balls total")
      // Wait, the plan says "maximum 3 balls per camera" in some places
      // and "maximum 3 balls total" in others.
      // Section 8: "User clicks > 3 seeds ... Toast: 'Maximum 3 balls'; refuse 4th click"
      // Let's assume 3 balls total across all cameras for now as per section 8.
      const ballCount = new Set(state.seeds.map((s) => s.ballId)).size;
      if (ballCount >= 3 && !state.seeds.some((s) => s.ballId === seed.ballId)) {
        return state; // Should ideally show toast elsewhere
      }

      return {
        seeds: [
          ...state.seeds.filter((s) => s.ballId !== seed.ballId || s.cameraId !== seed.cameraId),
          seed,
        ],
      };
    }),

  removeSeed: (ballId, cameraId) =>
    set((state) => ({
      seeds: state.seeds.filter((s) => s.ballId !== ballId || s.cameraId !== cameraId),
    })),

  startTracking: () => set({ status: 'tracking', progress: 0 }),

  onTrackingUpdate: (tracks, progress) =>
    set({
      tracks,
      progress,
    }),

  onTrackingComplete: (tracks) =>
    set({
      tracks,
      status: 'complete',
      progress: 1.0,
    }),

  applyCorrection: (correction) =>
    set((state) => ({
      corrections: [...state.corrections, correction],
      status: 'tracking', // Usually triggers a re-track
    })),

  reset: () =>
    set({
      frameCount: 0,
      currentFrame: 0,
      seeds: [],
      tracks: [],
      corrections: [],
      status: 'idle',
      progress: 0,
    }),
}));
