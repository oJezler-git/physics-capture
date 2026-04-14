import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Camera,
  ChevronRight,
  Maximize2,
  MousePointer2,
  RefreshCw,
  Settings2,
  Zap,
} from 'lucide-react';
import { BallSeedPicker } from '../components/BallSeedPicker';
import { FrameScrubber } from '../components/FrameScrubber';
import { TrajectoryCanvas } from '../components/TrajectoryCanvas';
import { useSessionStore } from '../stores/sessionStore';
import { useTrackingStore } from '../stores/trackingStore';
import type { CorrectionKeyframe } from '../types';

const FRAME_WIDTH = 1280;
const FRAME_HEIGHT = 720;

export const TrackingPage = () => {
  const { cameras, advancePhase, experimentId } = useSessionStore();
  const {
    frameCount,
    currentFrame,
    setFrame,
    tracks,
    status,
    progress,
    seeds,
    startTracking,
    addSeed,
    applyCorrection,
  } = useTrackingStore();

  const [isPlaying, setIsPlaying] = useState(false);
  const [activeCameraId, setActiveCameraId] = useState<string | null>(null);
  const [trackingError, setTrackingError] = useState<string | null>(null);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resolvedActiveCameraId = activeCameraId ?? cameras[0]?.id ?? null;
  const correctionEnabled = tracks.length > 0 && status !== 'tracking';
  const seedInteractive = currentFrame === 0 && tracks.length === 0 && status !== 'tracking';

  useEffect(() => {
    if (isPlaying && frameCount > 0) {
      playRef.current = setInterval(() => {
        setFrame((currentFrame + 1) % frameCount);
      }, 100);
    } else if (playRef.current) {
      clearInterval(playRef.current);
    }

    return () => {
      if (playRef.current) {
        clearInterval(playRef.current);
      }
    };
  }, [isPlaying, currentFrame, frameCount, setFrame]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        event.preventDefault();
        setIsPlaying((playing) => !playing);
      } else if (event.code === 'ArrowRight') {
        setFrame(Math.min(currentFrame + 1, Math.max(frameCount - 1, 0)));
      } else if (event.code === 'ArrowLeft') {
        setFrame(Math.max(currentFrame - 1, 0));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentFrame, frameCount, setFrame]);

  const activeCamera = cameras.find((camera) => camera.id === resolvedActiveCameraId);

  const handleCorrection = async (correction: CorrectionKeyframe) => {
    applyCorrection(correction);
    setTrackingError(null);

    if (!experimentId) {
      return;
    }

    try {
      const response = await fetch(`/api/experiments/${experimentId}/correct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(correction),
      });

      if (!response.ok) {
        throw new Error(`Correction request failed (${response.status})`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to apply correction';
      setTrackingError(message);
    }
  };

  return (
    <div className="mx-auto flex h-[calc(100vh-120px)] max-w-[1600px] flex-col gap-6">
      <header className="flex items-center justify-between rounded-2xl border border-slate-800 bg-slate-900 p-4 shadow-xl">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/20 p-2.5">
              <MousePointer2 size={20} className="text-indigo-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">Point Tracking</h1>
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                Review & Correct Trajectories
              </p>
            </div>
          </div>

          <div className="h-10 w-px bg-slate-800" />

          <div className="flex items-center gap-4">
            <div className="flex flex-col">
              <span className="text-[9px] font-bold uppercase tracking-tighter text-slate-500">
                Current Status
              </span>
              <div className="flex items-center gap-2">
                <div
                  className={`h-2 w-2 rounded-full ${status === 'tracking' ? 'animate-pulse bg-yellow-500' : 'bg-emerald-500'}`}
                />
                <span className="text-sm font-bold capitalize">{status}</span>
              </div>
            </div>
            {status === 'tracking' && (
              <div className="h-2 w-48 overflow-hidden rounded-full border border-slate-700 bg-slate-800">
                <div
                  className="h-full bg-indigo-500 transition-all duration-300"
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button className="rounded-xl border border-transparent p-3 text-slate-400 transition-all hover:border-slate-700 hover:bg-slate-800 hover:text-white">
            <RefreshCw size={20} />
          </button>
          <button
            onClick={advancePhase}
            className="flex items-center gap-2 rounded-xl bg-indigo-600 px-6 py-3 font-bold text-white shadow-lg shadow-indigo-500/20 transition-all hover:bg-indigo-500"
          >
            Finalize Data <ChevronRight size={18} />
          </button>
        </div>
      </header>

      {trackingError ? (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {trackingError}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 lg:grid-cols-4">
        <div className="flex min-h-0 flex-col gap-4 lg:col-span-3">
          <div className="group relative flex-1 overflow-hidden rounded-2xl border border-slate-800 bg-black shadow-2xl">
            <div className="relative flex h-full w-full items-center justify-center p-4">
              <div className="relative aspect-video h-full max-h-full w-full max-w-full overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950">
                <div className="pointer-events-none absolute inset-0 grid place-items-center text-7xl font-black italic uppercase text-slate-800/40 lg:text-9xl">
                  Frame {currentFrame}
                </div>

                <TrajectoryCanvas
                  tracks={tracks}
                  currentFrame={currentFrame}
                  cameraId={resolvedActiveCameraId || ''}
                  width={FRAME_WIDTH}
                  height={FRAME_HEIGHT}
                  correctionEnabled={correctionEnabled}
                  onCorrection={handleCorrection}
                />

                <BallSeedPicker
                  cameraId={resolvedActiveCameraId}
                  currentFrame={currentFrame}
                  frameWidth={FRAME_WIDTH}
                  frameHeight={FRAME_HEIGHT}
                  seeds={seeds}
                  onAddSeed={addSeed}
                  interactive={seedInteractive}
                  className="relative h-full w-full cursor-crosshair"
                />
              </div>
            </div>

            <div className="absolute left-4 top-4 flex gap-2">
              <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/60 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest backdrop-blur-md">
                <Camera size={14} className="text-indigo-400" />
                {activeCamera?.label || 'No Camera Selected'}
              </div>
              <div className="rounded-lg border border-white/10 bg-black/60 px-3 py-1.5 font-mono text-[10px] text-indigo-400 backdrop-blur-md">
                {currentFrame} / {frameCount}
              </div>
            </div>

            <div className="absolute right-4 top-4 flex gap-2 opacity-0 transition-opacity group-hover:opacity-100">
              <button className="rounded-lg border border-white/10 bg-black/60 p-2 text-white backdrop-blur-md transition-colors hover:bg-indigo-500">
                <Maximize2 size={18} />
              </button>
              <button className="rounded-lg border border-white/10 bg-black/60 p-2 text-white backdrop-blur-md transition-colors hover:bg-indigo-500">
                <Settings2 size={18} />
              </button>
            </div>

            <div className="absolute bottom-4 right-4 flex gap-4 rounded-xl border border-white/10 bg-black/60 px-4 py-2 backdrop-blur-md">
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 rounded-full bg-blue-500" />
                <span className="text-[10px] font-bold uppercase tracking-tighter text-slate-300">
                  Ball 1
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 rounded-full bg-emerald-500" />
                <span className="text-[10px] font-bold uppercase tracking-tighter text-slate-300">
                  Ball 2
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 rounded-full bg-amber-500" />
                <span className="text-[10px] font-bold uppercase tracking-tighter text-slate-300">
                  Ball 3
                </span>
              </div>
            </div>
          </div>

          <FrameScrubber
            currentFrame={currentFrame}
            frameCount={Math.max(frameCount, 1)}
            onFrameChange={setFrame}
            isPlaying={isPlaying}
            onPlayToggle={() => setIsPlaying((playing) => !playing)}
          />
        </div>

        <div className="custom-scrollbar flex min-h-0 flex-col gap-6 overflow-y-auto pr-2">
          <div className="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-4 shadow-lg">
            <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">
              Active Camera
            </h3>
            <div className="space-y-2">
              {cameras.map((camera) => (
                <button
                  key={camera.id}
                  onClick={() => setActiveCameraId(camera.id)}
                  className={`w-full rounded-xl border p-3 transition-all ${
                    resolvedActiveCameraId === camera.id
                      ? 'border-indigo-500/50 bg-indigo-500/10 text-indigo-400'
                      : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Camera size={16} />
                      <span className="text-sm font-bold">{camera.label}</span>
                    </div>
                    {resolvedActiveCameraId === camera.id && (
                      <div className="h-1.5 w-1.5 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.8)]" />
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-5 rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-lg">
            <div className="flex items-center justify-between">
              <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">
                Tracking Logic
              </h3>
              <div className="rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-black italic text-emerald-500">
                SAM-2
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-950 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase text-slate-400">
                    Seeds Placed
                  </span>
                  <span className="rounded border border-slate-700 bg-slate-800 px-2 py-0.5 font-mono text-xs text-white">
                    {seeds.filter((seed) => seed.cameraId === resolvedActiveCameraId).length} / 3
                  </span>
                </div>
                <div className="text-[10px] italic leading-relaxed text-slate-500">
                  * Place seeds on frame 0. Drag trajectory points to apply corrections after
                  tracking.
                </div>
              </div>

              <button
                disabled={seeds.length === 0 || status === 'tracking'}
                onClick={startTracking}
                className={`w-full rounded-xl py-4 font-bold transition-all ${
                  seeds.length > 0 && status !== 'tracking'
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20 hover:bg-indigo-500'
                    : 'cursor-not-allowed border border-slate-700 bg-slate-800 text-slate-500'
                }`}
              >
                <span className="flex items-center justify-center gap-2">
                  <Zap size={18} fill={seeds.length > 0 ? 'white' : 'none'} />
                  Run Auto-Tracker
                </span>
              </button>
            </div>
          </div>

          {tracks.length > 0 && (
            <div className="flex flex-col gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 p-4">
              <div className="flex items-center gap-2 text-red-500">
                <AlertCircle size={16} />
                <h3 className="text-[10px] font-black uppercase tracking-widest">
                  Confidence Alerts
                </h3>
              </div>
              <p className="text-[10px] leading-tight text-red-200/60">
                Points in red show low SAM2 confidence. Scrub to those frames and apply corrections.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
