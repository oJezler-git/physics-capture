import React, { useEffect, useRef } from 'react';
import { VisualMetronome } from '../lib/metronome';

export const VisualMetronomeComponent: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Set canvas internal resolution to match physical size
    canvas.width = window.innerWidth;
    canvas.height = 120;

    const metronome = new VisualMetronome(canvas);
    metronome.start();

    return () => {
      metronome.stop();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        width: '100vw',
        height: '120px',
        zIndex: 9999,
      }}
    />
  );
};
