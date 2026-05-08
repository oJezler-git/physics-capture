import { BallSeedPicker, type SeedMode } from '../BallSeedPicker';
import { TrajectoryCanvas } from '../TrajectoryCanvas';
import { SyncDebugView } from '../SyncDebugView';
import { ThreeDScene } from '../ThreeDScene';
import type { Reconstruction3D, PhysicsResult } from '../../types';

interface DebugMainViewProps {
  mode: 'sam2' | 'sync' | '3d';
  dims: { width: number; height: number };
  onDimsChange: (dims: { width: number; height: number }) => void;
  frameSrc: string | null;
  onFrameImageStateChange: (state: 'idle' | 'loading' | 'ready' | 'error') => void;
  frameImageState: 'idle' | 'loading' | 'ready' | 'error';
  selectedExp: string;
  isFrameMissing: boolean;
  safeFrame: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tracks: any[];
  maxBalls: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  seeds: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onAddSeed: (seed: any) => void;
  seedMode: SeedMode;
  physicsResult: PhysicsResult | null;
  frameFile: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  diagnostics: any;
}

export const DebugMainView = ({
  mode,
  dims,
  onDimsChange,
  frameSrc,
  onFrameImageStateChange,
  frameImageState,
  selectedExp,
  isFrameMissing,
  safeFrame,
  tracks,
  maxBalls,
  seeds,
  onAddSeed,
  seedMode,
  physicsResult,
  frameFile,
  diagnostics,
}: DebugMainViewProps) => {
  if (mode === 'sam2') {
    return (
      <div
        className="relative bg-black shadow-2xl overflow-hidden"
        style={{
          aspectRatio: `${dims.width} / ${dims.height}`,
          maxHeight: '100%',
          maxWidth: '100%',
        }}
      >
        {frameSrc && (
          <img
            src={frameSrc}
            className="h-full w-full object-contain block"
            onLoad={(e) => {
              onDimsChange({
                width: e.currentTarget.naturalWidth,
                height: e.currentTarget.naturalHeight,
              });
              onFrameImageStateChange('ready');
            }}
            onError={() => onFrameImageStateChange('error')}
          />
        )}
        {!selectedExp && (
          <div className="absolute inset-0 flex items-center justify-center text-slate-600 font-mono tracking-widest uppercase text-xs">
            -- No Experiment Selected --
          </div>
        )}
        {frameImageState === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900/90 text-rose-500 font-bold uppercase tracking-tighter">
            [ ERROR: FRAME NOT FOUND ]
          </div>
        )}

        {isFrameMissing && (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-panel)]/80 text-[var(--accent)] backdrop-blur-md">
            <div className="text-center rounded-3xl border border-[var(--accent)] p-10 bg-[var(--bg-surface)] shadow-sm">
              <p className="text-5xl mb-5">⚠️</p>
              <p className="font-medium uppercase tracking-widest text-lg">Omitted Frame</p>
              <p className="text-[11px] opacity-60 mt-3 font-mono">PHYSICAL_IDX: {safeFrame}</p>
            </div>
          </div>
        )}

        <TrajectoryCanvas
          width={dims.width}
          height={dims.height}
          tracks={tracks}
          currentFrame={safeFrame}
          cameraId="0"
        />

        <BallSeedPicker
          cameraId="0"
          currentFrame={safeFrame}
          seedFrameIdx={safeFrame}
          maxBalls={maxBalls}
          frameWidth={dims.width}
          frameHeight={dims.height}
          seeds={seeds}
          onAddSeed={onAddSeed}
          mode={seedMode}
        />
      </div>
    );
  }

  if (mode === 'sync') {
    return <SyncDebugView experimentId={selectedExp} currentFrame={safeFrame} />;
  }

  if (mode === '3d') {
    return (
      <div className="relative h-full w-full">
        {physicsResult ? (
          <ThreeDScene
            balls={physicsResult.balls}
            currentFrame={safeFrame}
            reconstruction3d={physicsResult.reconstruction3d as Reconstruction3D}
            experimentId={selectedExp}
            frameFile={frameFile}
            frameAspect={dims.width > 0 && dims.height > 0 ? dims.width / dims.height : 16 / 9}
            diagnostics={diagnostics}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-slate-600 font-mono tracking-widest uppercase text-xs">
            -- Run Physics to see 3D Reconstruction --
          </div>
        )}
      </div>
    );
  }

  return null;
};
