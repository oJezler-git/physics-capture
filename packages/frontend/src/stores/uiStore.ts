import { create } from 'zustand';

export interface ToastMessage {
  id: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

interface UiState {
  toasts: ToastMessage[];
  pushToast: (level: ToastMessage['level'], message: string) => void;
  removeToast: (id: string) => void;
}

export const useUiStore = create<UiState>((set) => ({
  toasts: [],
  pushToast: (level, message) =>
    set((state) => ({
      toasts: [
        ...state.toasts,
        {
          id: crypto.randomUUID(),
          level,
          message,
        },
      ],
    })),
  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((toast) => toast.id !== id),
    })),
}));
