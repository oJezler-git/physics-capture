import React, { useMemo, useRef, useState } from 'react';
import type { BallSeed } from '../types';

const BALL_COLORS = ['#4cc3ff', '#9ad46f', '#ff7244'];

export type SeedMode = 'click' | 'bbox';

interface BallSeedPickerProps {
  cameraId: string | null;
  currentFrame: number;
  seedFrameIdx: number;
  maxBalls: number;
  frameWidth: number;
  frameHeight: number;
  seeds: BallSeed[];
  onAddSeed: (seed: BallSeed) => boolean;
  interactive?: boolean;
  className?: string;
  mode?: SeedMode;
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

/**
 * Computes the rendered image rect inside a container that uses object-contain.
 * Returns { left, top, width, height } in pixels relative to the container.
 */
function getObjectContainRect(
  containerWidth: number,
  containerHeight: number,
  imageWidth: number,
  imageHeight: number,
): { left: number; top: number; width: number; height: number } {
  if (imageWidth <= 0 || imageHeight <= 0) {
    return { left: 0, top: 0, width: containerWidth, height: containerHeight };
  }

  const containerAspect = containerWidth / containerHeight;
  const imageAspect = imageWidth / imageHeight;

  let renderWidth: number;
  let renderHeight: number;

  if (imageAspect > containerAspect) {
    // Image is wider → letterboxed top/bottom
    renderWidth = containerWidth;
    renderHeight = containerWidth / imageAspect;
  } else {
    // Image is taller → pillarboxed left/right
    renderHeight = containerHeight;
    renderWidth = containerHeight * imageAspect;
  }

  return {
    left: (containerWidth - renderWidth) / 2,
    top: (containerHeight - renderHeight) / 2,
    width: renderWidth,
    height: renderHeight,
  };
}

export const BallSeedPicker: React.FC<BallSeedPickerProps> = ({
  cameraId,
  currentFrame,
  seedFrameIdx,
  maxBalls,
  frameWidth,
  frameHeight,
  seeds,
  onAddSeed,
  interactive = true,
  className,
  mode = 'click',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [bboxDraft, setBboxDraft] = useState<BboxDraft | null>(null);
  const [isDraggingBbox, setIsDraggingBbox] = useState(false);

  // Only show seeds for current camera + current frame
  const visibleSeeds = useMemo(
    () =>
      cameraId
        ? seeds.filter((seed) => seed.cameraId === cameraId && seed.frameIdx === currentFrame)
        : [],
    [cameraId, seeds, currentFrame],
  );

  const cameraSeeds = useMemo(
    () => (cameraId ? seeds.filter((seed) => seed.cameraId === cameraId) : []),
    [cameraId, seeds],
  );

  const nextBallId = useMemo(() => {
    const used = new Set(cameraSeeds.map((seed) => seed.ballId));
    for (let index = 0; index < maxBalls; index += 1) {
      if (!used.has(index)) return index;
    }
    return null;
  }, [cameraSeeds, maxBalls]);

  /**
   * Convert a mouse event to normalized [0,1] coordinates in IMAGE space,
   * correctly accounting for object-contain letterbox/pillarbox bars.
   */
  function toImageNormalized(event: React.MouseEvent<HTMLDivElement>) {
    const el = containerRef.current;
    if (!el) return null;

    const rect = el.getBoundingClientRect();
    const imgRect = getObjectContainRect(rect.width, rect.height, frameWidth, frameHeight);

    const xInImage = event.clientX - rect.left - imgRect.left;
    const yInImage = event.clientY - rect.top - imgRect.top;

    // Clamp to [0,1] — clicks outside the image area snap to the nearest edge
    return {
      x: clamp(xInImage / imgRect.width, 0, 1),
      y: clamp(yInImage / imgRect.height, 0, 1),
    };
  }

  function placeSeed(point: { x: number; y: number }, bbox?: [number, number, number, number]) {
    if (!cameraId) {
      setWarning('Select a camera before placing seeds.');
      return;
    }
    if (currentFrame !== seedFrameIdx) {
      setWarning(`Seeds must be placed on frame ${seedFrameIdx + 1}. Current: ${currentFrame + 1}`);
      return;
    }
    if (nextBallId === null) {
      setWarning(`Maximum ${maxBalls} balls reached for this camera.`);
      return;
    }

    const accepted = onAddSeed({
      ballId: nextBallId,
      cameraId,
      frameIdx: seedFrameIdx,
      x: point.x,
      y: point.y,
      bbox,
    });

    if (!accepted) {
      setWarning(`Maximum ${maxBalls} balls reached for this camera.`);
      return;
    }
    setWarning(null);
  }

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!interactive || mode !== 'click') return;
    const point = toImageNormalized(event);
    if (point) placeSeed(point);
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!interactive || mode !== 'bbox') return;
    const point = toImageNormalized(event);
    if (!point) return;
    setIsDraggingBbox(true);
    setBboxDraft({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!interactive || !isDraggingBbox || !bboxDraft) return;
    const point = toImageNormalized(event);
    if (!point) return;
    setBboxDraft((prev) => (prev ? { ...prev, x1: point.x, y1: point.y } : prev));
  };

  const handleMouseUp = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!interactive || mode !== 'bbox' || !bboxDraft) return;
    const point = toImageNormalized(event);
    const finalDraft = point ? { ...bboxDraft, x1: point.x, y1: point.y } : bboxDraft;
    const normalized = normalizeBbox(finalDraft);

    const minWidth = 6 / (frameWidth || 1280);
    const minHeight = 6 / (frameHeight || 720);
    if (normalized.x1 - normalized.x0 < minWidth || normalized.y1 - normalized.y0 < minHeight) {
      setWarning('Draw a larger box to seed in bbox mode.');
      setBboxDraft(null);
      setIsDraggingBbox(false);
      return;
    }

    placeSeed({ x: (normalized.x0 + normalized.x1) / 2, y: (normalized.y0 + normalized.y1) / 2 }, [
      normalized.x0,
      normalized.y0,
      normalized.x1,
      normalized.y1,
    ]);
    setBboxDraft(null);
    setIsDraggingBbox(false);
  };

  const draftRect = useMemo(() => (bboxDraft ? normalizeBbox(bboxDraft) : null), [bboxDraft]);

  // SVG coordinate space — matches TrajectoryCanvas exactly
  const svgW = frameWidth || 1280;
  const svgH = frameHeight || 720;
  // Seed dot radius: ~1.5% of image width so it scales with the image, min 10px equivalent
  const dotR = Math.max(svgW * 0.015, 10);

  return (
    <div className="absolute inset-0">
      {warning && (
        <div className="absolute bottom-4 left-4 z-40 rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100">
          {warning}
        </div>
      )}

      {/* Invisible click/drag capture layer spanning the full container */}
      <div
        ref={containerRef}
        className={`${className ?? ''} absolute inset-0 ${
          interactive ? 'pointer-events-auto cursor-crosshair' : 'pointer-events-none'
        }`}
        onClick={handleClick}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        style={{ zIndex: 30 }}
      />

      {/*
        SVG overlay that uses the SAME viewBox + preserveAspectRatio="xMidYMid meet"
        as TrajectoryCanvas. This means seed markers are rendered in image-pixel space
        and will NEVER drift regardless of container size, zoom level, or fullscreen.
      */}
      <svg
        className="absolute inset-0 pointer-events-none"
        viewBox={`0 0 ${svgW} ${svgH}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ zIndex: 31, width: '100%', height: '100%' }}
        aria-hidden="true"
      >
        {visibleSeeds.map((seed) => {
          const cx = seed.x * svgW;
          const cy = seed.y * svgH;
          const color = BALL_COLORS[seed.ballId % BALL_COLORS.length];

          return (
            <g key={`${seed.cameraId}-${seed.ballId}-${seed.frameIdx}`}>
              {/* Soft glow halo */}
              <circle cx={cx} cy={cy} r={dotR * 1.6} fill={color} opacity={0.15} />
              {/* Outer white ring */}
              <circle cx={cx} cy={cy} r={dotR + 2} fill="white" opacity={0.9} />
              {/* Coloured fill */}
              <circle cx={cx} cy={cy} r={dotR} fill={color} />
              {/* Ball number label */}
              <text
                x={cx}
                y={cy}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={dotR * 0.95}
                fontWeight="900"
                fill="white"
                style={{ userSelect: 'none' }}
              >
                {seed.ballId + 1}
              </text>
            </g>
          );
        })}

        {draftRect && (
          <rect
            x={draftRect.x0 * svgW}
            y={draftRect.y0 * svgH}
            width={(draftRect.x1 - draftRect.x0) * svgW}
            height={(draftRect.y1 - draftRect.y0) * svgH}
            fill="rgba(249,115,22,0.08)"
            stroke="#fb923c"
            strokeWidth="2"
            strokeDasharray="6 3"
          />
        )}
      </svg>
    </div>
  );
};
