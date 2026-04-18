import { useEffect, useState, useCallback } from 'react';
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

  const fetchExperiments = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/experiments');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setExperiments(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      console.error('Fetch experiments failed:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchExperiments();
  }, [fetchExperiments]);

  const frameFile = `${String(currentFrame + 1).padStart(6, '0')}.jpg`;
  const frameSrc = selectedExp ? `/api/experiments/${selectedExp}/frames/0/${frameFile}` : null;

  const maxBalls = ballConfigs.filter((c) => c.mass_g > 0).length || 2;

  const handleRunTrack = async () => {
    if (!selectedExp || seeds.length === 0) return;

    setStatus('tracking');
    try {
      const requestSeeds = seeds.map((s) => ({
        ball_id: s.ballId,
        camera_id: 0,
        frame_idx: s.frameIdx,
        x: s.x,
        y: s.y,
      }));

      const response = await fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          experiment_id: selectedExp,
          seeds: requestSeeds,
          model_id: selectedModel,
        }),
      });

      if (!response.ok) throw new Error('Tracking failed');
      const data = await response.json();
      onTrackingComplete(
        data.tracks.map((t: any) => ({
          ...t,
          cameraId: '0',
        })),
      );
    } catch (err) {
      console.error(err);
      setStatus('idle');
    }
  };

  return (
    <div className="p-8 space-y-8 bg-slate-950 min-h-screen text-slate-100">
      <header className="flex items-center justify-between">
        <div className="flex gap-4">
          <div className="flex flex-col gap-1">
            <select
              className="bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 min-w-[200px]"
              value={selectedExp}
              onChange={(e) => {
                setSelectedExp(e.target.value);
                resetTracking();
              }}
            >
              <option value="">{isLoading ? 'Loading...' : 'Select Experiment'}</option>
              {experiments.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
            <select
              className="bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 min-w-[200px]"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
            >
              <option value="facebook/sam2-hiera-tiny">Tiny Model (Fastest)</option>
              <option value="facebook/sam2-hiera-small">Small Model</option>
              <option value="facebook/sam2-hiera-base-plus">Base+ Model (Balanced)</option>
              <option value="facebook/sam2-hiera-large">Large Model (Slowest)</option>
            </select>
            {error && <span className="text-[10px] text-rose-400">{error}</span>}
            {!isLoading && experiments.length === 0 && !error && (
              <span className="text-[10px] text-amber-400">No experiments on disk</span>
            )}
          </div>
          <button
            onClick={fetchExperiments}
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700"
            title="Refresh list"
          >
            🔄
          </button>
          <button
            onClick={handleRunTrack}
            disabled={status === 'tracking' || !selectedExp || seeds.length === 0}
            className="btn-main"
          >
            {status === 'tracking' ? 'Processing...' : 'Run SAM2'}
          </button>
        </div>
      </header>

      <div className="grid lg:grid-cols-[1fr_300px] gap-8">
        <div className="space-y-4">
          <div className="relative aspect-video bg-black rounded-3xl overflow-hidden border border-slate-800">
            {frameSrc ? (
              <img
                src={frameSrc}
                className="w-full h-full object-contain"
                onLoad={(e) => {
                  const img = e.currentTarget;
                  setDims({ width: img.naturalWidth, height: img.naturalHeight });
                  setFrameImageState('ready');
                }}
                onError={() => setFrameImageState('error')}
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-slate-700">
                Select an experiment to begin
              </div>
            )}
            {frameImageState === 'error' && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80 text-rose-400">
                Frame not found in cam0
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

          <div className="flex items-center gap-4">
            <input
              type="range"
              min="0"
              max="500"
              value={currentFrame}
              onChange={(e) => setFrame(parseInt(e.target.value))}
              className="flex-1 accent-orange-500"
            />
            <span className="font-mono">{currentFrame + 1}</span>
          </div>
        </div>

        <div className="surface-panel p-6 space-y-6">
          <section>
            <h3 className="eyebrow text-slate-400 mb-2">Instructions</h3>
            <ol className="text-sm text-slate-300 space-y-2 list-decimal list-inside">
              <li>Pick an experiment folder from the dropdown.</li>
              <li>Use the slider to find a clear frame (usually frame 1).</li>
              <li>Place {maxBalls} seeds on the actual balls.</li>
              <li>Click "Run SAM2" and wait for the results.</li>
            </ol>
          </section>

          <section>
            <h3 className="eyebrow text-slate-400 mb-2">Monitor</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-slate-900/50 p-3 rounded-xl border border-slate-800">
                <p className="text-[10px] text-slate-500 uppercase">Seeds</p>
                <p className="text-xl font-bold">{seeds.length}</p>
              </div>
              <div className="bg-slate-900/50 p-3 rounded-xl border border-slate-800">
                <p className="text-[10px] text-slate-500 uppercase">Res</p>
                <p className="text-xl font-bold">
                  {dims.width}x{dims.height}
                </p>
              </div>
            </div>
            {status === 'tracking' && (
              <div className="mt-4 p-3 bg-sky-500/10 border border-sky-400/30 rounded-xl animate-pulse text-sky-200 text-xs">
                ⚡ Analyzing video frames...
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
