import { useEffect, useState, useCallback } from 'react';
import { BallSeedPicker, type SeedMode } from '../components/BallSeedPicker';
import { FrameScrubber } from '../components/FrameScrubber';
import { TrajectoryCanvas } from '../components/TrajectoryCanvas';
import { SyncDebugView } from '../components/SyncDebugView';
import { useResultsStore } from '../stores/resultsStore';
import { useTrackingStore } from '../stores/trackingStore';
import { useSessionStore } from '../stores/sessionStore';
import type { PhysicsResult } from '../types';

type DebugMode = 'sam2' | 'sync';

const formatWithUncertainty = (value: number, uncertainty: number, digits = 3) =>
  `${value.toFixed(digits)} +/- ${uncertainty.toFixed(digits)}`;

const DEFAULT_MASS_G = 50;
const DEFAULT_MASS_UNCERTAINTY_G = 1;

export const DebugPage = () => {
  const [experiments, setExperiments] = useState<string[]>([]);
  const [selectedExp, setSelectedExp] = useState<string>('');
  const [mode, setMode] = useState<DebugMode>('sam2');
  const [frameImageState, setFrameImageState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [dims, setDims] = useState({ width: 1280, height: 720 });
  const [selectedModel, setSelectedModel] = useState<string>('facebook/sam2-hiera-tiny');
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [seedMode, setSeedMode] = useState<SeedMode>('click');
  const [physicsError, setPhysicsError] = useState<string | null>(null);

  const {
    seeds,
    addSeed,
    tracks,
    onTrackingComplete,
    currentFrame,
    setFrame,
    frameCount,
    setFrameCount,
    frameMap,
    setFrameMap,
    status,
    setStatus,
    progress,
    reset: resetTracking,
  } = useTrackingStore();
  const {
    physicsResult,
    status: physicsStatus,
    requestPhysics,
    onPhysicsResult,
    onPhysicsFailed,
    reset: resetPhysics,
  } = useResultsStore();

  const { ballConfigs } = useSessionStore();

  // Load experiments list
  const fetchExperiments = useCallback(async () => {
    try {
      const res = await fetch('/api/experiments');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setExperiments(data);
    } catch (err) {
      console.error('Failed to fetch experiments', err);
    }
  }, []);

  useEffect(() => {
    fetchExperiments();
  }, [fetchExperiments]);

  // Adjust frame count when experiment is selected
  useEffect(() => {
    resetPhysics();
    setPhysicsError(null);

    if (!selectedExp) {
      setFrameCount(1);
      setFrameMap([]);
      return;
    }
    const loadMeta = async () => {
      try {
        const res = await fetch(`/api/experiments/${selectedExp}/metadata`);
        if (res.ok) {
          const data = await res.json();
          setFrameCount(data.frameCount || 1);
          setFrameMap(data.frameMap || [], data.sequenceToPhysical || []);
        }
      } catch (err) {
        console.error('Failed to load metadata:', err);
      }
    };
    loadMeta();
  }, [selectedExp, resetPhysics, setFrameCount, setFrameMap]);

  // Playback engine
  useEffect(() => {
    if (!isPlaying) return;
    const interval = setInterval(
      () => {
        setFrame((prev) => (prev + 1) % (frameCount || 1));
      },
      1000 / (30 * playbackSpeed),
    );
    return () => clearInterval(interval);
  }, [isPlaying, playbackSpeed, frameCount, setFrame]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;

      if (e.code === 'Space') {
        e.preventDefault();
        setIsPlaying((p) => !p);
      } else if (e.code === 'ArrowRight') {
        setFrame((f) => Math.min(frameCount - 1, f + 1));
      } else if (e.code === 'ArrowLeft') {
        setFrame((f) => Math.max(0, f - 1));
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [frameCount, setFrame]);

  const safeFrame = isNaN(currentFrame) ? 0 : currentFrame;
  const frameFile = frameMap[safeFrame];
  const frameSrc =
    selectedExp && frameFile ? `/api/experiments/${selectedExp}/frames/0/${frameFile}` : null;
  const maxBalls = ballConfigs.filter((c) => c.mass_g > 0).length || 2;
  const isFrameMissing = selectedExp && !frameFile;
  const actualFileCount = frameMap.filter(Boolean).length;
  const hasFrameMismatch = frameCount > 0 && actualFileCount > 0 && actualFileCount !== frameCount;
  const fallbackBallIds = Array.from(
    new Set([
      ...tracks.map((track) => track.ballId),
      ...seeds.map((seed) => seed.ballId),
    ]),
  ).sort((a, b) => a - b);
  const physicsMassConfigs =
    ballConfigs.length > 0
      ? ballConfigs
      : fallbackBallIds.length > 0
        ? fallbackBallIds.map((ballId) => ({
            ballId,
            mass_g: DEFAULT_MASS_G,
            uncertainty_g: DEFAULT_MASS_UNCERTAINTY_G,
          }))
        : Array.from({ length: maxBalls }, (_, ballId) => ({
            ballId,
            mass_g: DEFAULT_MASS_G,
            uncertainty_g: DEFAULT_MASS_UNCERTAINTY_G,
          }));

  const handleRunTrack = async () => {
    if (!selectedExp || seeds.length === 0) return;
    resetPhysics();
    setPhysicsError(null);
    setStatus('tracking');
    try {
      const response = await fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          experiment_id: selectedExp,
          seeds: seeds.map((s) => ({ ...s, ball_id: s.ballId, camera_id: 0 })),
          model_id: selectedModel,
          clientId: 'pc', // Using 'pc' so it routes back to our store
        }),
      });
      if (!response.ok) throw new Error('Tracking failed');
      const data = await response.json();
      onTrackingComplete(data.tracks.map((t: any) => ({ ...t, cameraId: '0' })));
      await handleRunPhysics();
    } catch (err) {
      console.error(err);
      setStatus('idle');
    }
  };

  const handleRunPhysics = async () => {
    if (!selectedExp) return;

    requestPhysics();
    setPhysicsError(null);

    try {
      const response = await fetch(`/api/experiments/${selectedExp}/physics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ massConfigs: physicsMassConfigs }),
      });

      if (!response.ok) {
        let errorMessage = `Physics request failed (${response.status})`;
        try {
          const payload = (await response.json()) as { error?: unknown };
          if (typeof payload?.error === 'string' && payload.error.trim()) {
            errorMessage = payload.error;
          }
        } catch {
          // Ignore non-JSON bodies.
        }
        throw new Error(errorMessage);
      }

      const result = (await response.json()) as PhysicsResult;
      onPhysicsResult(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to compute physics';
      onPhysicsFailed(message);
      setPhysicsError(message);
    }
  };

  return (
    <div className="flex min-h-[100dvh] w-full overflow-hidden bg-slate-950 text-slate-100">
      <div className="grid h-full w-full gap-0 lg:grid-cols-[1fr_400px]">
        {/* Left Side: Massive Preview */}
        <div className="flex min-h-0 flex-col bg-black relative items-center justify-center">
          {/* Subtle overlay header */}
          <div className="absolute top-6 left-8 z-30 pointer-events-none opacity-40">
            <h1 className="text-xl font-black uppercase tracking-[0.2em] text-slate-500">
              Debug Lab <span className="text-orange-600/50">//</span> {mode.toUpperCase()}
            </h1>
          </div>

          <div className="absolute top-6 right-8 z-30 flex gap-2">
            <button
              onClick={() => setMode('sam2')}
              className={`px-4 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-widest transition-all ${
                mode === 'sam2' ? 'bg-orange-600 text-white shadow-lg' : 'bg-slate-900 text-slate-500 border border-slate-800'
              }`}
            >
              SAM2
            </button>
            <button
              onClick={() => setMode('sync')}
              className={`px-4 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-widest transition-all ${
                mode === 'sync' ? 'bg-sky-600 text-white shadow-lg' : 'bg-slate-900 text-slate-500 border border-slate-800'
              }`}
            >
              Sync
            </button>
          </div>

          {mode === 'sam2' ? (
            <div 
              className="relative bg-black shadow-2xl overflow-hidden"
              style={{ 
                aspectRatio: `${dims.width} / ${dims.height}`,
                maxHeight: '100%',
                maxWidth: '100%',
              }}
            >
              {frameSrc && (
                <img
                  src={frameSrc}
                  className="h-full w-full object-contain block"
                  onLoad={(e) => {
                    setDims({
                      width: e.currentTarget.naturalWidth,
                      height: e.currentTarget.naturalHeight,
                    });
                    setFrameImageState('ready');
                  }}
                  onError={() => setFrameImageState('error')}
                />
              )}
              {!selectedExp && (
                <div className="absolute inset-0 flex items-center justify-center text-slate-600 font-mono tracking-widest uppercase text-xs">
                  -- No Experiment Selected --
                </div>
              )}
              {frameImageState === 'error' && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/90 text-rose-500 font-bold uppercase tracking-tighter">
                  [ ERROR: FRAME NOT FOUND ]
                </div>
              )}

              {isFrameMissing && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 text-amber-500 backdrop-blur-sm">
                  <div className="text-center">
                    <p className="text-6xl mb-4">⚠️</p>
                    <p className="font-black uppercase tracking-[0.3em] text-lg">Omitted Frame</p>
                    <p className="text-[10px] opacity-40 mt-2 font-mono">PHYSICAL_IDX: {safeFrame}</p>
                  </div>
                </div>
              )}

              <TrajectoryCanvas
                width={dims.width}
                height={dims.height}
                tracks={tracks}
                currentFrame={safeFrame}
                cameraId="0"
              />

              <BallSeedPicker
                cameraId="0"
                currentFrame={safeFrame}
                seedFrameIdx={safeFrame}
                maxBalls={maxBalls}
                frameWidth={dims.width}
                frameHeight={dims.height}
                seeds={seeds}
                onAddSeed={(s) => addSeed(s, maxBalls)}
                mode={seedMode}
              />
            </div>
          ) : (
            <SyncDebugView experimentId={selectedExp} currentFrame={safeFrame} />
          )}

          {hasFrameMismatch && (
            <div className="absolute bottom-8 left-8 z-30 rounded-full border border-amber-500/20 bg-amber-500/5 px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest text-amber-500/60 backdrop-blur-md opacity-40 hover:opacity-100 transition-opacity">
              Sparse Dataset: {frameCount - actualFileCount} missing
            </div>
          )}
        </div>

        {/* Right Side: All Controls */}
        <aside className="custom-scrollbar overflow-y-auto border-l border-slate-800 bg-slate-900/50 p-8 space-y-10">
          <section className="space-y-6">
            <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-600">
              Experiment
            </h3>

            <div className="space-y-4">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">
                  Experiment
                </label>
                <div className="flex gap-2">
                  <select
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm"
                    value={selectedExp}
                    onChange={(e) => {
                      setSelectedExp(e.target.value);
                      resetTracking();
                      setIsPlaying(false);
                    }}
                  >
                    <option value="">Select Experiment</option>
                    {experiments.map((e) => (
                      <option key={e} value={e}>
                        {e}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={fetchExperiments}
                    className="rounded-lg border border-slate-700 bg-slate-800 px-3 hover:bg-slate-700"
                  >
                    🔄
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">
                  SAM2 Model
                </label>
                <select
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm"
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                >
                  <option value="facebook/sam2-hiera-tiny">Tiny (Fastest)</option>
                  <option value="facebook/sam2-hiera-small">Small</option>
                  <option value="facebook/sam2-hiera-base-plus">Base+</option>
                  <option value="facebook/sam2-hiera-large">Large (Best)</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  onClick={() => {
                    onTrackingComplete([]);
                    resetPhysics();
                    setPhysicsError(null);
                  }}
                  className="rounded-lg border border-slate-700 bg-slate-800 py-2 text-[10px] font-bold uppercase tracking-widest text-slate-400"
                >
                  Clear
                </button>
                <button
                  onClick={handleRunTrack}
                  disabled={status === 'tracking' || !selectedExp || seeds.length === 0}
                  className={`rounded-lg py-2 text-[10px] font-bold uppercase tracking-widest transition-all ${status === 'tracking' ? 'bg-slate-800 text-slate-500' : 'bg-orange-600 text-white hover:bg-orange-500 shadow-lg shadow-orange-900/20'}`}
                >
                  {status === 'tracking' ? 'Processing...' : 'Run SAM2 + Physics'}
                </button>
                <button
                  onClick={handleRunPhysics}
                  disabled={physicsStatus === 'computing' || !selectedExp}
                  className={`rounded-lg py-2 text-[10px] font-bold uppercase tracking-widest transition-all ${physicsStatus === 'computing' ? 'bg-slate-800 text-slate-500' : 'bg-sky-600 text-white hover:bg-sky-500 shadow-lg shadow-sky-900/20'}`}
                >
                  {physicsStatus === 'computing' ? 'Testing Physics...' : 'Run Physics'}
                </button>
              </div>
            </div>
          </section>

          <section className="space-y-6">
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-500">
              Playback
            </h3>

            <FrameScrubber
              currentFrame={currentFrame}
              frameCount={frameCount}
              onFrameChange={setFrame}
              isPlaying={isPlaying}
              onPlayToggle={() => setIsPlaying(!isPlaying)}
              playbackSpeed={playbackSpeed}
              onSpeedChange={setPlaybackSpeed}
              variant="compact"
            />
          </section>

          <section className="space-y-6">
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-500">
              Seed Controls
            </h3>
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-950 p-2">
                <button
                  type="button"
                  onClick={() => setSeedMode('click')}
                  className={`flex-1 rounded-lg py-2 text-[10px] font-bold uppercase tracking-wider transition ${
                    seedMode === 'click'
                      ? 'bg-orange-600 text-white shadow-lg'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  Tap
                </button>
                <button
                  type="button"
                  onClick={() => setSeedMode('bbox')}
                  className={`flex-1 rounded-lg py-2 text-[10px] font-bold uppercase tracking-wider transition ${
                    seedMode === 'bbox'
                      ? 'bg-orange-600 text-white shadow-lg'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  Box
                </button>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                    Seeds Placed
                  </span>
                  <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-xs text-slate-200">
                    {seeds.filter((s) => s.frameIdx === safeFrame).length} / {maxBalls}
                  </span>
                </div>
              </div>
            </div>
          </section>

          <section className="space-y-6">
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-500">Monitor</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-xl bg-slate-950 p-3 border border-slate-800">
                <span className="block text-[10px] text-slate-500 uppercase">Res</span>
                <span className="text-lg font-bold">
                  {dims.width}x{dims.height}
                </span>
              </div>
              <div className="rounded-xl bg-slate-950 p-3 border border-slate-800">
                <span className="block text-[10px] text-slate-500 uppercase">Status</span>
                <span className="text-[10px] font-bold uppercase text-orange-500 truncate">
                  {status}
                </span>
              </div>
            </div>
            {status === 'tracking' && (
              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-sky-400">
                  <span>Analyzing Video</span>
                  <span className="font-mono">{Math.round(progress * 100)}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full border border-slate-800 bg-slate-950">
                  <div 
                    className="h-full bg-gradient-to-r from-sky-500 to-orange-500 transition-all duration-300"
                    style={{ width: `${progress * 100}%` }}
                  />
                </div>
              </div>
            )}
          </section>

          <section className="space-y-6">
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-500">
              Physics
            </h3>
            {physicsError ? (
              <div className="rounded-xl border border-rose-500/40 bg-rose-950/80 px-4 py-3 text-xs text-rose-200">
                <span className="font-black opacity-60 mr-2">ERROR:</span>
                {physicsError}
              </div>
            ) : null}
            {ballConfigs.length === 0 ? (
              <div className="rounded-xl border border-amber-500/30 bg-amber-950/40 px-4 py-3 text-xs text-amber-100">
                No session mass profile found. Physics will use a 50 g / 1 g fallback for the
                tracked balls.
              </div>
            ) : null}
            {physicsStatus === 'computing' ? (
              <div className="rounded-xl border border-sky-500/30 bg-sky-950/40 px-4 py-5 text-xs text-sky-100">
                Recomputing physics from the latest SAM2 tracks...
              </div>
            ) : physicsResult ? (
              <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-950 p-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-slate-800 bg-black/40 p-3">
                    <span className="block text-[10px] uppercase tracking-widest text-slate-500">
                      Momentum
                    </span>
                    <span className="mt-1 block text-sm font-semibold text-slate-100">
                      {formatWithUncertainty(
                        physicsResult.system.momentum_conserved_pct.value,
                        physicsResult.system.momentum_conserved_pct.uncertainty,
                        2,
                      )}
                      %
                    </span>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-black/40 p-3">
                    <span className="block text-[10px] uppercase tracking-widest text-slate-500">
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
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-slate-800 bg-black/40 p-3">
                    <span className="block text-[10px] uppercase tracking-widest text-slate-500">
                      KE Before
                    </span>
                    <span className="mt-1 block text-sm font-semibold text-slate-100">
                      {formatWithUncertainty(
                        physicsResult.system.ke_before_total.value,
                        physicsResult.system.ke_before_total.uncertainty,
                        4,
                      )}
                    </span>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-black/40 p-3">
                    <span className="block text-[10px] uppercase tracking-widest text-slate-500">
                      KE After
                    </span>
                    <span className="mt-1 block text-sm font-semibold text-slate-100">
                      {formatWithUncertainty(
                        physicsResult.system.ke_after_total.value,
                        physicsResult.system.ke_after_total.uncertainty,
                        4,
                      )}
                    </span>
                  </div>
                </div>
                <div className="space-y-2">
                  {physicsResult.balls.map((ball) => (
                    <div
                      key={`debug-physics-ball-${ball.ballId}`}
                      className="rounded-lg border border-slate-800 bg-black/30 px-3 py-2 text-[11px] text-slate-300"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-bold uppercase tracking-widest text-slate-500">
                          Ball {ball.ballId + 1}
                        </span>
                        <span className="font-mono text-slate-400">
                          v {formatWithUncertainty(ball.v_before.value, ball.v_before.uncertainty, 3)}{' '}
                          {'->'} {formatWithUncertainty(ball.v_after.value, ball.v_after.uncertainty, 3)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-800 bg-slate-950/40 px-4 py-5 text-xs text-slate-500">
                Run SAM2 tracking first, then physics will be computed from the saved tracks.
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
};
