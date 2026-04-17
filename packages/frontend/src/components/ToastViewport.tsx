import { useEffect } from 'react';
import { useUiStore } from '../stores/uiStore';

const levelStyles = {
  info: 'border-sky-400/40 bg-sky-400/10 text-sky-100',
  warn: 'border-amber-400/45 bg-amber-400/10 text-amber-100',
  error: 'border-rose-400/45 bg-rose-400/10 text-rose-100',
  success: 'border-lime-400/40 bg-lime-400/10 text-lime-100',
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
    <div className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-[340px] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto rounded-2xl border px-4 py-3 text-sm shadow-2xl backdrop-blur-xl ${levelStyles[toast.level]}`}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
};
