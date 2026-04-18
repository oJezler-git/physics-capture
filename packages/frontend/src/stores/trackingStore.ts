import { create } from 'zustand';
import type { BallSeed, BallTrack, CorrectionKeyframe } from '../types';

interface TrackingState {
  frameCount: number;
  currentFrame: number; // 0-indexed, scrubber position
  seeds: BallSeed[]; // user-placed seeds
  tracks: BallTrack[]; // SAM2 output per ball per camera
  corrections: CorrectionKeyframe[]; // user corrections
  status: 'idle' | 'tracking' | 'complete' | 'awaiting_correction';
  progress: number; // 0.0-1.0

  // Actions
  setFrameCount: (n: number) => void;
  setFrame: (n: number) => void;
  addSeed: (seed: BallSeed, maxBalls?: number) => boolean;
  removeSeed: (ballId: number, cameraId: string) => void;
  startTracking: () => void;
  setStatus: (status: TrackingState['status'], progress?: number) => void;
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

  addSeed: (seed, maxBalls = 3) => {
    let accepted = false;

    set((state) => {
      const cameraSeeds = state.seeds.filter((entry) => entry.cameraId === seed.cameraId);
      const hasExistingBallSeed = cameraSeeds.some((entry) => entry.ballId === seed.ballId);
      const uniqueBallCount = new Set(cameraSeeds.map((entry) => entry.ballId)).size;

      if (!hasExistingBallSeed && uniqueBallCount >= maxBalls) {
        return state;
      }

      accepted = true;

      return {
        seeds: [
          ...state.seeds.filter(
            (entry) => !(entry.ballId === seed.ballId && entry.cameraId === seed.cameraId),
          ),
          seed,
        ],
      };
    });

    return accepted;
  },

  removeSeed: (ballId, cameraId) =>
    set((state) => ({
      seeds: state.seeds.filter((s) => s.ballId !== ballId || s.cameraId !== cameraId),
    })),

  startTracking: () => set({ status: 'tracking', progress: 0 }),

  setStatus: (status, progress) =>
    set((state) => ({
      status,
      progress: progress ?? state.progress,
    })),

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
      corrections: [
        ...state.corrections.filter(
          (entry) =>
            !(
              entry.ballId === correction.ballId &&
              entry.cameraId === correction.cameraId &&
              entry.frameIdx === correction.frameIdx
            ),
        ),
        correction,
      ],
      tracks: state.tracks.map((track) => {
        if (track.ballId !== correction.ballId || track.cameraId !== correction.cameraId) {
          return track;
        }

        return {
          ...track,
          points: track.points.map((point) => {
            if (point.frameIdx !== correction.frameIdx) {
              return point;
            }

            return {
              ...point,
              x: correction.x_new,
              y: correction.y_new,
              isCorrected: true,
            };
          }),
        };
      }),
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
