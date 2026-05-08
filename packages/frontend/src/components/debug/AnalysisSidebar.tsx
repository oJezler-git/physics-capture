import { FrameScrubber } from '../FrameScrubber';
import { Button } from '../ui/Button';
import { formatWithUncertainty } from '../../lib/diagnostics';
import type { PhysicsResult } from '../../types';

interface AnalysisSidebarProps {
  currentFrame: number;
  frameCount: number;
  onFrameChange: (frame: number) => void;
  isPlaying: boolean;
  onPlayToggle: () => void;
  playbackSpeed: number;
  onSpeedChange: (speed: number) => void;
  seedMode: 'click' | 'bbox';
  onSeedModeChange: (mode: 'click' | 'bbox') => void;
  seedsCount: number;
  maxBalls: number;
  dims: { width: number; height: number };
  status: string;
  progress: number;
  physicsResult: PhysicsResult | null;
  physicsStatus: string;
  physicsError: string | null;
}

export const AnalysisSidebar = ({
  currentFrame,
  frameCount,
  onFrameChange,
  isPlaying,
  onPlayToggle,
  playbackSpeed,
  onSpeedChange,
  seedMode,
  onSeedModeChange,
  seedsCount,
  maxBalls,
  dims,
  status,
  progress,
  physicsResult,
  physicsStatus,
  physicsError,
}: AnalysisSidebarProps) => {
  return (
    <>
      <section>
        <FrameScrubber
          currentFrame={currentFrame}
          frameCount={frameCount}
          onFrameChange={onFrameChange}
          isPlaying={isPlaying}
          onPlayToggle={onPlayToggle}
          playbackSpeed={playbackSpeed}
          onSpeedChange={onSpeedChange}
          variant="timeline"
        />
      </section>

      <section className="space-y-4">
        <h3 className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
          Seed Controls
        </h3>
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 rounded-2xl border border-[var(--line)] bg-[var(--bg-panel)] p-2">
            <Button
              type="button"
              onClick={() => onSeedModeChange('click')}
              className={`flex-1 rounded-xl py-2.5 text-[10px] font-medium uppercase tracking-wider transition ${
                seedMode === 'click'
                  ? 'bg-[var(--accent)] text-zinc-950 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Tap
            </Button>
            <Button
              type="button"
              onClick={() => onSeedModeChange('bbox')}
              className={`flex-1 rounded-xl py-2.5 text-[10px] font-medium uppercase tracking-wider transition ${
                seedMode === 'bbox'
                  ? 'bg-[var(--accent)] text-zinc-950 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Box
            </Button>
          </div>

          <div className="rounded-[2rem] border border-[var(--line)] bg-[var(--bg-panel)] p-5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
                Seeds Placed
              </span>
              <span className="rounded-md bg-[var(--accent)]/10 border border-[var(--accent)]/50 px-2.5 py-1 font-mono text-[11px] text-[var(--accent)] font-medium">
                {seedsCount} / {maxBalls}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-6">
        <h3 className="text-[10px] font-medium uppercase tracking-wider text-slate-400">Monitor</h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-[2rem] bg-[var(--bg-panel)] p-5 border border-[var(--line)]">
            <span className="block text-[10px] text-slate-400 font-medium tracking-wider uppercase">
              Res
            </span>
            <span className="text-lg font-medium text-slate-200 mt-1">
              {dims.width}x{dims.height}
            </span>
          </div>
          <div className="rounded-[2rem] bg-[var(--bg-panel)] p-5 border border-[var(--line)]">
            <span className="block text-[10px] text-slate-400 font-medium tracking-wider uppercase">
              Status
            </span>
            <span className="text-[10px] font-medium tracking-wider uppercase text-[var(--accent)] truncate mt-1.5 block">
              {status}
            </span>
          </div>
        </div>
        {status === 'tracking' && (
          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between text-[10px] font-medium uppercase tracking-wider text-[var(--accent)]">
              <span>Analyzing Video</span>
              <span className="font-mono">{Math.round(progress * 100)}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full border border-[var(--line)] bg-[var(--bg-base)]">
              <div
                className="h-full bg-[var(--accent)] transition-all duration-300"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
          </div>
        )}
      </section>

      <section className="space-y-6">
        <h3 className="text-[10px] font-medium uppercase tracking-wider text-slate-400">Physics</h3>
        {physicsError && (
          <div className="rounded-xl border border-[var(--accent)] bg-[var(--accent)]/10 px-4 py-3 text-xs font-medium text-[var(--accent)] shadow-sm">
            <span className="font-bold opacity-70 mr-2">ERROR:</span>
            {physicsError}
          </div>
        )}
        {physicsStatus === 'computing' ? (
          <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-5 text-xs font-medium text-sky-200 shadow-sm">
            Recomputing physics...
          </div>
        ) : physicsResult ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl border border-[var(--line)] bg-[var(--bg-panel)] p-4">
                <span className="block text-[10px] uppercase tracking-wider font-medium text-slate-400">
                  Momentum
                </span>
                <span className="mt-1 block text-sm font-semibold text-slate-100">
                  {formatWithUncertainty(
                    physicsResult.system.momentum_conserved_pct.value,
                    physicsResult.system.momentum_conserved_pct.uncertainty,
                    1,
                  )}
                  %
                </span>
              </div>
              <div className="rounded-2xl border border-[var(--line)] bg-[var(--bg-panel)] p-4">
                <span className="block text-[10px] uppercase tracking-wider font-medium text-slate-400">
                  Restitution
                </span>
                <span className="mt-1 block text-sm font-semibold text-slate-100">
                  {formatWithUncertainty(
                    physicsResult.system.coeff_of_restitution.value,
                    physicsResult.system.coeff_of_restitution.uncertainty,
                    3,
                  )}
                </span>
              </div>
            </div>

            <div className="space-y-2">
              {physicsResult.balls.map((ball) => (
                <div
                  key={`debug-physics-ball-${ball.ballId}`}
                  className="rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] px-4 py-2 text-[11px] text-slate-300 flex items-center justify-between"
                >
                  <span className="font-medium uppercase tracking-wider text-slate-400">
                    Ball {ball.ballId + 1}
                  </span>
                  <span className="font-mono text-[10px] text-slate-300">
                    {ball.v_before.value.toFixed(2)} → {ball.v_after.value.toFixed(2)} m/s
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-3xl border border-dashed border-[var(--line)] bg-[var(--bg-panel)] px-6 py-8 text-center text-[11px] font-medium tracking-wide text-slate-400">
            Run SAM2 tracking first.
          </div>
        )}
      </section>
    </>
  );
};
