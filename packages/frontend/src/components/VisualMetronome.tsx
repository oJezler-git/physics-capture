import React, { useEffect, useRef } from 'react';
import { VisualMetronome } from '../lib/metronome';

export const VisualMetronomeComponent: React.FC = () => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

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

    const metronome = new VisualMetronome(canvas);
    metronome.start();

    return () => {
      observer.disconnect();
      metronome.stop();
    };
  }, []);

  return (
    <div ref={wrapperRef} className="h-full w-full overflow-hidden rounded-2xl border border-slate-800">
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
};
