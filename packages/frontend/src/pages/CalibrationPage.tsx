import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize, Minimize } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
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
  const rulerImageRef = useRef<HTMLImageElement>(null);
  const rulerContainerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const ballTone = ['#4cc3ff', '#9ad46f', '#ff7244'];

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(document.fullscreenElement === rulerContainerRef.current);
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

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
  } = useCalibrationStore();

  const [isBusy, setIsBusy] = useState(false);
  const [profileName, setProfileName] = useState('Lab Bench A');
  const [rulerPoints, setRulerPoints] = useState<Point[]>([]);
  const [knownDistanceMm, setKnownDistanceMm] = useState(100);
  const [rulerFrameFile, setRulerFrameFile] = useState<string | null>(null);
  const [rulerImageSize, setRulerImageSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!experimentId) return;

    const loadFirstFrame = async () => {
      try {
        const response = await fetch(`/api/experiments/${experimentId}/metadata`);
        if (!response.ok) return;
        const data = (await response.json()) as { frameMap?: Array<string | null> };
        setRulerFrameFile(data.frameMap?.find(Boolean) ?? null);
      } catch {
        // Live camera fallback remains available.
      }
    };

    void loadFirstFrame();
  }, [experimentId]);

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

  const handleToggleFullscreen = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!document.fullscreenElement) {
      rulerContainerRef.current?.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

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
    const image = rulerImageRef.current;
    const scaleX = image?.naturalWidth ? image.naturalWidth / rect.width : 1;
    const scaleY = image?.naturalHeight ? image.naturalHeight / rect.height : 1;
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;

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

  const displayPoint = (point: Point) => ({
    left: rulerImageSize.width > 0 ? `${(point.x / rulerImageSize.width) * 100}%` : `${point.x}px`,
    top: rulerImageSize.height > 0 ? `${(point.y / rulerImageSize.height) * 100}%` : `${point.y}px`,
  });

  const displaySvgPoint = (point: Point) => ({
    x: rulerImageSize.width > 0 ? `${(point.x / rulerImageSize.width) * 100}%` : point.x,
    y: rulerImageSize.height > 0 ? `${(point.y / rulerImageSize.height) * 100}%` : point.y,
  });

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
          <p className="eyebrow">Step 3/5</p>
          <h1 className="text-2xl sm:text-3xl">Scale</h1>
          <p className="subtle-copy max-w-2xl text-xs">
            Click two ruler points in the uploaded overhead frame. This replaces stereo calibration
            for the planar workflow.
          </p>
        </div>
        <Button
          variant="main"
          disabled={!calibrationReady || !hasMassConfig}
          onClick={() => {
            advancePhase();
            navigate('/tracking');
          }}
          className="px-6 py-2"
        >
          Continue to Tracking
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
                    ADVANCED STEREO ACTIVE
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
                  Advanced Checkerboard Calibration
                </h3>
                <ul className="space-y-2 text-xs text-slate-400">
                  <li className="flex gap-2">
                    <span className="text-[var(--accent)]">●</span>
                    Optional only: use this if you are deliberately running the old stereo workflow.
                  </li>
                  <li className="flex gap-2">
                    <span className="text-[var(--accent)]">●</span>
                    The planar workflow only needs the ruler scale below.
                  </li>
                  <li className="flex gap-2">
                    <span className="text-[var(--accent)]">●</span>
                    Keep this section closed in normal one-video experiments.
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
                {isBusy ? 'Running...' : 'Run Advanced Calibration'}
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
                <p className="eyebrow">Required</p>
                <h2 className="mt-1 text-xl">Ruler Scale</h2>
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
              Click two ruler points on the uploaded frame and enter the known physical distance in
              millimeters.
            </p>

            <div className="grid gap-4 lg:grid-cols-[1fr_200px]">
              <div
                ref={rulerContainerRef}
                onClick={handleRulerFrameClick}
                className={clsx(
                  'relative cursor-crosshair overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--bg-surface)] shadow-sm transition-all',
                  !isFullscreen ? 'aspect-video' : 'h-screen w-screen rounded-none border-none',
                )}
              >
                {rulerFrameFile && experimentId ? (
                  <img
                    ref={rulerImageRef}
                    src={`/api/experiments/${encodeURIComponent(experimentId)}/frames/0/${rulerFrameFile}`}
                    alt="Uploaded ruler frame"
                    onLoad={(event) => {
                      setRulerImageSize({
                        width: event.currentTarget.naturalWidth,
                        height: event.currentTarget.naturalHeight,
                      });
                    }}
                    className="absolute inset-0 h-full w-full object-fill"
                    draggable={false}
                  />
                ) : activeCamera?.stream ? (
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
                        Upload a video first, or connect a live camera for ruler marking.
                      </p>
                    </div>
                  </div>
                )}

                <button
                  onClick={handleToggleFullscreen}
                  className="absolute top-3 right-3 z-20 p-2 rounded-lg bg-black/50 text-white hover:bg-black/70 transition-colors border border-white/10"
                  title="Toggle Fullscreen"
                >
                  {isFullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
                </button>

                {rulerPoints.map((point, index) => (
                  <div
                    key={`${point.x}-${point.y}-${index}`}
                    className={clsx(
                      'absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[var(--accent)] shadow-md transition-all',
                      isFullscreen ? 'h-6 w-6 border-4' : 'h-3 w-3',
                    )}
                    style={displayPoint(point)}
                  />
                ))}

                {rulerPoints.length === 2 && (
                  <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
                    <line
                      x1={displaySvgPoint(rulerPoints[0]).x}
                      y1={displaySvgPoint(rulerPoints[0]).y}
                      x2={displaySvgPoint(rulerPoints[1]).x}
                      y2={displaySvgPoint(rulerPoints[1]).y}
                      stroke="var(--accent)"
                      strokeWidth={isFullscreen ? '4' : '2'}
                    />
                  </svg>
                )}

                {isFullscreen && (
                  <div className="absolute bottom-8 left-1/2 z-20 flex -translate-x-1/2 items-center gap-6 rounded-2xl border border-white/20 bg-black/60 p-6 backdrop-blur-md transition-all shadow-2xl">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-bold uppercase tracking-widest text-white/50">
                        Distance (mm)
                      </label>
                      <input
                        type="number"
                        min={1}
                        value={knownDistanceMm}
                        onChange={(event) => setKnownDistanceMm(Number(event.target.value))}
                        onClick={(e) => e.stopPropagation()}
                        className="w-32 bg-transparent p-0 text-3xl font-bold text-white focus:outline-none focus:ring-0"
                        autoFocus
                      />
                    </div>
                    <div className="h-12 w-px bg-white/20" />
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-bold uppercase tracking-widest text-white/50">
                        Computed Scale
                      </label>
                      <div className="text-3xl font-mono font-bold text-[var(--accent)]">
                        {computedScale ? computedScale.toFixed(4) : '--'}
                      </div>
                    </div>
                  </div>
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
