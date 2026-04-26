import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import { useCalibrationStore } from '../stores/calibrationStore';
import { useSessionStore } from '../stores/sessionStore';
import { Button } from '../components/ui/Button';
import type { CalibrationProfile } from '../types';

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
  const { experimentId, cameras, ballConfigs, setBallConfig, advancePhase } = useSessionStore();
  const activeCamera = cameras.find((camera) => camera.status === 'live');
  const videoRef = useRef<HTMLVideoElement>(null);
  const ballTone = ['#4cc3ff', '#9ad46f', '#ff7244'];

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
    calibrationStage,
    stageMessage,
    rulerScaleFactor,
    error,
    setProfiles,
    startCalibration,
    onCalibrationComplete,
    onCalibrationFailed,
    loadProfile,
    setRulerScale,
    stereoExtrinsics,
    intrinsics,
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
        body: JSON.stringify({
          experimentId,
          clientId: 'pc',
        }),
      });

      if (!response.ok) {
        throw new Error(`Calibration request failed (${response.status})`);
      }

      const result = await response.json();
      onCalibrationComplete(result);
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : 'Calibration failed unexpectedly';
      onCalibrationFailed(message);
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

  const baselineMm = useMemo(() => {
    if (!stereoExtrinsics?.T) return null;
    const [x, y, z] = stereoExtrinsics.T;
    return Math.sqrt(x * x + y * y + z * z);
  }, [stereoExtrinsics]);

  const updateBallMass = (index: number, field: 'mass_g' | 'uncertainty_g', value: number) => {
    const current = ballConfigs[index] || {
      ballId: index,
      mass_g: 0,
      uncertainty_g: 0,
    };
    setBallConfig(index, { ...current, [field]: value });
  };

  const addBall = () => {
    if (ballConfigs.length >= 3) return;
    setBallConfig(ballConfigs.length, {
      ballId: ballConfigs.length,
      mass_g: 50,
      uncertainty_g: 1,
    });
  };

  const hasMassConfig =
    ballConfigs.length > 0 &&
    ballConfigs.every(
      (config) =>
        Number.isFinite(config.mass_g) &&
        config.mass_g > 0 &&
        Number.isFinite(config.uncertainty_g) &&
        config.uncertainty_g > 0,
    );
  const calibrationReady = status === 'complete' || rulerScaleFactor !== null;

  return (
    <div className="mx-auto max-w-7xl py-6 px-4 sm:px-6 lg:px-8 space-y-6">
      <header className="surface-panel flex flex-wrap items-center justify-between gap-5 p-5 glitch-in stagger-1">
        <div className="space-y-1">
          <p className="eyebrow">Step 2/4</p>
          <h1 className="text-2xl sm:text-3xl">Calibration</h1>
          <p className="subtle-copy max-w-2xl text-xs">
            Run stereo calibration for full depth reconstruction, or define a reliable px/mm ruler
            scale in fallback mode.
          </p>
        </div>
        <Button
          variant="main"
          disabled={!calibrationReady || !hasMassConfig}
          onClick={() => {
            advancePhase();
            navigate('/recording');
          }}
          className="px-6 py-2"
        >
          Continue to Recording
        </Button>
      </header>

      <div className="grid gap-6 lg:grid-cols-[5fr_3fr] items-start">
        {/* Left Column: Calibration & Ruler */}
        <div className="flex flex-col gap-6">
          <section className="surface-panel space-y-4 p-5 glitch-in stagger-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl">Calibration Status</h2>
              <div className="flex items-center gap-2">
                {stereoExtrinsics && (
                  <span className="rounded-full bg-indigo-500/20 px-2 py-0.5 text-[10px] font-bold text-indigo-300 border border-indigo-500/30">
                    STEREO ACTIVE
                  </span>
                )}
                <span className="ui-pill">{status}</span>
              </div>
            </div>

            <div className="h-2 overflow-hidden border border-[var(--line)] bg-[var(--bg-panel)] rounded-full">
              <div
                className="h-full bg-[var(--accent)] transition-all"
                style={{ width: `${progress * 100}%` }}
              />
            </div>

            {(calibrationStage || stageMessage) && (
              <div className="space-y-1.5 rounded-xl border border-[var(--line)] bg-[var(--bg-base)]/50 p-3 shadow-inner">
                {calibrationStage && (
                  <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--accent)] opacity-80">
                    Stage: {calibrationStage.replace(/_/g, ' ')}
                  </p>
                )}
                {stageMessage && (
                  <p className="text-xs font-medium leading-relaxed text-slate-300 italic">
                    &ldquo;{stageMessage}&rdquo;
                  </p>
                )}
              </div>
            )}

            {stereoExtrinsics && (
              <div className="surface-soft border border-indigo-500/20 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-indigo-400 animate-pulse" />
                  <p className="text-xs font-bold uppercase tracking-wider text-indigo-300">
                    3D Stereo Matrix Recovered
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-[10px] text-slate-400 uppercase">Baseline Distance</p>
                    <p className="text-lg font-mono text-white">
                      {baselineMm?.toFixed(1)} <span className="text-xs opacity-50">mm</span>
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-slate-400 uppercase">RMS Error</p>
                    <p className="text-lg font-mono text-white">
                      {stereoExtrinsics.reprojection_error_px.toFixed(3)}{' '}
                      <span className="text-xs opacity-50">px</span>
                    </p>
                  </div>
                </div>
              </div>
            )}

            {isBusy && !stageMessage && (
              <div className="surface-soft p-3">
                <LoadingSkeleton lines={3} />
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3 text-sm">
              <p className={`font-semibold ${qualityTone(reprojectionError)}`}>
                Reprojection Error:{' '}
                {reprojectionError === null ? '--' : `${reprojectionError.toFixed(3)} px`}
              </p>
              {reprojectionError !== null && reprojectionError > 1 && (
                <p className="rounded-xl border border-[var(--accent)] bg-[var(--accent)]/10 px-3 py-1.5 text-xs font-medium text-[var(--accent)]">
                  High error detected. Retry or use ruler fallback.
                </p>
              )}
            </div>

            {error && (
              <div className="rounded-xl border border-[var(--accent)] bg-[var(--accent)]/10 px-4 py-3 text-sm font-medium text-[var(--accent)]">
                {error}
              </div>
            )}

            {(status === 'idle' || status === 'running') && (
              <div className="surface-soft border-l-4 border-[var(--accent)] p-4 space-y-3">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
                  Checkerboard Instructions
                </h3>
                <ul className="space-y-2 text-xs text-slate-400">
                  <li className="flex gap-2">
                    <span className="text-[var(--accent)]">●</span>
                    Move the board slowly to fill the frame from different angles and depths.
                  </li>
                  <li className="flex gap-2">
                    <span className="text-[var(--accent)]">●</span>
                    Keep the board within view of both cameras simultaneously for 3D stereo.
                  </li>
                  <li className="flex gap-2">
                    <span className="text-[var(--accent)]">●</span>
                    Avoid glare on the board surface; matte paper works best.
                  </li>
                </ul>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-[auto_1fr_auto]">
              <Button
                variant="main"
                onClick={handleRunCalibration}
                disabled={isBusy || !experimentId}
                className="py-2 text-sm"
              >
                {isBusy ? 'Running...' : 'Run Calibration'}
              </Button>
              <input
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                className="field-shell py-2 text-sm"
                placeholder="Profile name"
              />
              <Button
                variant="alt"
                onClick={handleSaveProfile}
                disabled={status !== 'complete'}
                className="py-2 text-sm"
              >
                Save Profile
              </Button>
            </div>
          </section>

          <section className="surface-panel space-y-4 p-5 glitch-in stagger-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="eyebrow">Fallback Pipeline</p>
                <h2 className="mt-1 text-xl">Ruler Scale Capture</h2>
              </div>
              <Button
                variant="alt"
                onClick={async () => {
                  if (!computedScale || !experimentId) return;

                  setIsBusy(true);
                  try {
                    const response = await fetch('/api/calibrate', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ experimentId, manualScale: computedScale }),
                    });

                    if (!response.ok) {
                      throw new Error(`Scale submission failed (${response.status})`);
                    }

                    const result = await response.json();
                    onCalibrationComplete(result);
                    setRulerScale(computedScale);
                  } catch (requestError) {
                    console.error('Failed to save manual scale:', requestError);
                  } finally {
                    setIsBusy(false);
                  }
                }}
                disabled={!computedScale || isBusy}
                className="py-2 text-sm"
              >
                {isBusy ? 'Saving...' : 'Use Ruler Scale'}
              </Button>
            </div>

            <p className="subtle-copy text-xs">
              Click two points on the frame and enter the known physical distance in millimeters.
            </p>

            <div className="grid gap-4 lg:grid-cols-[1fr_200px]">
              <div
                onClick={handleRulerFrameClick}
                className="relative aspect-video cursor-crosshair overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--bg-surface)] shadow-sm"
              >
                {activeCamera?.stream ? (
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : (
                  <div className="absolute inset-0 grid place-items-center text-center">
                    <div>
                      <p className="eyebrow">No Live Camera</p>
                      <p className="mt-1 text-xs text-slate-400">
                        Connect a phone feed for ruler marking.
                      </p>
                    </div>
                  </div>
                )}

                {rulerPoints.map((point, index) => (
                  <div
                    key={`${point.x}-${point.y}-${index}`}
                    className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[var(--accent)] shadow-md"
                    style={{ left: point.x, top: point.y }}
                  />
                ))}

                {rulerPoints.length === 2 && (
                  <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
                    <line
                      x1={rulerPoints[0].x}
                      y1={rulerPoints[0].y}
                      x2={rulerPoints[1].x}
                      y2={rulerPoints[1].y}
                      stroke="var(--accent)"
                      strokeWidth="2"
                    />
                  </svg>
                )}
              </div>

              <div className="surface-soft space-y-3 p-4 rounded-xl flex flex-col justify-center">
                <label className="text-[10px] font-semibold tracking-wider uppercase text-slate-500">
                  Known Distance (mm)
                </label>
                <input
                  type="number"
                  min={1}
                  value={knownDistanceMm}
                  onChange={(event) => setKnownDistanceMm(Number(event.target.value))}
                  className="field-shell py-1.5 text-sm"
                />
                <p className="text-xs text-slate-300 pt-1">
                  px/mm: {computedScale ? computedScale.toFixed(4) : '--'}
                </p>
                {rulerScaleFactor && (
                  <p className="rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-2 py-1.5 text-[10px] font-medium text-emerald-400 text-center">
                    Active scale {rulerScaleFactor.toFixed(4)} px/mm
                  </p>
                )}
              </div>
            </div>
          </section>
        </div>

        {/* Right Column: Profiles & Mass */}
        <div className="flex flex-col gap-6" style={{ animationDelay: '100ms' }}>
          <section className="surface-panel space-y-3 p-5 glitch-in stagger-2">
            <div className="flex items-center justify-between">
              <h2 className="text-xl">Saved Profiles</h2>
              <span className="ui-pill">{profiles.length}</span>
            </div>
            {profiles.length === 0 ? (
              <p className="text-sm text-slate-500 py-2">No profiles captured yet.</p>
            ) : (
              <div className="custom-scrollbar max-h-[12rem] space-y-2 overflow-y-auto pr-1">
                {profiles.map((profile) => (
                  <Button
                    key={profile.id}
                    onClick={() => loadProfile(profile)}
                    className="surface-soft w-full px-3 py-2.5 text-left transition hover:border-[var(--accent)] rounded-xl border border-transparent"
                  >
                    <p className="text-sm font-semibold text-slate-100">{profile.name}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">
                      {new Date(profile.createdAt).toLocaleString()}
                    </p>
                  </Button>
                ))}
              </div>
            )}
          </section>

          <section className="surface-panel space-y-4 p-5 glitch-in stagger-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="eyebrow">Mass Profile</p>
                <h2 className="mt-1 text-xl">Ball Configuration</h2>
              </div>
              <Button
                variant="alt"
                onClick={addBall}
                disabled={ballConfigs.length >= 3}
                className="py-1.5 px-3 text-[10px]"
              >
                Add Ball
              </Button>
            </div>

            <div className="space-y-3">
              {ballConfigs.map((config, index) => (
                <article
                  key={index}
                  className="surface-soft space-y-2.5 p-3 rounded-xl border border-[var(--line)]"
                >
                  <div className="flex items-center justify-between">
                    <span className="eyebrow text-[10px]">Ball {index + 1}</span>
                    <span
                      className="h-2 w-2 rounded-full shadow-sm"
                      style={{
                        background: ballTone[index % ballTone.length],
                        boxShadow: `0 0 8px ${ballTone[index % ballTone.length]}`,
                      }}
                    />
                  </div>
                  <div className="grid gap-2 grid-cols-2">
                    <label className="space-y-1">
                      <span className="text-[10px] text-slate-400 font-medium">Mass (g)</span>
                      <input
                        type="number"
                        value={config.mass_g}
                        onChange={(event) =>
                          updateBallMass(index, 'mass_g', Number.parseFloat(event.target.value))
                        }
                        className="field-shell py-1.5 text-xs"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] text-slate-400 font-medium">
                        Uncertainty (±g)
                      </span>
                      <input
                        type="number"
                        value={config.uncertainty_g}
                        onChange={(event) =>
                          updateBallMass(
                            index,
                            'uncertainty_g',
                            Number.parseFloat(event.target.value),
                          )
                        }
                        className="field-shell py-1.5 text-xs"
                      />
                    </label>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
