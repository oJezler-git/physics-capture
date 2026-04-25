import { useEffect, useMemo, useRef, useState } from 'react';
import type { SyncMarkerRenderConfig, SyncMarkerCadenceMetrics } from '../lib/syncMarker';
import { SyncMarkerRenderer } from '../lib/syncMarker';

export function SyncMarkerComponent({ config }: { config?: Partial<SyncMarkerRenderConfig> }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isInterrupted, setIsInterrupted] = useState(false);
  const [metrics, setMetrics] = useState<SyncMarkerCadenceMetrics | null>(null);

  const mergedConfig: Partial<SyncMarkerRenderConfig> = useMemo(
    () => ({ ...config }),
    [JSON.stringify(config)],
  );

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const canvas = canvasRef.current;
    if (!wrapper || !canvas) return;

    const resizeCanvas = () => {
      const rect = wrapper.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width));
      canvas.height = Math.max(1, Math.floor(rect.height));
    };

    resizeCanvas();
    const observer = new ResizeObserver(resizeCanvas);
    observer.observe(wrapper);

    const renderer = new SyncMarkerRenderer(canvas, mergedConfig);
    renderer.start();

    const cadenceTimer = window.setInterval(() => {
      setMetrics(renderer.getCadenceMetrics());
    }, 1000);

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') {
        setIsInterrupted(true);
        // Freeze the marker so the timeline is obviously broken.
        renderer.stop();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.clearInterval(cadenceTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      observer.disconnect();
      renderer.stop();
    };
  }, [mergedConfig]);

  return (
    <div className="relative h-full w-full bg-black overflow-hidden rounded-2xl">
      <div ref={wrapperRef} className="h-full w-full">
        <canvas ref={canvasRef} className="h-full w-full" />
      </div>

      {isInterrupted && (
        <div className="absolute inset-0 grid place-items-center bg-black/90 p-6 text-center backdrop-blur-sm">
          <div className="max-w-md space-y-2">
            <p className="text-[10px] font-bold tracking-widest uppercase text-[var(--accent)]">
              Sync marker paused
            </p>
            <p className="text-xs text-slate-300">
              Tab backgrounded. Keep this visible during recording to maintain timing accuracy.
            </p>
          </div>
        </div>
      )}

      {import.meta.env.DEV && metrics && (
        <div className="pointer-events-none absolute bottom-2 right-2 rounded border border-white/10 bg-black/80 px-2 py-1 font-mono text-[9px] text-white/50 shadow-xl">
          rAF {metrics.intervalMs.toFixed(2)}ms | jitter {metrics.jitterMs.toFixed(2)}ms
        </div>
      )}
    </div>
  );
}
