import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import { useCalibrationStore } from '../stores/calibrationStore';
import { useSessionStore } from '../stores/sessionStore';
import type { CalibrationProfile, CalibrationResult } from '../types';

interface Point {
  x: number;
  y: number;
}

const qualityTone = (error: number | null) => {
  if (error === null) return 'text-slate-300';
  if (error <= 0.5) return 'text-lime-300';
  if (error <= 1.0) return 'text-amber-200';
  return 'text-rose-200';
};

export const CalibrationPage = () => {
  const navigate = useNavigate();
  const { experimentId, cameras, advancePhase } = useSessionStore();
  const activeCamera = cameras.find((camera) => camera.status === 'live');
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (activeCamera?.stream && videoRef.current) {
      const videoEl = videoRef.current;
      if (videoEl.srcObject !== activeCamera.stream) {
        videoEl.srcObject = activeCamera.stream;
      }

      const tryPlay = () => {
        videoEl.play().catch(() => undefined);
      };

      videoEl.onloadedmetadata = tryPlay;
      tryPlay();

      return () => {
        videoEl.onloadedmetadata = null;
      };
    }
  }, [activeCamera]);

  const {
    profiles,
    status,
    reprojectionError,
    progress,
    rulerScaleFactor,
    error,
    setProfiles,
    startCalibration,
    onCalibrationComplete,
    onCalibrationFailed,
    loadProfile,
    setRulerScale,
  } = useCalibrationStore();

  const [isBusy, setIsBusy] = useState(false);
  const [profileName, setProfileName] = useState('Lab Bench A');
  const [rulerPoints, setRulerPoints] = useState<Point[]>([]);
  const [knownDistanceMm, setKnownDistanceMm] = useState(100);

  useEffect(() => {
    const loadProfiles = async () => {
      try {
        const response = await fetch('/api/calibration/profiles');
        if (!response.ok) return;
        const data = (await response.json()) as CalibrationProfile[];
        setProfiles(data);
      } catch {
        // Keep empty profile list in local mode.
      }
    };

    void loadProfiles();
  }, [setProfiles]);

  const handleRunCalibration = async () => {
    if (!experimentId) return;

    setIsBusy(true);
    startCalibration();

    try {
      const response = await fetch('/api/calibrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ experimentId }),
      });

      if (!response.ok) {
        throw new Error(`Calibration request failed (${response.status})`);
      }

      const result = await response.json();
      onCalibrationComplete(result);
    } catch (requestError) {
      if (window.location.hostname === 'localhost') {
        const fallbackResult: CalibrationResult = {
          experimentId,
          intrinsics: [],
          stereo: null,
          rulerScaleFactor: null,
          completedAt: Date.now(),
        };
        onCalibrationComplete(fallbackResult);
      } else {
        const message =
          requestError instanceof Error ? requestError.message : 'Calibration failed unexpectedly';
        onCalibrationFailed(message);
      }
    } finally {
      setIsBusy(false);
    }
  };

  const handleSaveProfile = async () => {
    if (status !== 'complete') return;

    const profileResult = {
      experimentId: experimentId ?? 'local',
      intrinsics: useCalibrationStore.getState().intrinsics,
      stereo: useCalibrationStore.getState().stereoExtrinsics,
      rulerScaleFactor,
      completedAt: Date.now(),
    };

    const draftProfile: CalibrationProfile = {
      id: crypto.randomUUID(),
      name: profileName,
      result: profileResult,
      createdAt: Date.now(),
    };

    setProfiles([draftProfile, ...profiles]);

    try {
      await fetch('/api/calibration/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftProfile),
      });
    } catch {
      // Keep optimistic profile entry in local mode.
    }
  };

  const handleRulerFrameClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    setRulerPoints((points) => {
      if (points.length >= 2) return [{ x, y }];
      return [...points, { x, y }];
    });
  };

  const computedScale = useMemo(() => {
    if (rulerPoints.length !== 2 || knownDistanceMm <= 0) return null;

    const dx = rulerPoints[1].x - rulerPoints[0].x;
    const dy = rulerPoints[1].y - rulerPoints[0].y;
    const distancePx = Math.sqrt(dx * dx + dy * dy);
    if (distancePx === 0) return null;

    return distancePx / knownDistanceMm;
  }, [rulerPoints, knownDistanceMm]);

  const calibrationReady = status === 'complete' || rulerScaleFactor !== null;

  return (
    <div className="mx-auto max-w-7xl space-y-6 rise-in">
      <header className="surface-panel space-y-2 p-7">
        <p className="eyebrow">Phase 02 - Calibration</p>
        <h1 className="text-3xl sm:text-4xl">Tune Measurement Geometry</h1>
        <p className="subtle-copy">
          Run stereo calibration for full depth reconstruction, or define a reliable px/mm ruler
          scale in fallback mode.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <section className="surface-panel space-y-5 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-2xl">Calibration Status</h2>
            <span className="ui-pill">{status}</span>
          </div>

          <div className="h-2 overflow-hidden rounded-full border border-slate-700 bg-slate-900/80">
            <div
              className="h-full bg-gradient-to-r from-sky-400 to-orange-400 transition-all"
              style={{ width: `${progress * 100}%` }}
            />
          </div>

          {isBusy ? (
            <div className="surface-soft p-4">
              <LoadingSkeleton lines={4} />
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3 text-sm">
            <p className={`font-semibold ${qualityTone(reprojectionError)}`}>
              Reprojection Error:{' '}
              {reprojectionError === null ? '--' : `${reprojectionError.toFixed(3)} px`}
            </p>
            {reprojectionError !== null && reprojectionError > 1 ? (
              <p className="rounded-xl border border-rose-400/35 bg-rose-500/10 px-3 py-1 text-xs text-rose-100">
                High error detected. Retry or use ruler fallback.
              </p>
            ) : null}
          </div>

          {error ? (
            <div className="rounded-xl border border-rose-400/35 bg-rose-500/10 px-4 py-2 text-sm text-rose-100">
              {error}
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-[auto_1fr_auto]">
            <button onClick={handleRunCalibration} disabled={isBusy || !experimentId} className="btn-main">
              {isBusy ? 'Running...' : 'Run Calibration'}
            </button>
            <input
              value={profileName}
              onChange={(event) => setProfileName(event.target.value)}
              className="field-shell"
              placeholder="Profile name"
            />
            <button onClick={handleSaveProfile} disabled={status !== 'complete'} className="btn-alt">
              Save Profile
            </button>
          </div>
        </section>

        <section className="surface-panel space-y-3 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-xl">Saved Profiles</h2>
            <span className="ui-pill">{profiles.length}</span>
          </div>
          {profiles.length === 0 ? (
            <p className="text-sm text-slate-500">No profiles captured yet.</p>
          ) : (
            <div className="custom-scrollbar max-h-[20rem] space-y-2 overflow-y-auto pr-1">
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  onClick={() => loadProfile(profile)}
                  className="surface-soft w-full px-3 py-3 text-left transition hover:border-sky-400/40"
                >
                  <p className="text-sm font-semibold text-slate-100">{profile.name}</p>
                  <p className="mt-1 text-xs text-slate-400">
                    {new Date(profile.createdAt).toLocaleString()}
                  </p>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="surface-panel space-y-4 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="eyebrow">Fallback Pipeline</p>
            <h2 className="mt-1 text-2xl">Ruler Scale Capture</h2>
          </div>
          <button
            onClick={() => {
              if (computedScale) setRulerScale(computedScale);
            }}
            disabled={!computedScale}
            className="btn-alt"
          >
            Use Ruler Scale
          </button>
        </div>

        <p className="subtle-copy">
          Click two points on the frame and enter the known physical distance in millimeters.
        </p>

        <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
          <div
            onClick={handleRulerFrameClick}
            className="relative aspect-video cursor-crosshair overflow-hidden rounded-2xl border border-slate-700 bg-slate-950"
          >
            {activeCamera?.stream ? (
              <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <div className="absolute inset-0 grid place-items-center text-center">
                <div>
                  <p className="eyebrow">No Live Camera</p>
                  <p className="mt-1 text-sm text-slate-400">Connect a phone feed for ruler marking.</p>
                </div>
              </div>
            )}

            {rulerPoints.map((point, index) => (
              <div
                key={`${point.x}-${point.y}-${index}`}
                className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-orange-500"
                style={{ left: point.x, top: point.y }}
              />
            ))}

            {rulerPoints.length === 2 ? (
              <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
                <line
                  x1={rulerPoints[0].x}
                  y1={rulerPoints[0].y}
                  x2={rulerPoints[1].x}
                  y2={rulerPoints[1].y}
                  stroke="#ff7244"
                  strokeWidth="2"
                />
              </svg>
            ) : null}
          </div>

          <div className="surface-soft space-y-3 p-4">
            <label className="text-xs uppercase tracking-[0.18em] text-slate-500">Known Distance (mm)</label>
            <input
              type="number"
              min={1}
              value={knownDistanceMm}
              onChange={(event) => setKnownDistanceMm(Number(event.target.value))}
              className="field-shell"
            />
            <p className="text-sm text-slate-300">px/mm: {computedScale ? computedScale.toFixed(4) : '--'}</p>
            {rulerScaleFactor ? (
              <p className="rounded-xl border border-lime-400/35 bg-lime-400/10 px-3 py-2 text-xs text-lime-100">
                Active scale {rulerScaleFactor.toFixed(4)} px/mm
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <div className="flex justify-end">
        <button
          disabled={!calibrationReady}
          onClick={() => {
            advancePhase();
            navigate('/recording');
          }}
          className="btn-main"
        >
          Continue to Recording
        </button>
      </div>
    </div>
  );
};
