import React, { useMemo, useRef, useState } from 'react';
import type { BallSeed } from '../types';

const BALL_COLORS = ['#3b82f6', '#10b981', '#f59e0b'];

type SeedMode = 'click' | 'bbox';

interface BallSeedPickerProps {
  cameraId: string | null;
  currentFrame: number;
  frameWidth: number;
  frameHeight: number;
  seeds: BallSeed[];
  onAddSeed: (seed: BallSeed) => boolean;
  interactive?: boolean;
  className?: string;
}

interface BboxDraft {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeBbox(draft: BboxDraft): BboxDraft {
  return {
    x0: Math.min(draft.x0, draft.x1),
    y0: Math.min(draft.y0, draft.y1),
    x1: Math.max(draft.x0, draft.x1),
    y1: Math.max(draft.y0, draft.y1),
  };
}

export const BallSeedPicker: React.FC<BallSeedPickerProps> = ({
  cameraId,
  currentFrame,
  frameWidth,
  frameHeight,
  seeds,
  onAddSeed,
  interactive = true,
  className,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<SeedMode>('click');
  const [warning, setWarning] = useState<string | null>(null);
  const [bboxDraft, setBboxDraft] = useState<BboxDraft | null>(null);
  const [isDraggingBbox, setIsDraggingBbox] = useState(false);

  const cameraSeeds = useMemo(
    () => (cameraId ? seeds.filter((seed) => seed.cameraId === cameraId) : []),
    [cameraId, seeds],
  );

  const nextBallId = useMemo(() => {
    const used = new Set(cameraSeeds.map((seed) => seed.ballId));
    for (let index = 0; index < 3; index += 1) {
      if (!used.has(index)) {
        return index;
      }
    }
    return null;
  }, [cameraSeeds]);

  function toFrameCoordinates(event: React.MouseEvent<HTMLDivElement>) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;

    const xRatio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const yRatio = clamp((event.clientY - rect.top) / rect.height, 0, 1);

    return {
      x: xRatio * frameWidth,
      y: yRatio * frameHeight,
    };
  }

  function placeSeed(point: { x: number; y: number }, bbox?: [number, number, number, number]) {
    if (!cameraId) {
      setWarning('Select a camera before placing seeds.');
      return;
    }

    if (currentFrame !== 0) {
      setWarning('Seeds must be placed on frame 0.');
      return;
    }

    if (nextBallId === null) {
      setWarning('Maximum 3 balls reached for this camera.');
      return;
    }

    const accepted = onAddSeed({
      ballId: nextBallId,
      cameraId,
      frameIdx: 0,
      x: point.x,
      y: point.y,
      bbox,
    });

    if (!accepted) {
      setWarning('Maximum 3 balls reached for this camera.');
      return;
    }

    setWarning(null);
  }

  const handleClickSeed = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!interactive || mode !== 'click') return;

    const point = toFrameCoordinates(event);
    if (!point) return;

    placeSeed(point);
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!interactive || mode !== 'bbox') return;
    const point = toFrameCoordinates(event);
    if (!point) return;

    setIsDraggingBbox(true);
    setBboxDraft({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!interactive || !isDraggingBbox || !bboxDraft) return;
    const point = toFrameCoordinates(event);
    if (!point) return;

    setBboxDraft((prev) => (prev ? { ...prev, x1: point.x, y1: point.y } : prev));
  };

  const handleMouseUp = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!interactive || mode !== 'bbox' || !bboxDraft) return;

    const point = toFrameCoordinates(event);
    const finalDraft = point
      ? {
          ...bboxDraft,
          x1: point.x,
          y1: point.y,
        }
      : bboxDraft;

    const normalized = normalizeBbox(finalDraft);

    const minWidth = 6;
    const minHeight = 6;
    if (normalized.x1 - normalized.x0 < minWidth || normalized.y1 - normalized.y0 < minHeight) {
      setWarning('Draw a larger box to seed in bbox mode.');
      setBboxDraft(null);
      setIsDraggingBbox(false);
      return;
    }

    placeSeed(
      {
        x: (normalized.x0 + normalized.x1) / 2,
        y: (normalized.y0 + normalized.y1) / 2,
      },
      [normalized.x0, normalized.y0, normalized.x1, normalized.y1],
    );

    setBboxDraft(null);
    setIsDraggingBbox(false);
  };

  const draftRect = useMemo(() => {
    if (!bboxDraft) return null;
    return normalizeBbox(bboxDraft);
  }, [bboxDraft]);

  return (
    <div className="absolute inset-0">
      <div className="absolute left-4 top-16 z-20 flex items-center gap-2 rounded-xl border border-white/15 bg-black/55 px-3 py-2 backdrop-blur-sm">
        <button
          type="button"
          onClick={() => setMode('click')}
          disabled={!interactive}
          className={`rounded-md px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition ${
            mode === 'click' ? 'bg-indigo-500 text-white' : 'bg-slate-700 text-slate-200 hover:bg-slate-600'
          }`}
        >
          Click
        </button>
        <button
          type="button"
          onClick={() => setMode('bbox')}
          disabled={!interactive}
          className={`rounded-md px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition ${
            mode === 'bbox' ? 'bg-indigo-500 text-white' : 'bg-slate-700 text-slate-200 hover:bg-slate-600'
          }`}
        >
          BBox
        </button>
        <span className="text-[10px] font-mono text-slate-200">{cameraSeeds.length} / 3</span>
      </div>

      {warning ? (
        <div className="absolute bottom-4 left-4 z-20 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200">
          {warning}
        </div>
      ) : null}

      <div
        ref={containerRef}
        className={`${className ?? ''} ${interactive ? 'pointer-events-auto' : 'pointer-events-none'}`}
        onClick={handleClickSeed}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        {cameraSeeds.map((seed) => {
          const left = (seed.x / frameWidth) * 100;
          const top = (seed.y / frameHeight) * 100;
          const color = BALL_COLORS[seed.ballId % BALL_COLORS.length];

          return (
            <div
              key={`${seed.cameraId}-${seed.ballId}`}
              className="absolute h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/90 text-xs font-black text-white shadow-lg"
              style={{ left: `${left}%`, top: `${top}%`, backgroundColor: color }}
              title={`Ball ${seed.ballId + 1}`}
            >
              <div className="grid h-full w-full place-items-center">{seed.ballId + 1}</div>
            </div>
          );
        })}

        {draftRect ? (
          <div
            className="absolute border-2 border-indigo-400 bg-indigo-500/10"
            style={{
              left: `${(draftRect.x0 / frameWidth) * 100}%`,
              top: `${(draftRect.y0 / frameHeight) * 100}%`,
              width: `${((draftRect.x1 - draftRect.x0) / frameWidth) * 100}%`,
              height: `${((draftRect.y1 - draftRect.y0) / frameHeight) * 100}%`,
            }}
          />
        ) : null}
      </div>
    </div>
  );
};

