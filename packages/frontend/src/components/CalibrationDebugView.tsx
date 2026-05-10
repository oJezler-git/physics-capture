import { useMemo } from 'react';
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
