import { useEffect, useState, useCallback, useRef } from 'react';
import { BallSeedPicker } from '../components/BallSeedPicker';
import { TrajectoryCanvas } from '../components/TrajectoryCanvas';
import { useTrackingStore } from '../stores/trackingStore';
import { useSessionStore } from '../stores/sessionStore';

export const DebugPage = () => {
  const [experiments, setExperiments] = useState<string[]>([]);
  const [selectedExp, setSelectedExp] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frameImageState, setFrameImageState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [dims, setDims] = useState({ width: 1280, height: 720 });
  const [selectedModel, setSelectedModel] = useState<string>('facebook/sam2-hiera-tiny');
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);

  const {
    seeds,
    addSeed,
    tracks,
    onTrackingComplete,
    currentFrame,
    setFrame,
    frameCount,
    setFrameCount,
    status,
    setStatus,
    reset: resetTracking,
  } = useTrackingStore();

  const { ballConfigs } = useSessionStore();

  // Load experiments list
  const fetchExperiments = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/experiments');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setExperiments(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch experiments');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchExperiments();
  }, [fetchExperiments]);

  // Adjust frame count when experiment is selected
  useEffect(() => {
    if (!selectedExp) {
      setFrameCount(1);
      return;
    }
    const loadMeta = async () => {
      try {
        const res = await fetch(`/api/experiments/${selectedExp}/metadata`);
        if (res.ok) {
          const data = await res.json();
          setFrameCount(data.frameCount || 1);
        }
      } catch (err) {
        console.error('Failed to load metadata:', err);
      }
    };
    loadMeta();
  }, [selectedExp, setFrameCount]);

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
  const frameFile = `${String(safeFrame + 1).padStart(6, '0')}.jpg`;
  const frameSrc = selectedExp ? `/api/experiments/${selectedExp}/frames/0/${frameFile}` : null;
  const maxBalls = ballConfigs.filter((c) => c.mass_g > 0).length || 2;

  const handleRunTrack = async () => {
    if (!selectedExp || seeds.length === 0) return;
    setStatus('tracking');
    try {
      const response = await fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          experiment_id: selectedExp,
          seeds: seeds.map((s) => ({ ...s, ball_id: s.ballId, camera_id: 0 })),
          model_id: selectedModel,
        }),
      });
      if (!response.ok) throw new Error('Tracking failed');
      const data = await response.json();
      onTrackingComplete(data.tracks.map((t: any) => ({ ...t, cameraId: '0' })));
    } catch (err) {
      console.error(err);
      setStatus('idle');
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 p-8 text-slate-100">
      <header className="mb-8 flex items-center justify-between">
        <div className="flex flex-wrap gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">
              Experiment
            </label>
            <select
              className="min-w-[200px] rounded-lg border border-slate-700 bg-slate-900 px-4 py-2"
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
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">
              SAM2 Model
            </label>
            <select
              className="min-w-[200px] rounded-lg border border-slate-700 bg-slate-900 px-4 py-2"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
            >
              <option value="facebook/sam2-hiera-tiny">Tiny (Fastest)</option>
              <option value="facebook/sam2-hiera-small">Small</option>
              <option value="facebook/sam2-hiera-base-plus">Base+</option>
              <option value="facebook/sam2-hiera-large">Large (Best)</option>
            </select>
          </div>

          <div className="flex items-end gap-2 pb-1">
            <button
              onClick={fetchExperiments}
              className="rounded-lg border border-slate-700 bg-slate-800 p-2.5 hover:bg-slate-700"
            >
              🔄
            </button>
            <button
              onClick={() => onTrackingComplete([])}
              className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-bold uppercase text-slate-400"
            >
              Clear
            </button>
            <button
              onClick={handleRunTrack}
              disabled={status === 'tracking' || !selectedExp || seeds.length === 0}
              className={`rounded-lg px-6 py-2 font-bold transition-all ${status === 'tracking' ? 'bg-slate-800 text-slate-500' : 'bg-orange-600 text-white hover:bg-orange-500 hover:shadow-[0_0_20px_rgba(234,88,12,0.4)]'}`}
            >
              {status === 'tracking' ? 'Processing...' : 'Run SAM2'}
            </button>
          </div>
        </div>
      </header>

      <div className="grid gap-8 lg:grid-cols-[1fr_300px]">
        <div className="space-y-4">
          <div className="relative aspect-video overflow-hidden rounded-3xl border border-slate-800 bg-black shadow-2xl">
            {frameSrc && (
              <img
                src={frameSrc}
                className="h-full w-full object-contain"
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
              <div className="absolute inset-0 flex items-center justify-center text-slate-600">
                Select an experiment to begin
              </div>
            )}
            {frameImageState === 'error' && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-900/90 text-rose-500">
                Frame not found
              </div>
            )}

            <TrajectoryCanvas
              width={dims.width}
              height={dims.height}
              tracks={tracks}
              currentFrame={currentFrame}
              cameraId="0"
            />

            <BallSeedPicker
              cameraId="0"
              currentFrame={currentFrame}
              seedFrameIdx={currentFrame}
              maxBalls={maxBalls}
              frameWidth={dims.width}
              frameHeight={dims.height}
              seeds={seeds}
              onAddSeed={(s) => addSeed(s, maxBalls)}
            />
          </div>

          <div className="flex items-center gap-6 rounded-2xl border border-slate-800 bg-slate-900/40 p-4 backdrop-blur-md">
            <button
              onClick={() => setIsPlaying(!isPlaying)}
              className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-800 border border-slate-700 text-xl shadow-lg hover:bg-slate-700"
            >
              {isPlaying ? '⏸' : '▶'}
            </button>

            <select
              value={playbackSpeed}
              onChange={(e) => setPlaybackSpeed(parseFloat(e.target.value))}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm"
            >
              <option value="0.25">0.25x</option>
              <option value="0.5">0.5x</option>
              <option value="1">1x</option>
              <option value="2">2x</option>
            </select>

            <div className="flex flex-1 flex-col gap-2">
              <input
                type="range"
                min="0"
                max={Math.max(0, frameCount - 1)}
                value={currentFrame}
                onChange={(e) => {
                  setFrame(parseInt(e.target.value));
                  setIsPlaying(false);
                }}
                className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-slate-800 accent-orange-500"
              />
              <div className="flex justify-between font-mono text-[10px] text-slate-500">
                <span>
                  FRAME {currentFrame + 1} / {frameCount}
                </span>
                <span>{((currentFrame / Math.max(1, frameCount - 1)) * 100).toFixed(1)}%</span>
              </div>
            </div>
          </div>
        </div>

        <aside className="space-y-6">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
            <h3 className="mb-4 text-xs font-black uppercase tracking-widest text-slate-500">
              Monitor
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-xl bg-slate-950 p-3 border border-slate-800">
                <span className="block text-[10px] text-slate-500 uppercase">Seeds</span>
                <span className="text-lg font-bold">
                  {seeds.length} / {maxBalls}
                </span>
              </div>
              <div className="rounded-xl bg-slate-950 p-3 border border-slate-800">
                <span className="block text-[10px] text-slate-500 uppercase">Res</span>
                <span className="text-lg font-bold">
                  {dims.width}x{dims.height}
                </span>
              </div>
            </div>
            {status === 'tracking' && (
              <div className="mt-4 animate-pulse rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-center text-xs text-sky-400">
                ⚡ Analyzing video frames...
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
};
