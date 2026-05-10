import { Button } from '../ui/Button';

interface ExperimentSidebarProps {
  selectedExp: string;
  onExpChange: (exp: string) => void;
  experiments: string[];
  onRefreshExperiments: () => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
  onClear: () => void;
  onRunCalibration: () => void;
  onRunTrack: () => void;
  onRunPhysics: () => void;
  onRunEndToEnd: () => void;
  status: string;
  physicsStatus: string;
  isCalibrating: boolean;
  isEndToEndRunning: boolean;
  hasSeeds: boolean;
  hasStereoSeedOverlap: boolean;
}

export const ExperimentSidebar = ({
  selectedExp,
  onExpChange,
  experiments,
  onRefreshExperiments,
  selectedModel,
  onModelChange,
  onClear,
  onRunCalibration,
  onRunTrack,
  onRunPhysics,
  onRunEndToEnd,
  status,
  physicsStatus,
  isCalibrating,
  isEndToEndRunning,
  hasSeeds,
  hasStereoSeedOverlap,
}: ExperimentSidebarProps) => {
  return (
    <section className="space-y-6">
      <h3 className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
        Experiment
      </h3>

      <div className="space-y-4">
        <div className="flex flex-col gap-2">
          <label className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">
            Experiment
          </label>
          <div className="flex gap-2">
            <select
              className="flex-1 rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] px-4 py-2.5 text-[11px] font-mono outline-none focus:border-[var(--accent)] transition-colors"
              value={selectedExp}
              onChange={(e) => onExpChange(e.target.value)}
            >
              <option value="">Select Experiment</option>
              {experiments.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
            <Button
              onClick={onRefreshExperiments}
              className="rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] px-4 hover:text-[var(--accent)] transition-colors"
            >
              🔄
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">
            SAM2 Model
          </label>
          <select
            className="w-full rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] px-4 py-2.5 text-[11px] font-mono outline-none focus:border-[var(--accent)] transition-colors"
            value={selectedModel}
            onChange={(e) => onModelChange(e.target.value)}
          >
            <option value="facebook/sam2-hiera-tiny">Tiny (Fastest)</option>
            <option value="facebook/sam2-hiera-small">Small</option>
            <option value="facebook/sam2-hiera-base-plus">Base+</option>
            <option value="facebook/sam2-hiera-large">Large (Best)</option>
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3 pt-2">
          <Button
            onClick={onClear}
            className="rounded-xl border border-[var(--line)] bg-[var(--bg-panel)] py-2.5 text-[10px] font-medium uppercase tracking-wider text-slate-400 hover:text-slate-200 transition-colors"
          >
            Clear
          </Button>
          <Button
            variant="alt"
            onClick={onRunCalibration}
            disabled={isCalibrating || !selectedExp || isEndToEndRunning}
            className="py-2.5 text-[10px]"
          >
            {isCalibrating ? 'Calibrating...' : 'Run Calibration'}
          </Button>
          <Button
            variant="main"
            onClick={onRunTrack}
            disabled={status === 'tracking' || !selectedExp || !hasSeeds || isEndToEndRunning}
            className="py-2.5 text-[10px]"
          >
            {status === 'tracking' ? 'Tracking...' : 'Run Track'}
          </Button>
          <Button
            variant="alt"
            onClick={onRunPhysics}
            disabled={physicsStatus === 'computing' || !selectedExp || isEndToEndRunning}
            className="py-2.5 text-[10px]"
          >
            {physicsStatus === 'computing' ? 'Running Physics...' : 'Run Physics'}
          </Button>
          <Button
            variant="main"
            onClick={onRunEndToEnd}
            disabled={!selectedExp || !hasSeeds || isEndToEndRunning}
            className="col-span-2 py-2.5 text-[10px]"
          >
            {isEndToEndRunning
              ? 'Running End-to-End...'
              : 'Run End-to-End (Calib > Track > Physics)'}
          </Button>
        </div>
        {hasSeeds && !hasStereoSeedOverlap && (
          <p className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-[10px] font-medium leading-relaxed text-amber-200">
            Stereo physics needs at least one matching ball ID on both cameras. Switch cameras and
            place the same ball seed before running the full stereo pipeline.
          </p>
        )}
      </div>
    </section>
  );
};
