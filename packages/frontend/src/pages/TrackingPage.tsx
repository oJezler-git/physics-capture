import { useState, useEffect, useRef } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useTrackingStore } from '../stores/trackingStore';
import { FrameScrubber } from '../components/FrameScrubber';
import { TrajectoryCanvas } from '../components/TrajectoryCanvas';
import { 
  Settings2, 
  Maximize2, 
  Camera, 
  MousePointer2, 
  Zap, 
  ChevronRight,
  RefreshCw,
  AlertCircle
} from 'lucide-react';

export const TrackingPage = () => {
  const { cameras, advancePhase } = useSessionStore();
  const { 
    frameCount, 
    currentFrame, 
    setFrame, 
    tracks, 
    status, 
    progress,
    seeds,
    startTracking
  } = useTrackingStore();

  const [isPlaying, setIsPlaying] = useState(false);
  const [activeCameraId, setActiveCameraId] = useState<string | null>(null);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Set initial active camera
  useEffect(() => {
    if (cameras.length > 0 && !activeCameraId) {
      setActiveCameraId(cameras[0].id);
    }
  }, [cameras, activeCameraId]);

  // Playback Loop
  useEffect(() => {
    if (isPlaying) {
      playRef.current = setInterval(() => {
        setFrame((currentFrame + 1) % frameCount);
      }, 100); // 10 FPS preview
    } else {
      if (playRef.current) clearInterval(playRef.current);
    }
    return () => {
      if (playRef.current) clearInterval(playRef.current);
    };
  }, [isPlaying, currentFrame, frameCount, setFrame]);

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        setIsPlaying(p => !p);
      } else if (e.code === 'ArrowRight') {
        setFrame(Math.min(currentFrame + 1, frameCount - 1));
      } else if (e.code === 'ArrowLeft') {
        setFrame(Math.max(currentFrame - 1, 0));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentFrame, frameCount, setFrame]);

  const handleFrameClick = (_e: React.MouseEvent<HTMLDivElement>) => {
    if (!activeCameraId) return;
    
    // const rect = e.currentTarget.getBoundingClientRect();
    // const _x = e.clientX - rect.left;
    // const _y = e.clientY - rect.top;

    // Normalizing coordinates (assuming 1280x720 or similar for now)
    // In a real scenario, we'd scale based on naturalWidth/Height of image
    // For now, let's just use the raw coordinates for the prototype
    
    // addSeed({
    //   ballId: seeds.length, // simple ball ID assignment
    //   cameraId: activeCameraId,
    //   frameIdx: 0,
    //   x,
    //   y
    // });
  };

  const activeCamera = cameras.find(c => c.id === activeCameraId);

  return (
    <div className="max-w-[1600px] mx-auto flex flex-col gap-6 h-[calc(100vh-120px)]">
      {/* Header Info */}
      <header className="flex justify-between items-center bg-slate-900 p-4 rounded-2xl border border-slate-800 shadow-xl">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <div className="bg-indigo-500/20 p-2.5 rounded-xl border border-indigo-500/30">
              <MousePointer2 size={20} className="text-indigo-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white tracking-tight">Point Tracking</h1>
              <p className="text-slate-500 text-[10px] font-bold uppercase tracking-widest">
                Review & Correct Trajectories
              </p>
            </div>
          </div>

          <div className="h-10 w-px bg-slate-800" />

          {/* Status Indicator */}
          <div className="flex items-center gap-4">
            <div className="flex flex-col">
              <span className="text-[9px] font-bold text-slate-500 uppercase tracking-tighter">Current Status</span>
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${status === 'tracking' ? 'bg-yellow-500 animate-pulse' : 'bg-emerald-500'}`} />
                <span className="text-sm font-bold capitalize">{status}</span>
              </div>
            </div>
            {status === 'tracking' && (
              <div className="w-48 h-2 bg-slate-800 rounded-full overflow-hidden border border-slate-700">
                <div 
                  className="h-full bg-indigo-500 transition-all duration-300" 
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button className="p-3 text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition-all border border-transparent hover:border-slate-700">
            <RefreshCw size={20} />
          </button>
          <button 
            onClick={advancePhase}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-3 rounded-xl font-bold transition-all shadow-lg shadow-indigo-500/20"
          >
            Finalize Data <ChevronRight size={18} />
          </button>
        </div>
      </header>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-4 gap-6 min-h-0">
        {/* Main Viewport */}
        <div className="lg:col-span-3 flex flex-col gap-4 min-h-0">
          <div className="flex-1 bg-black rounded-2xl border border-slate-800 shadow-2xl overflow-hidden relative group">
            {/* The Image/Frame */}
            <div 
              className="w-full h-full flex items-center justify-center cursor-crosshair relative"
              onClick={handleFrameClick}
            >
              {/* Placeholder for Frame Image */}
              <div className="text-slate-800 font-mono text-9xl select-none opacity-20 uppercase font-black italic">
                FRAME {currentFrame}
              </div>

              {/* Trajectory Canvas Overlay */}
              <TrajectoryCanvas
                tracks={tracks}
                currentFrame={currentFrame}
                cameraId={activeCameraId || ''}
                width={1280} // These should be dynamic based on frame size
                height={720}
              />

              {/* Seed/Marker Overlays */}
              {seeds.filter(s => s.cameraId === activeCameraId).map(seed => (
                <div 
                  key={`${seed.ballId}-${seed.cameraId}`}
                  className="absolute w-8 h-8 -ml-4 -mt-4 border-2 border-white rounded-full flex items-center justify-center bg-white/20 backdrop-blur-sm pointer-events-none"
                  style={{ left: seed.x, top: seed.y }}
                >
                  <span className="text-[10px] font-bold text-white">{seed.ballId}</span>
                </div>
              ))}
            </div>

            {/* Viewport UI Overlays */}
            <div className="absolute top-4 left-4 flex gap-2">
              <div className="bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-lg border border-white/10 text-[10px] font-bold uppercase tracking-widest flex items-center gap-2">
                <Camera size={14} className="text-indigo-400" />
                {activeCamera?.label || 'No Camera Selected'}
              </div>
              <div className="bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-lg border border-white/10 text-[10px] font-mono text-indigo-400">
                {currentFrame} / {frameCount}
              </div>
            </div>

            <div className="absolute top-4 right-4 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
              <button className="p-2 bg-black/60 backdrop-blur-md rounded-lg border border-white/10 text-white hover:bg-indigo-500 transition-colors">
                <Maximize2 size={18} />
              </button>
              <button className="p-2 bg-black/60 backdrop-blur-md rounded-lg border border-white/10 text-white hover:bg-indigo-500 transition-colors">
                <Settings2 size={18} />
              </button>
            </div>
            
            {/* Legend */}
            <div className="absolute bottom-4 right-4 flex gap-4 bg-black/60 backdrop-blur-md px-4 py-2 rounded-xl border border-white/10">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-blue-500" />
                <span className="text-[10px] font-bold text-slate-300 uppercase tracking-tighter">Ball 0</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-emerald-500" />
                <span className="text-[10px] font-bold text-slate-300 uppercase tracking-tighter">Ball 1</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-amber-500" />
                <span className="text-[10px] font-bold text-slate-300 uppercase tracking-tighter">Ball 2</span>
              </div>
            </div>
          </div>

          {/* Scrubber Area */}
          <FrameScrubber
            currentFrame={currentFrame}
            frameCount={frameCount || 1}
            onFrameChange={setFrame}
            isPlaying={isPlaying}
            onPlayToggle={() => setIsPlaying(!isPlaying)}
          />
        </div>

        {/* Sidebar Controls */}
        <div className="flex flex-col gap-6 min-h-0 overflow-y-auto pr-2 custom-scrollbar">
          {/* Camera Selector */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-col gap-4 shadow-lg">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">Active Camera</h3>
            <div className="space-y-2">
              {cameras.map(cam => (
                <button
                  key={cam.id}
                  onClick={() => setActiveCameraId(cam.id)}
                  className={`w-full flex items-center justify-between p-3 rounded-xl transition-all border ${
                    activeCameraId === cam.id 
                      ? 'bg-indigo-500/10 border-indigo-500/50 text-indigo-400' 
                      : 'bg-slate-800/50 border-slate-700 text-slate-400 hover:border-slate-600'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Camera size={16} />
                    <span className="text-sm font-bold">{cam.label}</span>
                  </div>
                  {activeCameraId === cam.id && <div className="w-1.5 h-1.5 bg-indigo-500 rounded-full shadow-[0_0_8px_rgba(99,102,241,0.8)]" />}
                </button>
              ))}
            </div>
          </div>

          {/* Tracking Controls */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col gap-5 shadow-lg">
            <div className="flex justify-between items-center">
              <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">Tracking Logic</h3>
              <div className="bg-emerald-500/10 text-emerald-500 px-2 py-0.5 rounded text-[10px] font-black italic">SAM-2</div>
            </div>
            
            <div className="space-y-4">
              <div className="p-4 bg-slate-950 rounded-xl border border-slate-800 flex flex-col gap-2">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] font-bold text-slate-400 uppercase">Seeds Placed</span>
                  <span className="font-mono text-xs text-white bg-slate-800 px-2 py-0.5 rounded border border-slate-700">
                    {seeds.filter(s => s.cameraId === activeCameraId).length} / 3
                  </span>
                </div>
                <div className="text-[10px] text-slate-500 italic leading-relaxed">
                  * Click in the viewport to place initial seeds for SAM2.
                </div>
              </div>

              <button 
                disabled={seeds.length === 0 || status === 'tracking'}
                onClick={startTracking}
                className={`w-full flex items-center justify-center gap-2 py-4 rounded-xl font-bold transition-all ${
                  seeds.length > 0 && status !== 'tracking'
                    ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/20'
                    : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700'
                }`}
              >
                <Zap size={18} fill={seeds.length > 0 ? "white" : "none"} /> Run Auto-Tracker
              </button>
            </div>
          </div>

          {/* Quality Alerts */}
          {tracks.length > 0 && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-4 flex flex-col gap-3">
              <div className="flex items-center gap-2 text-red-500">
                <AlertCircle size={16} />
                <h3 className="text-[10px] font-black uppercase tracking-widest">Confidence Alerts</h3>
              </div>
              <p className="text-[10px] text-red-200/60 leading-tight">
                Points in red show low SAM2 confidence. Scrub to those frames and apply corrections.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
