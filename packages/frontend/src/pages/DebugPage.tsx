import { useEffect, useState, useCallback, useMemo } from 'react';
import { useResultsStore } from '../stores/resultsStore';
import { useTrackingStore } from '../stores/trackingStore';
import { useSessionStore } from '../stores/sessionStore';
import { ExperimentSidebar } from '../components/debug/ExperimentSidebar';
import { AnalysisSidebar } from '../components/debug/AnalysisSidebar';
import { DebugMainView } from '../components/debug/DebugMainView';
import { buildFallbackDiagnostics } from '../lib/diagnostics';
import type { PhysicsResult } from '../types';

type DebugMode = 'sam2' | 'sync' | '3d';
type SidebarTab = 'quick' | 'analysis';

const DEFAULT_MASS_G = 50;
const DEFAULT_MASS_UNCERTAINTY_G = 1;

export const DebugPage = () => {
  const [experiments, setExperiments] = useState<string[]>([]);
  const [selectedExp, setSelectedExp] = useState<string>('');
  const [mode, setMode] = useState<DebugMode>('sam2');
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('quick');
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);
  const [frameImageState, setFrameImageState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [dims, setDims] = useState({ width: 1280, height: 720 });
  const [selectedModel, setSelectedModel] = useState<string>('facebook/sam2-hiera-tiny');
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [seedMode, setSeedMode] = useState<'click' | 'bbox'>('click');
  const [physicsError, setPhysicsError] = useState<string | null>(null);

  const {
    seeds,
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
    addSeed,
  } = useTrackingStore();

  const {
    physicsResult,
    status: physicsStatus,
    requestPhysics,
    reset: resetPhysics,
    onPhysicsResult,
    onPhysicsFailed,
  } = useResultsStore();

  const { ballConfigs } = useSessionStore();

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
          clientId: 'pc',
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
          const payload = await response.json();
          if (payload.error) errorMessage = payload.error;
        } catch {
          /* ignore */
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
      <div
        className={`grid h-full w-full gap-0 transition-all duration-300 ease-in-out ${isSidebarVisible ? 'lg:grid-cols-[1fr_400px]' : 'lg:grid-cols-[1fr_0px]'}`}
      >
        <div className="flex min-h-0 flex-col bg-black">
          {/* Top Bar for Preview Area */}
          <div className="z-30 flex items-center justify-between border-b border-[var(--line)] bg-[var(--bg-surface)]/50 px-8 py-4 backdrop-blur-md">
            <div className="flex items-center gap-6">
              <h1 className="text-lg font-medium uppercase tracking-wider text-slate-400">
                Debug Lab <span className="text-[var(--accent)]/50">//</span> {mode.toUpperCase()}
              </h1>

              <div className="flex gap-2">
                {(['sam2', 'sync', '3d'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`px-5 py-1.5 rounded-full text-[10px] font-medium uppercase tracking-wider transition-all border ${
                      mode === m
                        ? 'bg-[var(--accent)] text-zinc-950 border-[var(--accent)] shadow-sm'
                        : 'bg-[var(--bg-panel)] text-slate-400 border-[var(--line)] hover:text-slate-200'
                    }`}
                  >
                    {m.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={() => setIsSidebarVisible(!isSidebarVisible)}
              className={`group flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest transition-all hover:border-[var(--accent)] hover:text-[var(--accent)] ${!isSidebarVisible ? 'text-[var(--accent)] border-[var(--accent)] shadow-[0_0_15px_rgba(16,185,129,0.2)]' : 'text-slate-500'}`}
            >
              <span>{isSidebarVisible ? 'Hide Controls' : 'Show Controls'}</span>
              <span
                className={`transition-transform duration-300 ${isSidebarVisible ? '' : 'rotate-180'}`}
              >
                →
              </span>
            </button>
          </div>

          <div className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden">
            <DebugMainView
              mode={mode}
              dims={dims}
              onDimsChange={setDims}
              frameSrc={frameSrc}
              onFrameImageStateChange={setFrameImageState}
              frameImageState={frameImageState}
              selectedExp={selectedExp}
              isFrameMissing={isFrameMissing}
              safeFrame={safeFrame}
              tracks={tracks}
              maxBalls={maxBalls}
              seeds={seeds}
              onAddSeed={(s) => addSeed(s, maxBalls)}
              seedMode={seedMode}
              physicsResult={physicsResult}
              frameFile={frameFile}
              diagnostics={diagnostics}
            />

            {hasFrameMismatch && (
              <div className="absolute bottom-8 left-8 z-30 rounded-full border border-amber-500/30 bg-amber-500/10 px-5 py-2 text-[10px] font-medium uppercase tracking-widest text-amber-400 backdrop-blur-md opacity-40 hover:opacity-100 transition-opacity shadow-sm">
                Sparse Dataset: {frameCount - actualFileCount} missing
              </div>
            )}
          </div>
        </div>

        <aside
          className={`custom-scrollbar overflow-y-auto border-l border-[var(--line)] bg-[var(--bg-surface)] transition-all duration-300 ease-in-out ${isSidebarVisible ? 'p-8 opacity-100' : 'p-0 opacity-0 pointer-events-none'}`}
        >
          <div className={`${isSidebarVisible ? 'block' : 'hidden'} space-y-6`}>
            <section className="flex items-center gap-2 rounded-2xl border border-[var(--line)] bg-[var(--bg-panel)] p-2">
              {(['quick', 'analysis'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setSidebarTab(tab)}
                  className={`flex-1 rounded-xl py-2 text-[10px] uppercase tracking-wider transition-colors ${
                    sidebarTab === tab
                      ? 'bg-[var(--accent)] text-zinc-950 font-bold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </section>

            {sidebarTab === 'quick' ? (
              <ExperimentSidebar
                selectedExp={selectedExp}
                onExpChange={(exp) => {
                  setSelectedExp(exp);
                  resetTracking();
                  setIsPlaying(false);
                }}
                experiments={experiments}
                onRefreshExperiments={fetchExperiments}
                selectedModel={selectedModel}
                onModelChange={setSelectedModel}
                onClear={() => {
                  onTrackingComplete([]);
                  resetPhysics();
                  setPhysicsError(null);
                }}
                onRunTrack={handleRunTrack}
                onRunPhysics={handleRunPhysics}
                status={status}
                physicsStatus={physicsStatus}
                hasSeeds={seeds.length > 0}
              />
            ) : (
              <AnalysisSidebar
                currentFrame={currentFrame}
                frameCount={frameCount}
                onFrameChange={setFrame}
                isPlaying={isPlaying}
                onPlayToggle={() => setIsPlaying(!isPlaying)}
                playbackSpeed={playbackSpeed}
                onSpeedChange={setPlaybackSpeed}
                seedMode={seedMode}
                onSeedModeChange={setSeedMode}
                seedsCount={seeds.filter((s) => s.frameIdx === safeFrame).length}
                maxBalls={maxBalls}
                dims={dims}
                status={status}
                progress={progress}
                physicsResult={physicsResult}
                physicsStatus={physicsStatus}
                physicsError={physicsError}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
};
