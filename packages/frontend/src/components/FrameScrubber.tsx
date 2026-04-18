import React from 'react';

interface FrameScrubberProps {
  currentFrame: number;
  frameCount: number;
  onFrameChange: (frame: number) => void;
  isPlaying?: boolean;
  onPlayToggle?: () => void;
  flaggedFrames?: number[];
}

export const FrameScrubber: React.FC<FrameScrubberProps> = ({
  currentFrame,
  frameCount,
  onFrameChange,
  isPlaying,
  onPlayToggle,
  flaggedFrames = [],
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
