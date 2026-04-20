import React from 'react';

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
      <div className="space-y-6 rounded-2xl border border-slate-800 bg-slate-950 p-5">
        <div className="flex items-center gap-4">
          {onPlayToggle && (
            <button
              onClick={onPlayToggle}
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-slate-800 border border-slate-700 text-xl shadow-lg hover:bg-slate-700"
            >
              {isPlaying ? '⏸' : '▶'}
            </button>
          )}

          {onSpeedChange && (
            <div className="flex-1 space-y-2">
              <div className="flex justify-between text-[10px] font-bold uppercase tracking-widest text-slate-500">
                <span>Speed</span>
                <span className="text-orange-500">{playbackSpeed.toFixed(2)}x</span>
              </div>
              <input
                type="range"
                min="0.1"
                max="5.0"
                step="0.05"
                value={playbackSpeed}
                onChange={(e) => onSpeedChange(parseFloat(e.target.value))}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-slate-800 accent-orange-500"
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
              className="relative z-10 h-2 w-full cursor-pointer appearance-none rounded-full bg-slate-800 accent-orange-500"
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
          <div className="flex justify-between gap-1">
            <button
              onClick={decrementFrame}
              className="flex-1 rounded bg-slate-900 py-1 text-[9px] font-bold uppercase text-slate-500 hover:bg-slate-800"
            >
              Prev
            </button>
            <button
              onClick={incrementFrame}
              className="flex-1 rounded bg-slate-900 py-1 text-[9px] font-bold uppercase text-slate-500 hover:bg-slate-800"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="surface-panel rise-in flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        {onPlayToggle ? (
          <button
            onClick={onPlayToggle}
            className="btn-main min-w-[7rem] px-4 py-2 text-[11px] tracking-[0.18em]"
          >
            {isPlaying ? 'PAUSE' : 'PLAY'}
          </button>
        ) : null}

        <div className="surface-soft flex items-center gap-1 p-1">
          <button
            onClick={decrementFrame}
            className="rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-300 transition hover:bg-slate-800 hover:text-white"
          >
            Prev
          </button>
          <div className="min-w-[7.5rem] px-3 text-center font-mono text-sm text-slate-200">
            {currentFrame + 1} / {frameCount}
          </div>
          <button
            onClick={incrementFrame}
            className="rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-300 transition hover:bg-slate-800 hover:text-white"
          >
            Next
          </button>
        </div>

        <div className="relative min-w-[220px] flex-1 py-4">
          <input
            type="range"
            min="0"
            max={Math.max(0, frameCount - 1)}
            value={currentFrame}
            onChange={handleSliderChange}
            className="relative z-10 h-2 w-full cursor-pointer appearance-none rounded-full bg-slate-800 accent-orange-500"
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
