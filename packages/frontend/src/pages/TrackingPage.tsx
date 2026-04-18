import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BallSeedPicker } from '../components/BallSeedPicker';
import { FrameScrubber } from '../components/FrameScrubber';
import { TrajectoryCanvas } from '../components/TrajectoryCanvas';
import { useSessionStore } from '../stores/sessionStore';
import { useTrackingStore } from '../stores/trackingStore';
import type { CorrectionKeyframe } from '../types';

export const TrackingPage = () => {
  const navigate = useNavigate();
  const { cameras, ballConfigs, advancePhase, experimentId } = useSessionStore();
  const {
    frameCount,
    currentFrame,
    setFrame,
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
  const [activeCameraId, setActiveCameraId] = useState<string | null>(null);
  const [trackingError, setTrackingError] = useState<string | null>(null);
  const [frameImageState, setFrameImageState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [seedFrameIdx, setSeedFrameIdx] = useState(0);
  const [trackStartFrameIdx, setTrackStartFrameIdx] = useState(0);
  const [trackEndFrameIdx, setTrackEndFrameIdx] = useState(0);
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
  const frameFile = `${String(currentFrame + 1).padStart(6, '0')}.jpg`;
  const frameSrc =
    experimentId && activeCameraIndex >= 0
      ? `/api/experiments/${encodeURIComponent(experimentId)}/frames/${activeCameraIndex}/${frameFile}`
      : null;
  const correctionEnabled = tracks.length > 0 && status !== 'tracking';
  const seedInteractive =
    currentFrame === seedFrameIdx &&
    tracks.length === 0 &&
    status !== 'tracking' &&
    frameImageState === 'ready' &&
    activeCameraIndex >= 0;
  const activeCamera = cameras.find((camera) => camera.id === resolvedActiveCameraId);
  const activeCameraSeedCount = seeds.filter((seed) => seed.cameraId === resolvedActiveCameraId).length;
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
    if (isPlaying && frameCount > 0) {
      playRef.current = setInterval(() => {
        setFrame((currentFrame + 1) % frameCount);
      }, 100);
    } else if (playRef.current) {
      clearInterval(playRef.current);
    }

    return () => {
      if (playRef.current) clearInterval(playRef.current);
    };
  }, [isPlaying, currentFrame, frameCount, setFrame]);

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
      });

      const response = await fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          experiment_id: experimentId,
          seeds: requestSeeds,
          start_frame_idx: trackStartFrameIdx,
          end_frame_idx: trackEndFrameIdx,
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
    <div className="mx-auto flex h-[calc(100vh-84px)] max-w-[1600px] flex-col gap-6 rise-in">
      <header className="surface-panel flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="space-y-2">
          <p className="eyebrow">Phase 04 - Tracking</p>
          <h1 className="text-3xl">Trajectory Analysis Console</h1>
          <p className="subtle-copy">
            1) choose seed frame, 2) place {maxBalls} seeds per camera, 3) set frame range, 4) run
            SAM2, 5) review and correct flagged points.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="ui-pill">{statusLabel}</span>
          {status === 'tracking' ? (
            <>
              <div className="w-52 overflow-hidden rounded-full border border-slate-700 bg-slate-900">
                <div
                  className="h-2 bg-gradient-to-r from-sky-400 to-orange-400 transition-all"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <span className="ui-pill">{progressPct}%</span>
            </>
          ) : null}
          <button
            disabled={tracks.length === 0 || status === 'tracking'}
            onClick={() => {
              advancePhase();
              navigate('/results');
            }}
            className="btn-main"
          >
            Continue to Results
          </button>
        </div>
      </header>

      {trackingError ? (
        <div className="rounded-xl border border-rose-400/35 bg-rose-500/10 px-4 py-2 text-sm text-rose-100">
          {trackingError}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[1.9fr_1fr]">
        <div className="flex min-h-0 flex-col gap-4">
          <section className="surface-panel relative flex-1 overflow-hidden p-4">
            <div className="relative flex h-full w-full items-center justify-center">
              <div className="relative aspect-video h-full max-h-full w-full overflow-hidden rounded-2xl border border-slate-700 bg-slate-950">
                {frameSrc ? (
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
                ) : null}

                {frameImageState !== 'ready' ? (
                  <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
                    <div>
                      <p className="eyebrow">
                        {frameImageState === 'error'
                          ? 'Frame unavailable'
                          : frameImageState === 'loading'
                            ? 'Loading frame'
                            : 'Frame'}
                      </p>
                      <p className="font-mono text-4xl text-slate-700">{currentFrame + 1}</p>
                      {frameImageState === 'error' ? (
                        <p className="mt-2 text-xs text-rose-200">
                          Could not load {frameFile} for this camera.
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : null}

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
                  className="relative z-20 h-full w-full cursor-crosshair"
                />
              </div>
            </div>

            <div className="absolute left-6 top-6 flex flex-wrap gap-2">
              <span className="ui-pill border-sky-400/30 text-sky-100">
                {activeCamera?.label || 'No Camera Selected'}
              </span>
              <span className="ui-pill">
                Frame {currentFrame + 1} / {Math.max(frameCount, 1)}
              </span>
              <span className="ui-pill border-amber-400/35 text-amber-100">
                Seed {seedFrameIdx + 1}
              </span>
              <span className="ui-pill border-orange-400/35 text-orange-100">
                Range {trackStartFrameIdx + 1}-{trackEndFrameIdx + 1}
              </span>
            </div>

            <div className="absolute bottom-6 right-6 flex flex-wrap gap-2">
              {Array.from({ length: maxBalls }, (_, index) => (
                <span
                  key={`ball-badge-${index}`}
                  className={
                    index === 0
                      ? 'ui-pill border-sky-400/35 text-sky-100'
                      : index === 1
                        ? 'ui-pill border-lime-400/35 text-lime-100'
                        : 'ui-pill border-orange-400/35 text-orange-100'
                  }
                >
                  Ball {index + 1}
                </span>
              ))}
            </div>
          </section>

          <FrameScrubber
            currentFrame={currentFrame}
            frameCount={Math.max(frameCount, 1)}
            onFrameChange={setFrame}
            isPlaying={isPlaying}
            onPlayToggle={() => setIsPlaying((playing) => !playing)}
            flaggedFrames={flaggedFrames}
          />
        </div>

        <div className="custom-scrollbar flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
          <section className="surface-panel space-y-4 p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xl">Active Camera</h3>
              <span className="ui-pill">{cameras.length}</span>
            </div>
            <div className="space-y-2">
              {cameras.map((camera) => (
                <button
                  key={camera.id}
                  onClick={() => setActiveCameraId(camera.id)}
                  className={`surface-soft w-full px-3 py-3 text-left transition ${
                    resolvedActiveCameraId === camera.id
                      ? 'border-sky-400/45 bg-sky-500/10'
                      : 'hover:border-slate-600'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-slate-100">{camera.label}</span>
                    <span className="text-xs uppercase tracking-[0.16em] text-slate-400">
                      {camera.status}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section className="surface-panel space-y-4 p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xl">Tracking Engine</h3>
              <span className="ui-pill border-lime-400/35 text-lime-100">SAM2</span>
            </div>

            <div className="surface-soft space-y-2 p-3">
              <p className="eyebrow">Seed Coverage</p>
              <p className="text-sm text-slate-300">
                Active camera: {activeCameraSeedCount} / {maxBalls} seeds
              </p>
              <p className="text-xs text-slate-500">
                Overall: {cameras.length - camerasMissingSeeds.length}/{cameras.length} cameras ready
              </p>
              <p className="text-xs text-slate-500">
                Tap Seed = center click. Box Seed = drag rectangle around a ball.
              </p>
              {!hasRequiredSeedCoverage ? (
                <p className="text-xs text-amber-200">
                  Still missing seeds on: {camerasMissingSeeds.map((camera) => camera.label).join(', ')}
                </p>
              ) : (
                <p className="text-xs text-emerald-200">All cameras fully seeded. Ready to run.</p>
              )}
            </div>

            <div className="surface-soft space-y-3 p-3">
              <p className="eyebrow">Frame Controls</p>
              <div className="grid grid-cols-3 gap-2">
                <label className="text-xs text-slate-400">
                  Seed frame
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
                    className="field-shell mt-1"
                  />
                </label>
                <label className="text-xs text-slate-400">
                  Start
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
                    className="field-shell mt-1"
                  />
                </label>
                <label className="text-xs text-slate-400">
                  End
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
                    className="field-shell mt-1"
                  />
                </label>
              </div>
              <button
                type="button"
                onClick={() => setSeedFrameIdx(currentFrame)}
                className="btn-alt w-full py-2"
              >
                Use Current Frame as Seed Frame
              </button>
            </div>

            <button
              disabled={!hasRequiredSeedCoverage || status === 'tracking'}
              onClick={handleRunAutoTracker}
              className="btn-main w-full"
            >
              Run SAM2 Tracking
            </button>
          </section>

          {tracks.length > 0 ? (
            <section className="rounded-2xl border border-rose-400/35 bg-rose-500/10 p-4">
              <div className="flex items-center justify-between">
                <p className="eyebrow text-rose-200">Confidence Alerts</p>
                <span className="ui-pill border-rose-400 text-rose-100">
                  {flaggedFrames.length} issues
                </span>
              </div>
              <p className="mt-2 text-xs text-rose-100">
                Red rings mark low-confidence points. Scrub to these frames and drag to adjust.
              </p>
              {flaggedFrames.length > 0 && (
                <button
                  onClick={goToNextFlagged}
                  className="btn-alt mt-3 w-full border-rose-500/50 py-2 hover:bg-rose-500/20"
                >
                  Jump to Problem Frame
                </button>
              )}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
};
