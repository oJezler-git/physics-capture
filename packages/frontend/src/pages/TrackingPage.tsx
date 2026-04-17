import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BallSeedPicker } from '../components/BallSeedPicker';
import { FrameScrubber } from '../components/FrameScrubber';
import { TrajectoryCanvas } from '../components/TrajectoryCanvas';
import { useSessionStore } from '../stores/sessionStore';
import { useTrackingStore } from '../stores/trackingStore';
import type { CorrectionKeyframe } from '../types';

const FRAME_WIDTH = 1280;
const FRAME_HEIGHT = 720;

export const TrackingPage = () => {
  const navigate = useNavigate();
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
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resolvedActiveCameraId = activeCameraId ?? cameras[0]?.id ?? null;
  const activeCameraIndex = resolvedActiveCameraId
    ? cameras.findIndex((camera) => camera.id === resolvedActiveCameraId)
    : -1;
  const frameFile = `frame_${String(currentFrame + 1).padStart(6, '0')}.png`;
  const frameSrc =
    experimentId && activeCameraIndex >= 0
      ? `/api/experiments/${encodeURIComponent(experimentId)}/frames/${activeCameraIndex}/${frameFile}`
      : null;
  const correctionEnabled = tracks.length > 0 && status !== 'tracking';
  const seedInteractive =
    currentFrame === 0 &&
    tracks.length === 0 &&
    status !== 'tracking' &&
    frameImageState === 'ready' &&
    activeCameraIndex >= 0;
  const activeCamera = cameras.find((camera) => camera.id === resolvedActiveCameraId);

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
          points: track.points,
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
          <p className="subtle-copy">Seed frame zero, run SAM2, then drag points for correction.</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="ui-pill">{status}</span>
          {status === 'tracking' ? (
            <div className="w-52 overflow-hidden rounded-full border border-slate-700 bg-slate-900">
              <div
                className="h-2 bg-gradient-to-r from-sky-400 to-orange-400 transition-all"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
          ) : null}
          <button
            onClick={() => {
              advancePhase();
              navigate('/results');
            }}
            className="btn-main"
          >
            Finalize Data
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
                    onLoad={() => setFrameImageState('ready')}
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
                  className="relative z-20 h-full w-full cursor-crosshair"
                />
              </div>
            </div>

            <div className="absolute left-6 top-6 flex flex-wrap gap-2">
              <span className="ui-pill border-sky-400/30 text-sky-100">
                {activeCamera?.label || 'No Camera Selected'}
              </span>
              <span className="ui-pill">
                {currentFrame} / {frameCount}
              </span>
            </div>

            <div className="absolute bottom-6 right-6 flex flex-wrap gap-2">
              <span className="ui-pill border-sky-400/35 text-sky-100">Ball 1</span>
              <span className="ui-pill border-lime-400/35 text-lime-100">Ball 2</span>
              <span className="ui-pill border-orange-400/35 text-orange-100">Ball 3</span>
            </div>
          </section>

          <FrameScrubber
            currentFrame={currentFrame}
            frameCount={Math.max(frameCount, 1)}
            onFrameChange={setFrame}
            isPlaying={isPlaying}
            onPlayToggle={() => setIsPlaying((playing) => !playing)}
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
                {seeds.filter((seed) => seed.cameraId === resolvedActiveCameraId).length} / 3 for
                active camera
              </p>
              <p className="text-xs text-slate-500">
                Place seeds on frame 0. After tracking, drag low-confidence points to correct.
              </p>
            </div>

            <button
              disabled={seeds.length === 0 || status === 'tracking'}
              onClick={handleRunAutoTracker}
              className="btn-main w-full"
            >
              Run Auto-Tracker
            </button>
          </section>

          {tracks.length > 0 ? (
            <section className="rounded-2xl border border-rose-400/35 bg-rose-500/10 p-4">
              <p className="eyebrow text-rose-200">Confidence Alerts</p>
              <p className="mt-2 text-xs text-rose-100">
                Red rings mark low-confidence points. Scrub to those frames and drag to adjust.
              </p>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
};
