import { create } from 'zustand';
import type { PhysicsResult, SyncData } from '../types';

interface ResultsState {
  physicsResult: PhysicsResult | null;
  syncData: SyncData | null;         // master timestamp array metadata
  status: 'idle' | 'computing' | 'complete' | 'failed';

  // Actions
  requestPhysics: () => void;
  onPhysicsResult: (result: PhysicsResult) => void;
  onPhysicsFailed: (error: string) => void;
  setSyncData: (data: SyncData) => void;
  reset: () => void;
}

export const useResultsStore = create<ResultsState>((set) => ({
  physicsResult: null,
  syncData: null,
  status: 'idle',

  requestPhysics: () => set({ status: 'computing' }),
  
  onPhysicsResult: (result) => set({
    physicsResult: result,
    status: 'complete',
  }),
  
  onPhysicsFailed: (_error) => set({ status: 'failed' }),
  
  setSyncData: (data) => set({ syncData: data }),

  reset: () => set({
    physicsResult: null,
    syncData: null,
    status: 'idle',
  }),
}));
