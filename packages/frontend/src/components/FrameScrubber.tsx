import React from 'react';
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
  variant?: 'wide' | 'compact';
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
  variant = 'wide',
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

  if (variant === 'compact') {
    return (
      <div className="space-y-6 rounded-[2rem] border border-[var(--line)] bg-[var(--bg-surface)] p-6 shadow-sm">
        <div className="flex items-center gap-4">
          {onPlayToggle && (
            <Button
              onClick={onPlayToggle}
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[var(--bg-panel)] border border-[var(--line)] text-xl shadow-sm transition-transform hover:scale-95"
            >
              {isPlaying ? '⏸' : '▶'}
            </Button>
          )}

          {onSpeedChange && (
            <div className="flex-1 space-y-2">
              <div className="flex justify-between text-[10px] font-medium tracking-wider uppercase text-slate-500">
                <span>Speed</span>
                <span className="text-[var(--accent)]">{playbackSpeed.toFixed(2)}x</span>
              </div>
              <input
                type="range"
                min="0.1"
                max="5.0"
                step="0.05"
                value={playbackSpeed}
                onChange={(e) => onSpeedChange(parseFloat(e.target.value))}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-[var(--bg-panel)] accent-[var(--accent)]"
              />
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex justify-between font-mono text-[10px] text-slate-500">
            <span className="text-slate-300">
              FRAME {currentFrame + 1} / {frameCount}
            </span>
            <span>{((currentFrame / Math.max(1, frameCount - 1)) * 100).toFixed(1)}%</span>
          </div>
          <div className="relative py-2">
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
          <div className="flex justify-between gap-2">
            <Button
              onClick={decrementFrame}
              className="flex-1 rounded-xl bg-[var(--bg-panel)] py-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-400 transition-colors hover:text-slate-200"
            >
              Prev
            </Button>
            <Button
              onClick={incrementFrame}
              className="flex-1 rounded-xl bg-[var(--bg-panel)] py-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-400 transition-colors hover:text-slate-200"
            >
              Next
            </Button>
          </div>
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
