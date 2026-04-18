import { create } from 'zustand';
import type { CameraDevice, BallMassConfig, SessionPhase } from '../types';

interface SessionState {
  experimentId: string | null;
  cameras: CameraDevice[]; // all registered cameras (PC + phones)
  ballConfigs: BallMassConfig[]; // 1–3 balls, mass + uncertainty
  phase: SessionPhase; // 'setup' | 'calibration' | 'recording' | 'tracking' | 'results'

  // Actions
  createExperiment: (id: string) => void;
  addCamera: (cam: CameraDevice) => void;
  removeCamera: (id: string) => void;
  setBallConfig: (index: number, config: BallMassConfig) => void;
  advancePhase: () => void;
  setPhase: (phase: SessionPhase) => void;
}

const PHASES: SessionPhase[] = ['setup', 'calibration', 'recording', 'tracking', 'results'];

export const useSessionStore = create<SessionState>((set) => ({
  experimentId: null,
  cameras: [],
  ballConfigs: [],
  phase: 'setup',

  createExperiment: (id) => set({ experimentId: id, phase: 'setup' }),

  addCamera: (cam) =>
    set((state) => {
      const existing = state.cameras.find((c) => c.id === cam.id);
      const mergedStatus: CameraDevice['status'] =
        cam.status === 'disconnected'
          ? 'disconnected'
          : cam.stream || existing?.stream
            ? 'live'
            : 'connecting';
      const nextCamera = existing
        ? {
            ...existing,
            ...cam,
            // Preserve an active stream when presence updates arrive without media.
            stream: cam.stream ?? existing.stream,
            status: mergedStatus,
          }
        : cam;

      return {
        cameras: [...state.cameras.filter((c) => c.id !== cam.id), nextCamera],
      };
    }),

  removeCamera: (id) =>
    set((state) => ({
      cameras: state.cameras.filter((c) => c.id !== id),
    })),

  setBallConfig: (index, config) =>
    set((state) => {
      const newConfigs = [...state.ballConfigs];
      newConfigs[index] = config;
      return { ballConfigs: newConfigs };
    }),

  advancePhase: () =>
    set((state) => {
      const currentIndex = PHASES.indexOf(state.phase);
      const nextPhase = PHASES[currentIndex + 1] || state.phase;
      return { phase: nextPhase };
    }),

  setPhase: (phase) => set({ phase }),
}));
