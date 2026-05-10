import { useEffect, useMemo, useState } from 'react';
import { useCalibrationStore } from '../stores/calibrationStore';

interface CalibrationDebugViewProps {
  experimentId: string;
  frameSrc: string | null;
  currentFrame: number;
}

export const CalibrationDebugView = ({
  experimentId,
  frameSrc,
  currentFrame,
}: CalibrationDebugViewProps) => {
  const {
    status,
    progress,
    calibrationStage,
    stageMessage,
    reprojectionError,
    intrinsics,
    stereoExtrinsics,
    error,
  } = useCalibrationStore();

  const stageLabel = useMemo(() => {
    if (!calibrationStage) return 'idle';
    return calibrationStage.replace(/_/g, ' ').toLowerCase();
  }, [calibrationStage]);

  const [cam0DebugFiles, setCam0DebugFiles] = useState<string[]>([]);
  const [cam1DebugFiles, setCam1DebugFiles] = useState<string[]>([]);
  const [stereoDebugFiles, setStereoDebugFiles] = useState<string[]>([]);

  useEffect(() => {
    const loadDebugFiles = async (
      cameraId: 'cam0' | 'cam1' | 'stereo',
      setter: (files: string[]) => void,
    ) => {
      if (!experimentId) {
        setter([]);
        return;
      }
      try {
        const res = await fetch(`/api/experiments/${experimentId}/calibration-debug/${cameraId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = (await res.json()) as { files?: string[] };
        setter(payload.files ?? []);
      } catch {
        setter([]);
      }
    };
    loadDebugFiles('cam0', setCam0DebugFiles);
    loadDebugFiles('cam1', setCam1DebugFiles);
    loadDebugFiles('stereo', setStereoDebugFiles);
  }, [experimentId, status, progress]);

  return (
    <div className="flex h-full w-full flex-col gap-6 bg-slate-900/50 p-6 overflow-hidden">
      <div className="grid h-full gap-6 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
              Calibration Frame Preview
            </h3>
            <span
              className={`rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-widest ${
                status === 'complete'
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : status === 'failed'
                    ? 'bg-rose-500/20 text-rose-300'
                    : status === 'running'
                      ? 'bg-sky-500/20 text-sky-300'
                      : 'bg-slate-800 text-slate-400'
              }`}
            >
              {status}
            </span>
          </div>

          <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-slate-800 bg-black shadow-2xl">
            {frameSrc ? (
              <img src={frameSrc} className="h-full w-full object-contain" />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-slate-600 font-mono tracking-widest uppercase text-xs">
                -- Select Experiment --
              </div>
            )}
            <div className="absolute bottom-3 left-3 rounded-md bg-black/70 px-2 py-1 text-[10px] text-slate-300 font-mono">
              frame {currentFrame}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 border-l border-slate-800 pl-6">
          <section className="space-y-3">
            <h4 className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">
              Status
            </h4>
            <div className="rounded-xl border border-slate-800 bg-black/40 p-4 text-[11px] text-slate-300">
              <p className="uppercase tracking-wider text-slate-500 text-[10px] mb-1">Stage</p>
              <p>{stageLabel}</p>
              {stageMessage && <p className="mt-2 text-slate-400">{stageMessage}</p>}
              {status === 'running' && (
                <div className="mt-3">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                    <div
                      className="h-full bg-sky-500 transition-all duration-300"
                      style={{ width: `${Math.max(0, Math.min(100, progress * 100))}%` }}
                    />
                  </div>
                  <p className="mt-1 text-[10px] text-slate-500 font-mono">
                    {(progress * 100).toFixed(0)}%
                  </p>
                </div>
              )}
            </div>
          </section>

          <section className="grid grid-cols-2 gap-3">
            <Metric
              label="RMS Reproj"
              value={
                typeof reprojectionError === 'number' ? `${reprojectionError.toFixed(3)} px` : '---'
              }
            />
            <Metric
              label="Intrinsics"
              value={intrinsics.length > 0 ? `${intrinsics.length} cams` : '---'}
            />
            <Metric label="Stereo" value={stereoExtrinsics ? 'available' : 'missing'} />
            <Metric label="Experiment" value={experimentId || '---'} />
          </section>

          {error && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-[11px] text-rose-200">
              {error}
            </div>
          )}

          <section className="space-y-2">
            <h4 className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">
              Checkerboard Debug
            </h4>
            <p className="text-[10px] text-slate-400">
              Overlays from CV detection. Verify corners are on the board, not on scene artifacts.
            </p>
            <DebugStrip experimentId={experimentId} cameraId="cam0" files={cam0DebugFiles} />
            <DebugStrip experimentId={experimentId} cameraId="cam1" files={cam1DebugFiles} />
            <DebugStrip experimentId={experimentId} cameraId="stereo" files={stereoDebugFiles} />
          </section>
        </div>
      </div>
    </div>
  );
};

const Metric = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-xl border border-slate-800 bg-black/40 p-3">
    <p className="text-[9px] uppercase tracking-wider text-slate-500 mb-1">{label}</p>
    <p className="text-[11px] font-mono text-slate-200">{value}</p>
  </div>
);

const DebugStrip = ({
  experimentId,
  cameraId,
  files,
}: {
  experimentId: string;
  cameraId: 'cam0' | 'cam1' | 'stereo';
  files: string[];
}) => {
  const latest = files.slice(-4).reverse();
  return (
    <div className="rounded-xl border border-slate-800 bg-black/40 p-2">
      <p className="mb-2 text-[9px] uppercase tracking-wider text-slate-500">{cameraId}</p>
      {latest.length === 0 ? (
        <p className="text-[10px] text-slate-600">No debug overlays yet</p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {latest.map((f) => (
            <img
              key={`${cameraId}-${f}`}
              src={`/api/experiments/${experimentId}/calibration-debug/${cameraId}/${f}`}
              className="h-20 w-full rounded border border-slate-800 object-cover"
              title={f}
            />
          ))}
        </div>
      )}
    </div>
  );
};
