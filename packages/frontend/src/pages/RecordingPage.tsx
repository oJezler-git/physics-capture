import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSessionStore } from '../stores/sessionStore';
import { wsClient } from '../lib/wsClient';
import { VisualMetronome } from '../components/VisualMetronome';
import { Circle, Square, Video, Smartphone, Loader2, ArrowRight, CheckCircle2 } from 'lucide-react';

export const RecordingPage = () => {
  const navigate = useNavigate();
  const { experimentId, cameras, advancePhase } = useSessionStore();
  
  const [isRecording, setIsRecording] = useState(false);
  const [metronomeConfig, setMetronomeConfig] = useState<any>(null);
  const [frameCount, setFrameCount] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    let timer: any;
    if (isRecording) {
      timer = setInterval(() => setElapsed(e => e + 1), 1000);
    } else {
      setElapsed(0);
    }
    return () => clearInterval(timer);
  }, [isRecording]);

  useEffect(() => {
    const handleFramesReady = (event: any) => {
      setFrameCount(event.detail.data.frameCount);
    };
    window.addEventListener('ws:frames', handleFramesReady);
    return () => window.removeEventListener('ws:frames', handleFramesReady);
  }, []);

  const handleStart = () => {
    if (!experimentId) return;
    setIsRecording(true);
    wsClient.send({ type: 'record:start', experimentId });
  };

  const handleStop = () => {
    if (!experimentId) return;
    setIsRecording(false);
    wsClient.send({ type: 'record:stop', experimentId });
  };

  const formatTime = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <header className="flex justify-between items-center bg-slate-900 p-4 rounded-2xl border border-slate-800 shadow-xl">
        <div className="flex items-center gap-4">
          <div className="bg-slate-800 p-3 rounded-xl border border-slate-700">
            <Video className="text-indigo-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Record Experiment</h1>
            <p className="text-slate-500 text-xs font-medium uppercase tracking-widest">
              Master Session {experimentId?.slice(0, 8)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {isRecording && (
            <div className="flex items-center gap-3 bg-red-500/10 border border-red-500/30 px-4 py-2 rounded-xl">
              <div className="w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse" />
              <span className="text-lg font-mono font-bold text-red-500">{formatTime(elapsed)}</span>
            </div>
          )}
          
          {!isRecording ? (
            <button 
              onClick={handleStart}
              className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-3 rounded-xl font-bold transition-all shadow-lg shadow-emerald-500/20"
            >
              <Circle size={18} fill="white" /> Start Recording
            </button>
          ) : (
            <button 
              onClick={handleStop}
              className="flex items-center gap-2 bg-slate-100 hover:bg-white text-slate-950 px-6 py-3 rounded-xl font-bold transition-all shadow-lg"
            >
              <Square size={18} fill="currentColor" /> Stop Capture
            </button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[500px]">
        {/* Visual Metronome */}
        <div className="lg:col-span-2 flex flex-col gap-3">
          <div className="flex-1">
            <VisualMetronome 
              isActive={isRecording} 
              onConfigReady={setMetronomeConfig} 
            />
          </div>
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl flex items-center justify-between">
            <div className="flex items-center gap-2 text-slate-400">
              <span className="text-[10px] font-bold tracking-tighter uppercase">Sync Speed:</span>
              <span className="text-xs font-mono text-white bg-slate-800 px-2 py-0.5 rounded border border-slate-700">
                {metronomeConfig?.speed_px_per_frame.toFixed(4) || '---'} px/frame
              </span>
            </div>
            <div className="text-xs text-slate-500 italic">
              * Linear calibration active via rAF
            </div>
          </div>
        </div>

        {/* Live Previews */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-col gap-4 overflow-hidden">
          <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
            <Smartphone size={16} /> Live Monitors
          </h2>
          
          <div className="flex-1 overflow-y-auto space-y-3 pr-1 custom-scrollbar">
            {cameras.map(cam => (
              <div key={cam.id} className="relative aspect-video bg-black rounded-lg border border-slate-800 overflow-hidden group">
                {cam.stream ? (
                  <video 
                    autoPlay 
                    playsInline 
                    muted 
                    className="w-full h-full object-cover"
                    ref={el => { if (el) el.srcObject = cam.stream; }}
                  />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-slate-600">
                    <Loader2 size={24} className="animate-spin" />
                    <span className="text-[10px] font-bold uppercase tracking-widest">Negotiating Stream</span>
                  </div>
                )}
                <div className="absolute bottom-2 left-2 px-1.5 py-0.5 bg-black/60 backdrop-blur-md rounded text-[9px] font-bold uppercase tracking-wider border border-white/10">
                  {cam.label}
                </div>
              </div>
            ))}
            {cameras.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-600 italic text-sm">
                No cameras connected to this session.
              </div>
            )}
          </div>

          <div className="pt-4 border-t border-slate-800">
            {frameCount !== null ? (
              <button 
                onClick={() => {
                  advancePhase();
                  navigate('/tracking');
                }}
                className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-4 rounded-xl font-bold transition-all shadow-lg shadow-indigo-500/20"
              >
                Proceed to Tracking <ArrowRight size={18} />
              </button>
            ) : (
              <div className="flex items-center justify-center gap-2 text-slate-500 text-xs py-2">
                <Loader2 size={14} className="animate-spin" />
                Awaiting frame extraction...
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Post-Record Progress Toast */}
      {frameCount !== null && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 bg-slate-900 border border-emerald-500/50 p-4 rounded-2xl shadow-2xl flex items-center gap-4 animate-in slide-in-from-bottom duration-500 z-50">
          <div className="bg-emerald-500/20 p-2 rounded-full border border-emerald-500/50">
            <CheckCircle2 className="text-emerald-400" />
          </div>
          <div>
            <p className="text-white font-bold">Extraction Complete</p>
            <p className="text-slate-400 text-xs">{frameCount} frames ready for analysis.</p>
          </div>
          <button 
            onClick={() => {
              advancePhase();
              navigate('/tracking');
            }}
            className="bg-emerald-600 hover:bg-emerald-500 px-4 py-2 rounded-lg text-sm font-bold transition-colors"
          >
            Open Tracker
          </button>
        </div>
      )}
    </div>
  );
};
