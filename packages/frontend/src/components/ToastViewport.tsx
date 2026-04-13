import { useEffect } from 'react';
import { useUiStore } from '../stores/uiStore';

const levelStyles = {
  info: 'border-sky-500/40 bg-sky-500/10 text-sky-100',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-100',
  error: 'border-red-500/40 bg-red-500/10 text-red-100',
  success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100',
};

export const ToastViewport = () => {
  const { toasts, removeToast } = useUiStore();

  useEffect(() => {
    const timers = toasts.map((toast) =>
      setTimeout(() => {
        removeToast(toast.id);
      }, 4500),
    );

    return () => timers.forEach((timer) => clearTimeout(timer));
  }, [toasts, removeToast]);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-[320px] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto rounded-xl border px-3 py-2 text-sm shadow-2xl ${levelStyles[toast.level]}`}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
};
