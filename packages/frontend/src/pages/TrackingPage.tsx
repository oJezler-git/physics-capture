import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BallSeedPicker, type SeedMode } from '../components/BallSeedPicker';
import { FrameScrubber } from '../components/FrameScrubber';
import { TrajectoryCanvas } from '../components/TrajectoryCanvas';
import { useSessionStore } from '../stores/sessionStore';
import { useTrackingStore } from '../stores/trackingStore';
import type { CorrectionKeyframe } from '../types';

const SAM2_MODEL_OPTIONS = [
  { value: 'facebook/sam2-hiera-tiny', label: 'Tiny (Fastest)' },
  { value: 'facebook/sam2-hiera-small', label: 'Small' },
  { value: 'facebook/sam2-hiera-base-plus', label: 'Base+' },
  { value: 'facebook/sam2-hiera-large', label: 'Large (Best)' },
];

export const TrackingPage = () => {
  const navigate = useNavigate();
  const { cameras, ballConfigs, advancePhase, experimentId } = useSessionStore();
  const {
    frameCount,
    currentFrame,
    setFrame,
    setFrameCount,
    frameMap,
    setFrameMap,
    tracks,
    status,
    progress,
    seeds,
    startTracking,
    setStatus,
    onTrackingComplete,
    addSeed,
    applyCorrection,
  } = useTrackingStore();

  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [activeCameraId, setActiveCameraId] = useState<string | null>(null);
  const [seedMode, setSeedMode] = useState<SeedMode>('click');
  const [trackingError, setTrackingError] = useState<string | null>(null);
  const [frameImageState, setFrameImageState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [seedFrameIdx, setSeedFrameIdx] = useState(0);
  const [trackStartFrameIdx, setTrackStartFrameIdx] = useState(0);
  const [trackEndFrameIdx, setTrackEndFrameIdx] = useState(0);
  const [selectedModel, setSelectedModel] = useState<string>('facebook/sam2-hiera-tiny');
  const [dims, setDims] = useState({ width: 1280, height: 720 });
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const maxBalls = useMemo(() => {
    const configured = ballConfigs.filter((config) => config.mass_g > 0).length;
    return Math.min(Math.max(configured || 1, 1), 3);
  }, [ballConfigs]);
  const resolvedActiveCameraId = activeCameraId ?? cameras[0]?.id ?? null;
  const activeCameraIndex = resolvedActiveCameraId
    ? cameras.findIndex((camera) => camera.id === resolvedActiveCameraId)
    : -1;

  const currentFrameEntry = frameMap[currentFrame];
  const frameFile = currentFrameEntry || `${String(currentFrame + 1).padStart(6, '0')}.png`;
  const physicalFrame = currentFrame;

  const frameSrc =
    experimentId && activeCameraIndex >= 0 && currentFrameEntry
      ? `/api/experiments/${encodeURIComponent(experimentId)}/frames/${activeCameraIndex}/${frameFile}`
      : null;
  const correctionEnabled = tracks.length > 0 && status !== 'tracking';
  const isFrameMissing = !!experimentId && !currentFrameEntry;
  const actualFileCount = frameMap.filter(Boolean).length;
  const hasFrameMismatch = frameCount > 0 && actualFileCount > 0 && actualFileCount !== frameCount;
  const seedInteractive =
    currentFrame === seedFrameIdx &&
    tracks.length === 0 &&
    status !== 'tracking' &&
    frameImageState === 'ready' &&
    activeCameraIndex >= 0;
  const camerasMissingSeeds = cameras.filter((camera) => {
    const cameraSeedCount = seeds.filter((seed) => seed.cameraId === camera.id).length;
    return cameraSeedCount < maxBalls;
  });
  const hasRequiredSeedCoverage = cameras.length > 0 && camerasMissingSeeds.length === 0;
  const statusLabel =
    status === 'tracking'
      ? `Tracking ${trackStartFrameIdx + 1}-${trackEndFrameIdx + 1}`
      : status === 'complete'
        ? 'Tracking complete'
        : 'Ready to seed';
  const progressPct = Math.round(progress * 100);

  const flaggedFrames = useMemo(() => {
    const frameSet = new Set<number>();
    tracks.forEach((t) => {
      t.points.forEach((p) => {
        if (p.isFlagged && !p.isCorrected) frameSet.add(p.frameIdx);
      });
    });
    return Array.from(frameSet).sort((a, b) => a - b);
  }, [tracks]);

  const goToNextFlagged = () => {
    const next = flaggedFrames.find((f) => f > currentFrame);
    if (next !== undefined) setFrame(next);
    else if (flaggedFrames.length > 0) setFrame(flaggedFrames[0]);
  };

  useEffect(() => {
    if (!experimentId) return;
    const fetchMeta = async () => {
      try {
        const res = await fetch(`/api/experiments/${experimentId}/metadata`);
        if (res.ok) {
          const data = await res.json();
          setFrameCount(data.frameCount || 0);
          setFrameMap(data.frameMap || [], data.sequenceToPhysical || []);
        }
      } catch (err) {
        console.error('Failed to fetch metadata:', err);
      }
    };
    fetchMeta();
  }, [experimentId, setFrameCount, setFrameMap]);

  useEffect(() => {
    if (isPlaying && frameCount > 0) {
      playRef.current = setInterval(
        () => {
          setFrame((prev) => (prev + 1) % frameCount);
        },
        1000 / (30 * playbackSpeed),
      );
    } else if (playRef.current) {
      clearInterval(playRef.current);
    }

    return () => {
      if (playRef.current) clearInterval(playRef.current);
    };
  }, [isPlaying, frameCount, setFrame, playbackSpeed]);

  useEffect(() => {
    if (!frameSrc) {
      setFrameImageState('idle');
      return;
    }
    setFrameImageState('loading');
  }, [frameSrc]);

  useEffect(() => {
    if (frameCount <= 0) return;
    setSeedFrameIdx((value) => Math.min(Math.max(value, 0), frameCount - 1));
    setTrackStartFrameIdx((value) => Math.min(Math.max(value, 0), frameCount - 1));
    setTrackEndFrameIdx((value) => Math.min(Math.max(value, 0), frameCount - 1));
  }, [frameCount]);

  useEffect(() => {
    if (frameCount > 0 && seeds.length === 0 && tracks.length === 0) {
      setTrackStartFrameIdx(0);
      setTrackEndFrameIdx(frameCount - 1);
    }
  }, [frameCount, seeds.length, tracks.length]);

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

  const handleCorrection = async (correction: CorrectionKeyframe) => {
    applyCorrection(correction);
    setTrackingError(null);

    if (!experimentId) return;

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

  const handleRunAutoTracker = async () => {
    if (!experimentId) {
      setTrackingError('Missing experiment id.');
      return;
    }

    if (seeds.length === 0) {
      setTrackingError('Place at least one seed before running auto-tracker.');
      return;
    }
    if (!hasRequiredSeedCoverage) {
      setTrackingError(
        `Seed all cameras before tracking (${maxBalls} per camera). Missing: ${camerasMissingSeeds
          .map((camera) => camera.label)
          .join(', ')}`,
      );
      return;
    }
    if (trackEndFrameIdx < trackStartFrameIdx) {
      setTrackingError('Tracking end frame must be after start frame.');
      return;
    }
    if (seedFrameIdx < trackStartFrameIdx || seedFrameIdx > trackEndFrameIdx) {
      setTrackingError('Seed frame must be inside the selected tracking range.');
      return;
    }

    const unresolvedSeeds = seeds.filter(
      (seed) => cameras.findIndex((camera) => camera.id === seed.cameraId) < 0,
    );
    if (unresolvedSeeds.length > 0) {
      setTrackingError('Some seeds are bound to cameras that are no longer active.');
      return;
    }

    startTracking();
    setTrackingError(null);

    try {
      const requestSeeds = seeds.map((seed) => ({
        ball_id: seed.ballId,
        camera_id: cameras.findIndex((camera) => camera.id === seed.cameraId),
        frame_idx: seed.frameIdx,
        x: seed.x,
        y: seed.y,
      }));

      console.log('[Tracking] Starting tracking request', {
        experimentId,
        seedCount: requestSeeds.length,
        modelId: selectedModel,
      });

      const response = await fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          experiment_id: experimentId,
          seeds: requestSeeds,
          start_frame_idx: trackStartFrameIdx,
          end_frame_idx: trackEndFrameIdx,
          model_id: selectedModel,
          clientId: 'pc',
        }),
      });

      if (!response.ok) {
        let detail = '';
        try {
          const errorPayload = await response.json();
          detail = errorPayload?.error ? `: ${errorPayload.error}` : '';
        } catch {
          // No structured error body.
        }
        throw new Error(`Tracking request failed (${response.status})${detail}`);
      }

      const payload = (await response.json()) as {
        tracks?: Array<{
          ballId: number;
          cameraId: number;
          points: Array<{
            frameIdx: number;
            x: number;
            y: number;
            confidence: number;
            isFlagged: boolean;
            isCorrected: boolean;
          }>;
        }>;
      };

      const normalizedTracks =
        payload.tracks?.map((track) => ({
          ballId: track.ballId,
          cameraId: cameras[track.cameraId]?.id ?? String(track.cameraId),
          points: track.points.filter(
            (point) => point.frameIdx >= trackStartFrameIdx && point.frameIdx <= trackEndFrameIdx,
          ),
        })) ?? [];

      console.log('[Tracking] Tracking completed', {
        trackCount: normalizedTracks.length,
      });

      onTrackingComplete(normalizedTracks);
      if (normalizedTracks.length === 0) {
        setTrackingError('Tracker returned no points. Check backend tracker logs.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to run tracker.';
      console.error('[Tracking] Request failed', error);
      setStatus('idle', 0);
      setTrackingError(message);
    }
  };

  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-[var(--bg-base)] text-slate-100">
      <div className="grid flex-1 w-full gap-0 lg:grid-cols-[1fr_320px]">
        {/* Left Side: Massive Preview */}
        <div className="flex min-h-0 flex-col bg-black relative group">
          {/* Subtle overlay header */}
          <div className="absolute top-8 left-8 z-30 pointer-events-none transition-opacity group-hover:opacity-100 opacity-40 slide-up stagger-1">
            <div className="space-y-1">
              <p className="text-[10px] font-medium uppercase tracking-widest text-[var(--accent)]">
                Step 4/4
              </p>
              <h1 className="text-xl font-bold tracking-tight text-[var(--text-main)]">
                Trajectory Analysis
              </h1>
            </div>
          </div>

          <div className="relative flex-1 overflow-hidden bg-black">
            {frameSrc && (
              <img
                src={frameSrc}
                alt={`Frame ${currentFrame + 1}`}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  setDims({ width: img.naturalWidth, height: img.naturalHeight });
                  setFrameImageState('ready');
                }}
                onError={() => setFrameImageState('error')}
                className="absolute inset-0 h-full w-full object-contain"
                draggable={false}
              />
            )}

            {frameImageState !== 'ready' && !isFrameMissing && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
                <div className="bg-[var(--bg-panel)] border border-[var(--line)] p-12 rounded-[2rem] shadow-sm">
                  <p className="font-medium uppercase tracking-widest text-[var(--text-faint)] text-6xl">
                    {currentFrame + 1}
                  </p>
                  <p className="mt-5 text-[10px] font-medium uppercase tracking-widest text-[var(--text-dim)]">
                    {frameImageState === 'error' ? 'Frame Link Dead' : 'Loading Sequence...'}
                  </p>
                </div>
              </div>
            )}

            {isFrameMissing && (
              <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-panel)]/90 backdrop-blur-md">
                <div className="text-center rounded-3xl border border-[var(--accent)] p-10 bg-[var(--bg-surface)] text-[var(--accent)] shadow-sm">
                  <p className="text-5xl mb-5">⚠️</p>
                  <p className="font-medium uppercase tracking-widest text-lg">Omitted Frame</p>
                  <p className="text-[11px] opacity-60 mt-3 font-mono">
                    PHYSICAL_IDX: {physicalFrame}
                  </p>
                </div>
              </div>
            )}

            <TrajectoryCanvas
              tracks={tracks}
              currentFrame={currentFrame}
              cameraId={resolvedActiveCameraId || ''}
              width={dims.width}
              height={dims.height}
              correctionEnabled={correctionEnabled}
              onCorrection={handleCorrection}
            />

            <BallSeedPicker
              cameraId={resolvedActiveCameraId}
              currentFrame={currentFrame}
              seedFrameIdx={seedFrameIdx}
              maxBalls={maxBalls}
              frameWidth={dims.width}
              frameHeight={dims.height}
              seeds={seeds}
              onAddSeed={(seed) => addSeed(seed, maxBalls)}
              interactive={seedInteractive}
              mode={seedMode}
              className="absolute inset-0 z-20"
            />
          </div>

          {hasFrameMismatch && (
            <div className="absolute bottom-8 left-8 z-30 rounded-full border border-[var(--accent)] bg-[var(--bg-panel)]/90 backdrop-blur-md px-5 py-2 text-[10px] font-medium uppercase tracking-widest text-[var(--accent)] transition-opacity group-hover:opacity-100 opacity-40 shadow-sm">
              Sparse Stream: {frameCount - actualFileCount} DROPPED
            </div>
          )}

          {trackingError && (
            <div className="absolute top-20 left-8 z-40 rounded-xl border border-[var(--accent)] bg-[var(--accent)]/10 px-5 py-3.5 text-xs font-medium text-[var(--accent)] shadow-sm max-w-md slide-up">
              <span className="font-bold mr-2 opacity-70">ERROR:</span> {trackingError}
            </div>
          )}
        </div>

        {/* Right Side: High-Density Controls */}
        <aside className="custom-scrollbar overflow-y-auto border-l border-[var(--line)] bg-[var(--bg-surface)] p-4 sm:p-5 space-y-5 slide-up stagger-2">
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-[9px] font-medium uppercase tracking-wider text-slate-400">
                Session
              </h3>
              <button
                disabled={tracks.length === 0 || status === 'tracking'}
                onClick={() => {
                  advancePhase();
                  navigate('/results');
                }}
                className="btn-main px-4 py-1.5 text-[9px]"
              >
                Finish Tracking
              </button>
            </div>

            <div className="surface-soft p-3 space-y-3 rounded-xl">
              <div className="flex flex-wrap gap-2">
                {cameras.map((camera) => (
                  <button
                    key={camera.id}
                    onClick={() => setActiveCameraId(camera.id)}
                    className={`px-3 py-1.5 rounded-lg border text-[9px] font-medium uppercase tracking-wider transition-all ${
                      resolvedActiveCameraId === camera.id
                        ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)] shadow-sm'
                        : 'border-[var(--line)] bg-[var(--bg-panel)] text-slate-500 hover:border-slate-400'
                    }`}
                  >
                    {camera.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center justify-between">
                <span className="ui-pill text-[var(--accent)] px-2 py-0.5 text-[9px]">{statusLabel}</span>
                {status === 'tracking' && (
                  <div className="flex items-center gap-2">
                    <div className="w-16 h-1.5 rounded-full bg-[var(--bg-base)] overflow-hidden border border-[var(--line)]">
                      <div
                        className="h-full bg-[var(--accent)] transition-all duration-300"
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                    <span className="text-[9px] font-mono text-[var(--accent)] font-medium">
                      {progressPct}%
                    </span>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-[9px] font-medium uppercase tracking-wider text-slate-400">
              Playback
            </h3>
            <FrameScrubber
              currentFrame={currentFrame}
              frameCount={Math.max(frameCount, 1)}
              onFrameChange={setFrame}
              isPlaying={isPlaying}
              onPlayToggle={() => setIsPlaying((playing) => !playing)}
              flaggedFrames={flaggedFrames}
              playbackSpeed={playbackSpeed}
              onSpeedChange={setPlaybackSpeed}
              variant="compact"
            />
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-[9px] font-medium uppercase tracking-wider text-slate-400">
                Seeding
              </h3>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setSeedMode('click')}
                  className={`rounded-lg border px-3 py-1.5 text-[9px] font-medium uppercase tracking-wider transition-all ${
                    seedMode === 'click'
                      ? 'border-[var(--accent)] bg-[var(--accent)] text-zinc-950 shadow-sm'
                      : 'border-[var(--line)] bg-[var(--bg-panel)] text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Tap
                </button>
                <button
                  type="button"
                  onClick={() => setSeedMode('bbox')}
                  className={`rounded-lg border px-3 py-1.5 text-[9px] font-medium uppercase tracking-wider transition-all ${
                    seedMode === 'bbox'
                      ? 'border-[var(--accent)] bg-[var(--accent)] text-zinc-950 shadow-sm'
                      : 'border-[var(--line)] bg-[var(--bg-panel)] text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Box
                </button>
              </div>
            </div>

            <div className="surface-soft space-y-2 p-3 rounded-xl">
              <div className="flex items-center justify-between">
                <span className="text-[9px] font-medium uppercase tracking-wider text-slate-400">
                  Active Frame Seeds
                </span>
                <span className="rounded-md bg-[var(--accent)]/10 px-2 py-0.5 font-mono text-[9px] text-[var(--accent)] border border-[var(--accent)]/50">
                  {
                    seeds.filter(
                      (s) => s.cameraId === resolvedActiveCameraId && s.frameIdx === currentFrame,
                    ).length
                  }{' '}
                  / {maxBalls}
                </span>
              </div>

              {!hasRequiredSeedCoverage ? (
                <p className="text-[9px] text-amber-500/80 font-medium uppercase tracking-wider leading-relaxed">
                  Missing: {camerasMissingSeeds.map((camera) => camera.label).join(', ')}
                </p>
              ) : (
                <p className="text-[9px] text-emerald-500 font-medium uppercase tracking-wider text-center pt-1 animate-pulse">
                  System Ready
                </p>
              )}
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-[9px] font-medium uppercase tracking-wider text-slate-400">
              SAM2 Engine
            </h3>

            <div className="surface-soft space-y-4 p-3 rounded-xl">
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <p className="text-[8px] font-medium uppercase tracking-wider text-slate-500">
                    Seed
                  </p>
                  <input
                    type="number"
                    min={1}
                    max={Math.max(frameCount, 1)}
                    value={seedFrameIdx + 1}
                    onChange={(event) =>
                      setSeedFrameIdx(
                        Math.min(
                          Math.max(Number(event.target.value || 1) - 1, 0),
                          Math.max(frameCount - 1, 0),
                        ),
                      )
                    }
                    className="w-full bg-[var(--bg-base)] border border-[var(--line)] rounded-md px-2 py-1.5 text-[10px] font-mono text-emerald-400 focus:border-[var(--accent)] outline-none transition-colors"
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-[8px] font-medium uppercase tracking-wider text-slate-500">
                    Start
                  </p>
                  <input
                    type="number"
                    min={1}
                    max={Math.max(frameCount, 1)}
                    value={trackStartFrameIdx + 1}
                    onChange={(event) =>
                      setTrackStartFrameIdx(
                        Math.min(
                          Math.max(Number(event.target.value || 1) - 1, 0),
                          Math.max(frameCount - 1, 0),
                        ),
                      )
                    }
                    className="w-full bg-[var(--bg-base)] border border-[var(--line)] rounded-md px-2 py-1.5 text-[10px] font-mono text-amber-400 focus:border-[var(--accent)] outline-none transition-colors"
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-[8px] font-medium uppercase tracking-wider text-slate-500">
                    End
                  </p>
                  <input
                    type="number"
                    min={1}
                    max={Math.max(frameCount, 1)}
                    value={trackEndFrameIdx + 1}
                    onChange={(event) =>
                      setTrackEndFrameIdx(
                        Math.min(
                          Math.max(Number(event.target.value || 1) - 1, 0),
                          Math.max(frameCount - 1, 0),
                        ),
                      )
                    }
                    className="w-full bg-[var(--bg-base)] border border-[var(--line)] rounded-md px-2 py-1.5 text-[10px] font-mono text-rose-400 focus:border-[var(--accent)] outline-none transition-colors"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <p className="text-[8px] font-medium uppercase tracking-wider text-slate-500">
                  Model
                </p>
                <select
                  value={selectedModel}
                  onChange={(event) => setSelectedModel(event.target.value)}
                  className="w-full rounded-md border border-[var(--line)] bg-[var(--bg-base)] px-2 py-1.5 text-[10px] font-mono text-emerald-300 outline-none focus:border-[var(--accent)] transition-colors"
                >
                  {SAM2_MODEL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2 pt-1">
                <button
                  type="button"
                  onClick={() => setSeedFrameIdx(currentFrame)}
                  className="w-full border border-[var(--line)] py-1.5 text-[9px] font-medium uppercase tracking-wider text-slate-400 hover:bg-[var(--bg-panel)] transition-colors rounded-lg"
                >
                  Anchor Seed @ {currentFrame + 1}
                </button>

                <button
                  disabled={!hasRequiredSeedCoverage || status === 'tracking'}
                  onClick={handleRunAutoTracker}
                  className="btn-main w-full py-2 text-[10px]"
                >
                  Execute SAM2 Track
                </button>
              </div>
            </div>
          </section>

          {tracks.length > 0 && flaggedFrames.length > 0 && (
            <section className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4 space-y-3 shadow-sm">
              <div className="flex items-center justify-between">
                <p className="text-[9px] font-medium uppercase tracking-wider text-rose-400">
                  Anomaly Alerts
                </p>
                <span className="rounded-md bg-rose-500 px-2 py-0.5 font-mono text-[9px] text-white font-medium">
                  {flaggedFrames.length}
                </span>
              </div>
              <p className="text-[9px] text-rose-200/60 leading-relaxed">
                System detected low-confidence artifacts. Manual correction required.
              </p>
              <button
                onClick={goToNextFlagged}
                className="w-full border border-rose-500/40 bg-rose-500/10 py-1.5 text-[9px] font-medium uppercase tracking-wider text-rose-300 hover:bg-rose-500/20 transition-colors rounded-lg"
              >
                Jump to Anomaly
              </button>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
};
