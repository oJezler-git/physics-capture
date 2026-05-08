import React, { useMemo } from 'react';
import { Button } from './ui/Button';

interface FrameScrubberProps {
  currentFrame: number;
  frameCount: number;
  onFrameChange: (frame: number) => void;
  isPlaying?: boolean;
  onPlayToggle?: () => void;
  flaggedFrames?: number[];
  playbackSpeed?: number;
  onSpeedChange?: (speed: number) => void;
  variant?: 'wide' | 'compact' | 'timeline';
}

export const FrameScrubber: React.FC<FrameScrubberProps> = ({
  currentFrame,
  frameCount,
  onFrameChange,
  isPlaying,
  onPlayToggle,
  flaggedFrames = [],
  playbackSpeed = 1,
  onSpeedChange,
  variant = 'timeline',
}) => {
  const handleSliderChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    onFrameChange(parseInt(event.target.value, 10));
  };

  const incrementFrame = () => {
    if (currentFrame < frameCount - 1) onFrameChange(currentFrame + 1);
  };

  const decrementFrame = () => {
    if (currentFrame > 0) onFrameChange(currentFrame - 1);
  };

  // Generate ticks for the timeline
  const ticks = useMemo(() => {
    if (frameCount <= 0) return [];
    const count = Math.min(frameCount, 50); // Limit ticks for performance
    const step = Math.max(1, Math.floor(frameCount / count));
    return Array.from({ length: Math.ceil(frameCount / step) }, (_, i) => i * step);
  }, [frameCount]);

  if (variant === 'timeline' || variant === 'compact') {
    return (
      <div className="flex flex-col gap-3 rounded-2xl border border-[var(--line)] bg-[var(--bg-panel)] p-4 shadow-sm">
        {/* Controls Row */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {onPlayToggle && (
              <Button
                onClick={onPlayToggle}
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)] text-zinc-950 shadow-sm transition-transform active:scale-90"
              >
                {isPlaying ? (
                  <span className="text-[10px] tracking-tighter">||</span>
                ) : (
                  <span className="ml-0.5 text-xs">▶</span>
                )}
              </Button>
            )}
            <div className="flex items-center gap-1 px-2 py-1 rounded-md bg-slate-900/50 border border-slate-800">
              <span className="font-mono text-[10px] font-bold text-slate-200">
                {String(currentFrame).padStart(3, '0')}
              </span>
              <span className="text-[10px] text-slate-600">/</span>
              <span className="font-mono text-[10px] text-slate-500">
                {String(frameCount).padStart(3, '0')}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex gap-1">
              <Button
                onClick={decrementFrame}
                className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-800 bg-slate-900/50 text-[9px] font-bold text-slate-500 hover:text-slate-200 transition-colors"
              >
                -1
              </Button>
              <Button
                onClick={incrementFrame}
                className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-800 bg-slate-900/50 text-[9px] font-bold text-slate-500 hover:text-slate-200 transition-colors"
              >
                +1
              </Button>
            </div>

            {onSpeedChange && (
              <select
                value={playbackSpeed}
                onChange={(e) => onSpeedChange(parseFloat(e.target.value))}
                className="appearance-none rounded-md border border-slate-800 bg-slate-900/50 px-2 py-1 font-mono text-[9px] font-bold text-[var(--accent)] outline-none hover:border-[var(--accent)] transition-colors cursor-pointer"
              >
                <option value="0.1">0.1x</option>
                <option value="0.25">0.25x</option>
                <option value="0.5">0.5x</option>
                <option value="1">1.0x</option>
                <option value="2">2.0x</option>
                <option value="5">5.0x</option>
              </select>
            )}
          </div>
        </div>

        {/* Scrubber Row */}
        <div className="relative group">
          {/* Timeline background with ticks */}
          <div className="absolute inset-x-0 top-1/2 h-4 -translate-y-1/2 overflow-hidden rounded-md border border-slate-800/50 bg-slate-900/30">
            <div className="relative h-full w-full opacity-20">
              {ticks.map((t) => (
                <div
                  key={`tick-${t}`}
                  className="absolute bottom-0 w-[1px] bg-slate-400"
                  style={{
                    left: `${(t / Math.max(1, frameCount - 1)) * 100}%`,
                    height: t % Math.max(1, Math.floor(frameCount / 10)) === 0 ? '60%' : '30%',
                  }}
                />
              ))}
            </div>

            {/* Flagged frames */}
            {flaggedFrames.map((f) => (
              <div
                key={`flag-${f}`}
                className="absolute inset-y-0 w-1 bg-rose-500/40"
                style={{ left: `${(f / Math.max(1, frameCount - 1)) * 100}%` }}
              />
            ))}
          </div>

          <input
            type="range"
            min="0"
            max={Math.max(0, frameCount - 1)}
            value={currentFrame}
            onChange={handleSliderChange}
            className="timeline-slider relative z-10 h-6 w-full cursor-pointer appearance-none bg-transparent"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="surface-panel rise-in flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        {onPlayToggle && (
          <Button variant="main" onClick={onPlayToggle} className="min-w-[7rem]">
            {isPlaying ? 'PAUSE' : 'PLAY'}
          </Button>
        )}

        <div className="surface-soft flex items-center gap-1 p-1">
          <Button
            onClick={decrementFrame}
            className="rounded-xl px-4 py-2 text-xs font-medium uppercase tracking-wider text-slate-400 transition hover:bg-[var(--bg-panel)] hover:text-slate-100"
          >
            Prev
          </Button>
          <div className="min-w-[7.5rem] px-3 text-center font-mono text-sm text-slate-200">
            {currentFrame + 1} / {frameCount}
          </div>
          <Button
            onClick={incrementFrame}
            className="rounded-xl px-4 py-2 text-xs font-medium uppercase tracking-wider text-slate-400 transition hover:bg-[var(--bg-panel)] hover:text-slate-100"
          >
            Next
          </Button>
        </div>

        <div className="relative min-w-[220px] flex-1 py-4">
          <input
            type="range"
            min="0"
            max={Math.max(0, frameCount - 1)}
            value={currentFrame}
            onChange={handleSliderChange}
            className="relative z-10 h-2 w-full cursor-pointer appearance-none rounded-full bg-[var(--bg-panel)] accent-[var(--accent)]"
          />
          {/* Issue markers */}
          <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 items-center px-[4px]">
            {flaggedFrames.map((f) => {
              const left = (f / Math.max(1, frameCount - 1)) * 100;
              return (
                <div
                  key={`flag-${f}`}
                  className="absolute h-4 w-1 bg-rose-500 opacity-60"
                  style={{ left: `${left}%` }}
                />
              );
            })}
          </div>
        </div>
      </div>

      <div className="eyebrow flex flex-wrap gap-4 text-[9px]">
        <span>SPACE: PLAY/PAUSE</span>
        <span>LEFT/RIGHT: STEP FRAMES</span>
        <span className="text-rose-400">RED DASHES: LOW CONFIDENCE</span>
      </div>
    </div>
  );
};
