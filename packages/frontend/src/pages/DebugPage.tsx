import { useEffect, useState, useCallback, useMemo } from 'react';
import { BallSeedPicker, type SeedMode } from '../components/BallSeedPicker';
import { FrameScrubber } from '../components/FrameScrubber';
import { TrajectoryCanvas } from '../components/TrajectoryCanvas';
import { SyncDebugView } from '../components/SyncDebugView';
import { ThreeDScene } from '../components/ThreeDScene';
import { useResultsStore } from '../stores/resultsStore';
import { useTrackingStore } from '../stores/trackingStore';
import { useSessionStore } from '../stores/sessionStore';
import { Button } from '../components/ui/Button';
import type { PhysicsResult } from '../types';

type DebugMode = 'sam2' | 'sync' | '3d' | 'diag';
type SidebarTab = 'quick' | 'analysis';

const formatWithUncertainty = (value: number, uncertainty: number, digits = 3) =>
  `${value.toFixed(digits)} +/- ${uncertainty.toFixed(digits)}`;

const DEFAULT_MASS_G = 50;
const DEFAULT_MASS_UNCERTAINTY_G = 1;
const percent = (value: number | null | undefined) =>
  typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : 'n/a';

const buildFallbackDiagnostics = (result: PhysicsResult | null) => {
  if (!result) return null;
  if (result.reconstructionDiagnostics) return result.reconstructionDiagnostics;

  const mode = result.reconstruction3d?.mode ?? 'SINGLE_CAMERA_PLANAR';
  const isStereo = mode === 'STEREO_3D';
  const extrinsics = result.reconstruction3d?.stereoExtrinsics as
    | { baseline_mm?: number; reprojection_error_px?: number }
    | undefined;
  const baselineMm = typeof extrinsics?.baseline_mm === 'number' ? extrinsics.baseline_mm : null;
  const reprojPx =
    typeof extrinsics?.reprojection_error_px === 'number' ? extrinsics.reprojection_error_px : null;
  const syncIsMock = Boolean(result.syncStatus?.isMock ?? true);

  return {
    overallConfidence: isStereo ? 0.55 : 0.35,
    verdict: (isStereo ? 'medium' : 'low') as 'high' | 'medium' | 'low',
    issues: [
      'Using fallback diagnostics because backend response is missing reconstructionDiagnostics.',
      'Restart signaling server to enable full diagnostics scoring.',
    ],
    checks: [
      {
        id: 'payload-version',
        label: 'Diagnostics payload',
        status: 'warn' as const,
        value: 'missing',
        details:
          'Backend response has no reconstructionDiagnostics yet. Showing compatibility fallback.',
      },
      {
        id: 'stereo-mode',
        label: 'Stereo mode enabled',
        status: (isStereo ? 'pass' : 'fail') as 'pass' | 'warn' | 'fail',
        value: mode,
      },
      {
        id: 'sync-source',
        label: 'Sync source',
        status: (syncIsMock ? 'warn' : 'pass') as 'pass' | 'warn' | 'fail',
        value: syncIsMock ? 'mock' : 'measured',
      },
      ...(baselineMm === null
        ? []
        : [
            {
              id: 'baseline',
              label: 'Stereo baseline',
              status: (baselineMm < 60 ? 'warn' : 'pass') as 'pass' | 'warn' | 'fail',
              value: `${baselineMm.toFixed(1)} mm`,
            },
          ]),
      ...(reprojPx === null
        ? []
        : [
            {
              id: 'reprojection',
              label: 'Stereo reprojection error',
              status: (reprojPx > 1.2 ? 'fail' : reprojPx > 0.6 ? 'warn' : 'pass') as
                | 'pass'
                | 'warn'
                | 'fail',
              value: `${reprojPx.toFixed(3)} px`,
            },
          ]),
    ],
    metrics: {
      mode,
      baselineMm,
      stereoReprojectionPx: reprojPx,
      syncRmsMs: result.syncStatus?.rmsMs ?? null,
      syncIsMock,
      avgTrackConfidence: null,
      frameCoverageCam0: null,
      frameCoverageCam1: null,
      triangulationFlaggedPct: null,
      maxLineDeviationM: null,
      gtRmseM: null,
      gtRmseXm: null,
      gtRmseYm: null,
      gtRmseZm: null,
      gtBiasXm: null,
      gtBiasYm: null,
      gtBiasZm: null,
      gtWorstFrame: null,
      gtWorstFrameErrorM: null,
      reprojRmseCam0Px: null,
      reprojRmseCam1Px: null,
      reprojWorstFrame: null,
      reprojWorstErrorPx: null,
    },
  };
};

export const DebugPage = () => {
  const [experiments, setExperiments] = useState<string[]>([]);
  const [selectedExp, setSelectedExp] = useState<string>('');
  const [mode, setMode] = useState<DebugMode>('sam2');
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('quick');
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
    new Set([...tracks.map((track) => track.ballId), ...seeds.map((seed) => seed.ballId)]),
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
  const diagnostics = useMemo(() => buildFallbackDiagnostics(physicsResult), [physicsResult]);

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
    <div className="flex min-h-[100dvh] w-full overflow-hidden bg-[var(--bg-base)] text-slate-100">
      <div className="grid h-full w-full gap-0 lg:grid-cols-[1fr_400px]">
        {/* Left Side: Massive Preview */}
        <div className="flex min-h-0 flex-col bg-black relative items-center justify-center">
          {/* Subtle overlay header */}
          <div className="absolute top-6 left-8 z-30 pointer-events-none opacity-40">
            <h1 className="text-xl font-medium uppercase tracking-wider text-slate-400">
              Debug Lab <span className="text-[var(--accent)]/50">//</span> {mode.toUpperCase()}
            </h1>
          </div>

          <div className="absolute top-6 right-8 z-30 flex gap-2">
            <Button
              onClick={() => setMode('sam2')}
              className={`px-5 py-2 rounded-full text-[10px] font-medium uppercase tracking-wider transition-all ${
                mode === 'sam2'
                  ? 'bg-[var(--accent)] text-zinc-950 shadow-sm'
                  : 'bg-[var(--bg-panel)] text-slate-400 border border-[var(--line)] hover:text-slate-200'
              }`}
            >
              SAM2
            </Button>
            <Button
              onClick={() => setMode('sync')}
              className={`px-5 py-2 rounded-full text-[10px] font-medium uppercase tracking-wider transition-all ${
                mode === 'sync'
                  ? 'bg-[var(--accent)] text-zinc-950 shadow-sm'
                  : 'bg-[var(--bg-panel)] text-slate-400 border border-[var(--line)] hover:text-slate-200'
              }`}
            >
              Sync
            </Button>
            <Button
              onClick={() => setMode('3d')}
              className={`px-5 py-2 rounded-full text-[10px] font-medium uppercase tracking-wider transition-all ${
                mode === '3d'
                  ? 'bg-[var(--accent)] text-zinc-950 shadow-sm'
                  : 'bg-[var(--bg-panel)] text-slate-400 border border-[var(--line)] hover:text-slate-200'
              }`}
            >
              3D
            </Button>
            <Button
              onClick={() => setMode('diag')}
              className={`px-5 py-2 rounded-full text-[10px] font-medium uppercase tracking-wider transition-all ${
                mode === 'diag'
                  ? 'bg-[var(--accent)] text-zinc-950 shadow-sm'
                  : 'bg-[var(--bg-panel)] text-slate-400 border border-[var(--line)] hover:text-slate-200'
              }`}
            >
              DIAG
            </Button>
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
                <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-panel)]/80 text-[var(--accent)] backdrop-blur-md">
                  <div className="text-center rounded-3xl border border-[var(--accent)] p-10 bg-[var(--bg-surface)] shadow-sm">
                    <p className="text-5xl mb-5">⚠️</p>
                    <p className="font-medium uppercase tracking-widest text-lg">Omitted Frame</p>
                    <p className="text-[11px] opacity-60 mt-3 font-mono">
                      PHYSICAL_IDX: {safeFrame}
                    </p>
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
          ) : mode === 'sync' ? (
            <SyncDebugView experimentId={selectedExp} currentFrame={safeFrame} />
          ) : mode === '3d' ? (
            <div className="relative h-full w-full">
              {physicsResult ? (
                <ThreeDScene
                  balls={physicsResult.balls}
                  currentFrame={safeFrame}
                  reconstruction3d={physicsResult.reconstruction3d}
                  experimentId={selectedExp}
                  frameFile={frameFile}
                  frameAspect={
                    dims.width > 0 && dims.height > 0 ? dims.width / dims.height : 16 / 9
                  }
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-slate-600 font-mono tracking-widest uppercase text-xs">
                  -- Run Physics to see 3D Reconstruction --
                </div>
              )}
            </div>
          ) : (
            <div className="h-full w-full p-8 overflow-auto">
              {!diagnostics ? (
                <div className="h-full rounded-3xl border border-dashed border-[var(--line)] bg-[var(--bg-panel)] grid place-items-center text-center text-slate-400 px-8">
                  <div className="space-y-3">
                    <p className="text-lg uppercase tracking-widest">No Diagnostics Yet</p>
                    <p className="text-xs">Run Physics to generate reconstruction diagnostics.</p>
                  </div>
                </div>
              ) : (
                <div className="max-w-4xl mx-auto space-y-6">
                  <div className="rounded-3xl border border-[var(--line)] bg-[var(--bg-panel)] p-6">
                    <div className="flex items-center justify-between">
                      <h2 className="text-lg font-semibold uppercase tracking-wider text-slate-200">
                        Reconstruction Diagnostics
                      </h2>
                      <div className="flex items-center gap-2">
                        <Button
                          onClick={() => {
                            navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
                          }}
                          className="rounded-full px-3 py-1 text-[9px] font-bold uppercase tracking-wider bg-[var(--bg-panel)] border border-[var(--line)] hover:bg-[var(--accent)] hover:text-zinc-950 transition-colors"
                        >
                          Copy JSON
                        </Button>
                        <span
                          className={`rounded-full px-4 py-1 text-xs font-bold uppercase tracking-widest ${
                            diagnostics.verdict === 'high'
                              ? 'bg-emerald-500/20 text-emerald-300'
                              : diagnostics.verdict === 'medium'
                                ? 'bg-amber-500/20 text-amber-300'
                                : 'bg-rose-500/20 text-rose-300'
                          }`}
                        >
                          {diagnostics.verdict} · {(diagnostics.overallConfidence * 100).toFixed(0)}
                          %
                        </span>
                      </div>
                    </div>
                  </div>

                  {diagnostics.issues.length > 0 && (
                    <div className="space-y-2">
                      {diagnostics.issues.map((issue, idx) => (
                        <div
                          key={`diag-page-issue-${idx}`}
                          className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200"
                        >
                          {issue}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] px-4 py-3 text-xs text-slate-300">
                      GT axis RMSE: x {diagnostics.metrics.gtRmseXm?.toFixed(4) ?? 'n/a'} m · y{' '}
                      {diagnostics.metrics.gtRmseYm?.toFixed(4) ?? 'n/a'} m · z{' '}
                      {diagnostics.metrics.gtRmseZm?.toFixed(4) ?? 'n/a'} m
                    </div>
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] px-4 py-3 text-xs text-slate-300">
                      GT bias: x {diagnostics.metrics.gtBiasXm?.toFixed(4) ?? 'n/a'} m · y{' '}
                      {diagnostics.metrics.gtBiasYm?.toFixed(4) ?? 'n/a'} m · z{' '}
                      {diagnostics.metrics.gtBiasZm?.toFixed(4) ?? 'n/a'} m
                    </div>
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] px-4 py-3 text-xs text-slate-300">
                      Worst GT frame: {diagnostics.metrics.gtWorstFrame ?? 'n/a'} ·{' '}
                      {diagnostics.metrics.gtWorstFrameErrorM?.toFixed(4) ?? 'n/a'} m
                    </div>
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] px-4 py-3 text-xs text-slate-300">
                      Reproj RMSE: cam0 {diagnostics.metrics.reprojRmseCam0Px?.toFixed(3) ?? 'n/a'}{' '}
                      px · cam1 {diagnostics.metrics.reprojRmseCam1Px?.toFixed(3) ?? 'n/a'} px
                    </div>
                  </div>

                  <div className="grid gap-3">
                    {diagnostics.checks.map((check) => (
                      <div
                        key={`diag-page-check-${check.id}`}
                        className="rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] px-4 py-3 flex items-center justify-between"
                      >
                        <div>
                          <p className="text-sm text-slate-200">{check.label}</p>
                          {check.details && (
                            <p className="text-xs text-slate-400 mt-1">{check.details}</p>
                          )}
                        </div>
                        <span
                          className={`text-xs font-mono uppercase tracking-wider ${
                            check.status === 'pass'
                              ? 'text-emerald-300'
                              : check.status === 'warn'
                                ? 'text-amber-300'
                                : 'text-rose-300'
                          }`}
                        >
                          {check.status}
                          {check.value ? ` · ${check.value}` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {hasFrameMismatch && (
            <div className="absolute bottom-8 left-8 z-30 rounded-full border border-amber-500/30 bg-amber-500/10 px-5 py-2 text-[10px] font-medium uppercase tracking-widest text-amber-400 backdrop-blur-md opacity-40 hover:opacity-100 transition-opacity shadow-sm">
              Sparse Dataset: {frameCount - actualFileCount} missing
            </div>
          )}
        </div>

        {/* Right Side: All Controls */}
        <aside className="custom-scrollbar overflow-y-auto border-l border-[var(--line)] bg-[var(--bg-surface)] p-8 space-y-6">
          <section className="flex items-center gap-2 rounded-2xl border border-[var(--line)] bg-[var(--bg-panel)] p-2">
            <Button
              onClick={() => setSidebarTab('quick')}
              className={`flex-1 rounded-xl py-2 text-[10px] uppercase tracking-wider ${
                sidebarTab === 'quick'
                  ? 'bg-[var(--accent)] text-zinc-950'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Quick
            </Button>
            <Button
              onClick={() => setSidebarTab('analysis')}
              className={`flex-1 rounded-xl py-2 text-[10px] uppercase tracking-wider ${
                sidebarTab === 'analysis'
                  ? 'bg-[var(--accent)] text-zinc-950'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Analysis
            </Button>
          </section>
          {sidebarTab === 'quick' && (
            <>
              <section className="space-y-6">
                <h3 className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
                  Experiment
                </h3>

                <div className="space-y-4">
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">
                      Experiment
                    </label>
                    <div className="flex gap-2">
                      <select
                        className="flex-1 rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] px-4 py-2.5 text-[11px] font-mono outline-none focus:border-[var(--accent)] transition-colors"
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
                      <Button
                        onClick={fetchExperiments}
                        className="rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] px-4 hover:text-[var(--accent)] transition-colors"
                      >
                        🔄
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">
                      SAM2 Model
                    </label>
                    <select
                      className="w-full rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] px-4 py-2.5 text-[11px] font-mono outline-none focus:border-[var(--accent)] transition-colors"
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
                    <Button
                      onClick={() => {
                        onTrackingComplete([]);
                        resetPhysics();
                        setPhysicsError(null);
                      }}
                      className="rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] py-2.5 text-[10px] font-medium uppercase tracking-wider text-slate-400 hover:text-slate-200 transition-colors"
                    >
                      Clear
                    </Button>
                    <Button
                      variant="main"
                      onClick={handleRunTrack}
                      disabled={status === 'tracking' || !selectedExp || seeds.length === 0}
                      className="py-2.5 text-[10px]"
                    >
                      {status === 'tracking' ? 'Processing...' : 'Run SAM2 + Physics'}
                    </Button>
                    <Button
                      variant="alt"
                      onClick={handleRunPhysics}
                      disabled={physicsStatus === 'computing' || !selectedExp}
                      className="py-2.5 text-[10px]"
                    >
                      {physicsStatus === 'computing' ? 'Testing Physics...' : 'Run Physics'}
                    </Button>
                  </div>
                </div>
              </section>
              <section className="space-y-6">
                <h3 className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
                  Shortcuts
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  <Button
                    onClick={() => setMode('3d')}
                    className="rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] py-2.5 text-[10px]"
                  >
                    Go 3D
                  </Button>
                  <Button
                    onClick={() => setMode('diag')}
                    className="rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] py-2.5 text-[10px]"
                  >
                    Go Diag
                  </Button>
                </div>
              </section>
            </>
          )}
          {sidebarTab === 'analysis' && (
            <>
              <section className="space-y-6">
                <h3 className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
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
                <h3 className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
                  Seed Controls
                </h3>
                <div className="flex flex-col gap-4">
                  <div className="flex items-center gap-2 rounded-2xl border border-[var(--line)] bg-[var(--bg-panel)] p-2">
                    <Button
                      type="button"
                      onClick={() => setSeedMode('click')}
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
                      onClick={() => setSeedMode('bbox')}
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
                        {seeds.filter((s) => s.frameIdx === safeFrame).length} / {maxBalls}
                      </span>
                    </div>
                  </div>
                </div>
              </section>

              <section className="space-y-6">
                <h3 className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
                  Monitor
                </h3>
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
                <h3 className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
                  Physics
                </h3>
                {physicsError && (
                  <div className="rounded-xl border border-[var(--accent)] bg-[var(--accent)]/10 px-4 py-3 text-xs font-medium text-[var(--accent)] shadow-sm">
                    <span className="font-bold opacity-70 mr-2">ERROR:</span>
                    {physicsError}
                  </div>
                )}
                {ballConfigs.length === 0 && (
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs font-medium text-amber-200 shadow-sm">
                    No session mass profile found. Physics will use a 50 g / 1 g fallback for the
                    tracked balls.
                  </div>
                )}
                {physicsStatus === 'computing' ? (
                  <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-5 text-xs font-medium text-sky-200 shadow-sm">
                    Recomputing physics from the latest SAM2 tracks...
                  </div>
                ) : physicsResult ? (
                  <div className="space-y-4 rounded-[2rem] border border-[var(--line)] bg-[var(--bg-panel)] p-6 shadow-sm">
                    {physicsResult.reconstructionDiagnostics && (
                      <div className="rounded-2xl border border-[var(--line)] bg-[var(--bg-surface)] p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] uppercase tracking-wider font-medium text-slate-400">
                            Reconstruction Diagnostics
                          </span>
                          <span
                            className={`rounded-md px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${
                              physicsResult.reconstructionDiagnostics.verdict === 'high'
                                ? 'bg-emerald-500/20 text-emerald-300'
                                : physicsResult.reconstructionDiagnostics.verdict === 'medium'
                                  ? 'bg-amber-500/20 text-amber-300'
                                  : 'bg-rose-500/20 text-rose-300'
                            }`}
                          >
                            {physicsResult.reconstructionDiagnostics.verdict} ·{' '}
                            {(
                              physicsResult.reconstructionDiagnostics.overallConfidence * 100
                            ).toFixed(0)}
                            %
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-3 text-[10px] text-slate-300">
                          <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] p-2">
                            Sync:{' '}
                            {physicsResult.reconstructionDiagnostics.metrics.syncIsMock
                              ? 'mock'
                              : 'measured'}
                          </div>
                          <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] p-2">
                            Baseline:{' '}
                            {physicsResult.reconstructionDiagnostics.metrics.baselineMm?.toFixed(
                              1,
                            ) ?? 'n/a'}{' '}
                            mm
                          </div>
                          <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] p-2">
                            Track confidence:{' '}
                            {physicsResult.reconstructionDiagnostics.metrics.avgTrackConfidence?.toFixed(
                              3,
                            ) ?? 'n/a'}
                          </div>
                          <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] p-2">
                            Triangulation flagged:{' '}
                            {percent(
                              physicsResult.reconstructionDiagnostics.metrics
                                .triangulationFlaggedPct,
                            )}
                          </div>
                          <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] p-2">
                            Cam0 coverage:{' '}
                            {percent(
                              physicsResult.reconstructionDiagnostics.metrics.frameCoverageCam0,
                            )}
                          </div>
                          <div className="rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] p-2">
                            Cam1 coverage:{' '}
                            {percent(
                              physicsResult.reconstructionDiagnostics.metrics.frameCoverageCam1,
                            )}
                          </div>
                        </div>
                        {physicsResult.reconstructionDiagnostics.issues.length > 0 && (
                          <div className="space-y-1">
                            {physicsResult.reconstructionDiagnostics.issues.map((issue, idx) => (
                              <div
                                key={`diag-issue-${idx}`}
                                className="text-[11px] text-rose-300 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-2"
                              >
                                {issue}
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="space-y-1">
                          {physicsResult.reconstructionDiagnostics.checks.map((check) => (
                            <div
                              key={check.id}
                              className="flex items-center justify-between rounded-lg border border-[var(--line)] bg-[var(--bg-panel)] px-2.5 py-2 text-[10px]"
                            >
                              <span className="text-slate-300">{check.label}</span>
                              <span
                                className={`font-mono ${
                                  check.status === 'pass'
                                    ? 'text-emerald-300'
                                    : check.status === 'warn'
                                      ? 'text-amber-300'
                                      : 'text-rose-300'
                                }`}
                              >
                                {check.status.toUpperCase()}
                                {check.value ? ` · ${check.value}` : ''}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-4">
                      <div className="rounded-2xl border border-[var(--line)] bg-[var(--bg-surface)] p-4">
                        <span className="block text-[10px] uppercase tracking-wider font-medium text-slate-400">
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
                      <div className="rounded-2xl border border-[var(--line)] bg-[var(--bg-surface)] p-4">
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
                    <div className="grid grid-cols-2 gap-4">
                      <div className="rounded-2xl border border-[var(--line)] bg-[var(--bg-surface)] p-4">
                        <span className="block text-[10px] uppercase tracking-wider font-medium text-slate-400">
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
                      <div className="rounded-2xl border border-[var(--line)] bg-[var(--bg-surface)] p-4">
                        <span className="block text-[10px] uppercase tracking-wider font-medium text-slate-400">
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
                    <div className="space-y-3">
                      {physicsResult.balls.map((ball) => (
                        <div
                          key={`debug-physics-ball-${ball.ballId}`}
                          className="rounded-2xl border border-[var(--line)] bg-[var(--bg-surface)] px-4 py-3 text-[11px] text-slate-300"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-medium uppercase tracking-wider text-slate-400">
                              Ball {ball.ballId + 1}
                            </span>
                            <span className="font-mono text-slate-300">
                              v{' '}
                              {formatWithUncertainty(
                                ball.v_before.value,
                                ball.v_before.uncertainty,
                                3,
                              )}{' '}
                              {'->'}{' '}
                              {formatWithUncertainty(
                                ball.v_after.value,
                                ball.v_after.uncertainty,
                                3,
                              )}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-3xl border border-dashed border-[var(--line)] bg-[var(--bg-panel)] px-6 py-8 text-center text-[11px] font-medium tracking-wide text-slate-400">
                    Run SAM2 tracking first, then physics will be computed from the saved tracks.
                  </div>
                )}
              </section>
            </>
          )}
        </aside>
      </div>
    </div>
  );
};
