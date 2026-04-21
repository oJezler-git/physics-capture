import React, { useEffect, useState, useRef } from 'react';

interface SyncDebugViewProps {
  experimentId: string;
  currentFrame: number;
}

interface SyncDiagnostics {
  gray?: number;
  phase?: number;
  magnitude?: number;
  score?: number;
  border?: number;
  status: 'idle' | 'loading' | 'ready' | 'error';
  rms_ms?: number;
  true_fps?: number;
}

export const SyncDebugView: React.FC<SyncDebugViewProps> = ({ experimentId, currentFrame }) => {
  const [diagnostics, setDiagnostics] = useState<SyncDiagnostics>({ status: 'idle' });
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!experimentId) return;

    const fetchSyncDebug = async () => {
      setDiagnostics((prev) => ({ ...prev, status: 'loading' }));
      try {
        // We use a special debug endpoint that returns both the rectified image and the decode data
        const res = await fetch(`/api/debug/sync/${experimentId}/frame/${currentFrame}/cam/0`);
        if (!res.ok) throw new Error('Failed to fetch sync debug data');
        
        const data = await res.json();
        setDiagnostics({
          gray: data.gray,
          phase: data.phase,
          magnitude: data.magnitude,
          score: data.score,
          border: data.border,
          rms_ms: data.rms_ms,
          true_fps: data.true_fps,
          status: 'ready'
        });

        // Draw the rectified ROI if available
        if (data.roi_base64 && canvasRef.current) {
          const img = new Image();
          img.onload = () => {
            const ctx = canvasRef.current?.getContext('2d');
            if (ctx && canvasRef.current) {
              ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
              ctx.drawImage(img, 0, 0, canvasRef.current.width, canvasRef.current.height);
            }
          };
          img.src = `data:image/png;base64,${data.roi_base64}`;
        }
      } catch (err) {
        console.error(err);
        setDiagnostics({ status: 'error' });
      }
    };

    fetchSyncDebug();
  }, [experimentId, currentFrame]);

  return (
    <div className="flex flex-col h-full w-full bg-slate-900/50 p-6 gap-6 overflow-hidden">
      <div className="grid gap-6 lg:grid-cols-[1fr_300px] h-full">
        {/* Main Preview Area */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
              Rectified Sync ROI (400x200)
            </h3>
            <div className="flex gap-2">
              <span className={`ui-pill ${diagnostics.status === 'ready' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>
                {diagnostics.status.toUpperCase()}
              </span>
            </div>
          </div>

          <div className="relative aspect-[2/1] w-full bg-black rounded-xl border border-slate-800 overflow-hidden shadow-2xl group">
            <canvas 
              ref={canvasRef} 
              width={400} 
              height={200}
              className="h-full w-full object-contain image-render-pixelated"
            />
            
            {/* Overlay Grid / Center Line */}
            <div className="absolute inset-0 pointer-events-none border border-white/5" />
            <div className="absolute left-1/2 top-0 bottom-0 w-px bg-white/10" />
            <div className="absolute top-1/2 left-0 right-0 h-px bg-white/10" />

            {diagnostics.status === 'loading' && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500" />
              </div>
            )}
          </div>

          <div className="mt-auto grid grid-cols-4 gap-3">
            <DiagnosticTile label="Gray Counter" value={diagnostics.gray} unit="" color="text-sky-400" />
            <DiagnosticTile label="Phase" value={diagnostics.phase?.toFixed(3)} unit="rad" color="text-indigo-400" />
            <DiagnosticTile label="Grating Mag" value={diagnostics.magnitude?.toFixed(0)} unit="px" color="text-emerald-400" />
            <DiagnosticTile label="Detection Score" value={diagnostics.score?.toFixed(2)} unit="" color="text-orange-400" />
          </div>
        </div>

        {/* Sidebar: Overall Fit Stats */}
        <div className="flex flex-col gap-6 border-l border-slate-800 pl-6">
          <div className="space-y-4">
            <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
              Global Fit Quality
            </h3>
            
            <div className="space-y-2">
              <div className="rounded-xl bg-black/40 p-4 border border-slate-800">
                <span className="block text-[10px] text-slate-500 uppercase tracking-widest font-bold mb-1">
                  RMS Residual
                </span>
                <div className="flex items-baseline gap-1">
                  <span className={`text-2xl font-mono font-black ${diagnostics.rms_ms && diagnostics.rms_ms > 25 ? 'text-rose-500' : 'text-slate-100'}`}>
                    {diagnostics.rms_ms?.toFixed(2) || '---'}
                  </span>
                  <span className="text-xs text-slate-600">ms</span>
                </div>
                <div className="mt-2 h-1 w-full bg-slate-800 rounded-full overflow-hidden">
                  <div 
                    className={`h-full transition-all ${diagnostics.rms_ms && diagnostics.rms_ms > 25 ? 'bg-rose-500' : 'bg-sky-500'}`}
                    style={{ width: `${Math.min(100, (diagnostics.rms_ms || 0) * 2)}%` }}
                  />
                </div>
              </div>

              <div className="rounded-xl bg-black/40 p-4 border border-slate-800">
                <span className="block text-[10px] text-slate-500 uppercase tracking-widest font-bold mb-1">
                  Effective FPS
                </span>
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-mono font-black text-slate-100">
                    {diagnostics.true_fps?.toFixed(3) || '---'}
                  </span>
                  <span className="text-xs text-slate-600">Hz</span>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-auto p-4 rounded-xl bg-orange-500/5 border border-orange-500/10">
            <p className="text-[10px] text-orange-200/60 leading-relaxed uppercase tracking-wider font-medium">
              The rectified view shows the crop identified by the border search. If it is "too zoomed in", the corners are being found incorrectly.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

const DiagnosticTile = ({ label, value, unit, color }: { label: string, value: any, unit: string, color: string }) => (
  <div className="rounded-xl bg-black/40 p-3 border border-slate-800 flex flex-col justify-between min-h-[80px]">
    <span className="text-[9px] text-slate-500 uppercase tracking-widest font-bold">{label}</span>
    <div className="flex items-baseline gap-1">
      <span className={`text-xl font-mono font-black ${color}`}>
        {value !== undefined ? value : '---'}
      </span>
      <span className="text-[10px] text-slate-600 font-bold">{unit}</span>
    </div>
  </div>
);
