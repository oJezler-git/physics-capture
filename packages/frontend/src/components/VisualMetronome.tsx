import React, { useEffect, useRef, useState } from 'react';

interface VisualMetronomeProps {
  isActive: boolean;
  onConfigReady: (config: { speed_px_per_frame: number; rAF_jitter_ms: number }) => void;
}

export const VisualMetronome: React.FC<VisualMetronomeProps> = ({ isActive, onConfigReady }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafIdRef = useRef<number>();
  const frameIndexRef = useRef(0);
  
  const [speedPxPerFrame, setSpeedPxPerFrame] = useState(0);
  const [jitter, setJitter] = useState(0);

  // Calibration: measure actual refresh rate
  useEffect(() => {
    const timestamps: number[] = [];
    const maxSamples = 120;

    const calibrate = (time: number) => {
      timestamps.push(time);
      if (timestamps.length < maxSamples) {
        rafIdRef.current = requestAnimationFrame(calibrate);
      } else {
        // Compute median interval
        const intervals: number[] = [];
        for (let i = 1; i < timestamps.length; i++) {
          intervals.push(timestamps[i] - timestamps[i - 1]);
        }
        intervals.sort((a, b) => a - b);
        const medianInterval = intervals[Math.floor(intervals.length / 2)];
        
        // Compute jitter (median absolute deviation)
        const deviations = intervals.map(i => Math.abs(i - medianInterval));
        deviations.sort((a, b) => a - b);
        const rAF_jitter_ms = deviations[Math.floor(deviations.length / 2)];

        // Target: 400 pixels per second
        const speed_px_per_second = 400;
        const speed_px_per_frame = speed_px_per_second / (1000 / medianInterval);

        setSpeedPxPerFrame(speed_px_per_frame);
        setJitter(rAF_jitter_ms);
        onConfigReady({ speed_px_per_frame, rAF_jitter_ms });
      }
    };

    rafIdRef.current = requestAnimationFrame(calibrate);
    return () => {
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
    };
  }, []);

  // Animation loop
  useEffect(() => {
    if (!isActive || speedPxPerFrame === 0) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Handle resize
    const resize = () => {
      canvas.width = canvas.parentElement?.clientWidth || window.innerWidth;
      canvas.height = canvas.parentElement?.clientHeight || 400;
    };
    resize();
    window.addEventListener('resize', resize);

    const dot_y = canvas.height * 0.2;
    const dot_r = 25;

    const tick = () => {
      const dot_x = (speedPxPerFrame * frameIndexRef.current) % canvas.width;
      
      // Clear
      ctx.fillStyle = '#0f172a'; // slate-900
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      // Draw Dot
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(dot_x, dot_y, dot_r, 0, Math.PI * 2);
      ctx.fill();
      
      // Draw Guide Text
      ctx.fillStyle = '#475569'; // slate-500
      ctx.font = 'bold 10px sans-serif';
      ctx.fillText('SYNC SIGNAL AREA', 20, dot_y - dot_r - 10);

      frameIndexRef.current++;
      rafIdRef.current = requestAnimationFrame(tick);
    };

    rafIdRef.current = requestAnimationFrame(tick);
    
    return () => {
      window.removeEventListener('resize', resize);
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
    };
  }, [isActive, speedPxPerFrame]);

  return (
    <div className="relative w-full h-full bg-slate-900 rounded-2xl overflow-hidden border border-slate-800 shadow-2xl">
      <canvas ref={canvasRef} className="w-full h-full" />
      {jitter > 2 && (
        <div className="absolute bottom-4 left-4 right-4 bg-yellow-500/10 border border-yellow-500/50 p-2 rounded text-[10px] text-yellow-500 font-bold uppercase tracking-widest text-center">
          Warning: High System Jitter ({jitter.toFixed(2)}ms)
        </div>
      )}
    </div>
  );
};
