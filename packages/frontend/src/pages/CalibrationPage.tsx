import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Ruler, Save, Target } from 'lucide-react';
import { useCalibrationStore } from '../stores/calibrationStore';
import { useSessionStore } from '../stores/sessionStore';
import type { CalibrationProfile, CalibrationResult } from '../types';

interface Point {
  x: number;
  y: number;
}

const qualityTone = (error: number | null) => {
  if (error === null) return 'text-slate-300';
  if (error <= 0.5) return 'text-emerald-400';
  if (error <= 1.0) return 'text-amber-400';
  return 'text-red-400';
};

export const CalibrationPage = () => {
  const navigate = useNavigate();
  const { experimentId, advancePhase } = useSessionStore();
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
    if (status !== 'complete') {
      return;
    }

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
      if (points.length >= 2) {
        return [{ x, y }];
      }
      return [...points, { x, y }];
    });
  };

  const computedScale = useMemo(() => {
    if (rulerPoints.length !== 2 || knownDistanceMm <= 0) {
      return null;
    }

    const dx = rulerPoints[1].x - rulerPoints[0].x;
    const dy = rulerPoints[1].y - rulerPoints[0].y;
    const distancePx = Math.sqrt(dx * dx + dy * dy);
    if (distancePx === 0) {
      return null;
    }

    return distancePx / knownDistanceMm;
  }, [rulerPoints, knownDistanceMm]);

  const calibrationReady = status === 'complete' || rulerScaleFactor !== null;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <h1 className="text-3xl font-bold text-white">Calibration</h1>
        <p className="mt-2 text-sm text-slate-400">
          Run stereo calibration or use ruler fallback for single-camera mode.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-5 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Calibration Status</h2>
            <span className="rounded-full border border-slate-700 px-3 py-1 text-xs uppercase tracking-wider text-slate-300">
              {status}
            </span>
          </div>

          <div className="h-2 overflow-hidden rounded-full border border-slate-700 bg-slate-800">
            <div className="h-full bg-indigo-500 transition-all" style={{ width: `${progress * 100}%` }} />
          </div>

          <div className="flex flex-wrap items-center gap-4 text-sm">
            <p className={`font-semibold ${qualityTone(reprojectionError)}`}>
              Reprojection Error: {reprojectionError === null ? '--' : `${reprojectionError.toFixed(3)} px`}
            </p>
            {reprojectionError !== null && reprojectionError > 1 ? (
              <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-200">
                Poor calibration quality. Retry or use ruler fallback.
              </p>
            ) : null}
          </div>

          {error ? (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <button
              onClick={handleRunCalibration}
              disabled={isBusy || !experimentId}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-700"
            >
              {isBusy ? 'Running...' : 'Run Calibration'}
            </button>
            <button
              onClick={handleSaveProfile}
              disabled={status !== 'complete'}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-100 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Save size={14} /> Save Profile
            </button>
            <input
              value={profileName}
              onChange={(event) => setProfileName(event.target.value)}
              className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
              placeholder="Profile name"
            />
          </div>
        </section>

        <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-lg font-semibold text-white">Saved Profiles</h2>
          {profiles.length === 0 ? (
            <p className="text-sm text-slate-500">No profiles available yet.</p>
          ) : (
            profiles.map((profile) => (
              <button
                key={profile.id}
                onClick={() => loadProfile(profile)}
                className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-3 text-left text-sm text-slate-100 transition hover:bg-slate-700"
              >
                <p className="font-semibold">{profile.name}</p>
                <p className="text-xs text-slate-400">
                  {new Date(profile.createdAt).toLocaleString()}
                  {profile.result.stereo ? ' Stereo' : ' Ruler'}
                </p>
              </button>
            ))
          )}
        </section>
      </div>

      <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex items-center justify-between">
          <h2 className="inline-flex items-center gap-2 text-lg font-semibold text-white">
            <Ruler size={18} className="text-indigo-400" /> Ruler Fallback
          </h2>
          <button
            onClick={() => {
              if (computedScale) {
                setRulerScale(computedScale);
              }
            }}
            disabled={!computedScale}
            className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-100 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Use Ruler Scale
          </button>
        </div>

        <p className="text-sm text-slate-400">
          Click two points on the calibration frame and provide known physical distance.
        </p>

        <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
          <div
            onClick={handleRulerFrameClick}
            className="relative aspect-video cursor-crosshair rounded-xl border border-slate-700 bg-slate-950"
          >
            <div className="absolute inset-0 grid place-items-center text-5xl font-black uppercase text-slate-800/40">
              <Target size={80} />
            </div>
            {rulerPoints.map((point, index) => (
              <div
                key={`${point.x}-${point.y}-${index}`}
                className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-indigo-500"
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
                  stroke="#818cf8"
                  strokeWidth="2"
                />
              </svg>
            ) : null}
          </div>

          <div className="space-y-3 rounded-xl border border-slate-700 bg-slate-950 p-4">
            <label className="text-xs uppercase tracking-wider text-slate-500">Known Distance (mm)</label>
            <input
              type="number"
              min={1}
              value={knownDistanceMm}
              onChange={(event) => setKnownDistanceMm(Number(event.target.value))}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
            />
            <p className="text-sm text-slate-300">
              px/mm: {computedScale ? computedScale.toFixed(4) : '--'}
            </p>
            {rulerScaleFactor ? (
              <p className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-200">
                <CheckCircle2 size={14} /> Active scale {rulerScaleFactor.toFixed(4)} px/mm
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
          className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-3 font-bold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-700"
        >
          Continue to Recording <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
};
