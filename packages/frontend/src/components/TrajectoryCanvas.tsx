import React, { useEffect, useMemo, useRef, useState } from 'react';
import { findNearestPoint, toNormalized } from '../lib/trajectory';
import type { BallTrack, CorrectionKeyframe } from '../types';

interface TrajectoryCanvasProps {
  tracks: BallTrack[];
  currentFrame: number;
  cameraId: string;
  width: number;
  height: number;
  onCorrection?: (correction: CorrectionKeyframe) => void;
  correctionEnabled?: boolean;
}

const BALL_COLORS = ['#4cc3ff', '#9ad46f', '#ff7244'];

export const TrajectoryCanvas: React.FC<TrajectoryCanvasProps> = ({
  tracks,
  currentFrame,
  cameraId,
  width,
  height,
  onCorrection,
  correctionEnabled = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragTargetRef = useRef<{ ballId: number; frameIdx: number } | null>(null);
  const [dragPosition, setDragPosition] = useState<{ x: number; y: number } | null>(null);

  const activeTracks = useMemo(
    () => tracks.filter((track) => track.cameraId === cameraId),
    [tracks, cameraId],
  );

  const correctedPoint = useMemo(() => {
    if (!dragTargetRef.current || !dragPosition) {
      return null;
    }

    const color = BALL_COLORS[dragTargetRef.current.ballId % BALL_COLORS.length];
    return { ...dragTargetRef.current, ...dragPosition, color };
  }, [dragPosition]);

  const toNormalizedPoint = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    const canvasX = event.clientX - rect.left;
    const canvasY = event.clientY - rect.top;

    return toNormalized(canvasX, canvasY, rect.width, rect.height);
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!correctionEnabled || !onCorrection) {
      return;
    }

    const query = toNormalizedPoint(event);
    if (!query) {
      return;
    }

    const candidates = activeTracks.flatMap((track) =>
      track.points
        .filter((point) => Math.abs(point.frameIdx - currentFrame) <= 2)
        .map((point) => ({
          ...point,
          ballId: track.ballId,
        })),
    );

    // 0.05 is ~5% of canvas width as click radius
    const nearest = findNearestPoint(query, candidates, 0.05);
    if (!nearest) {
      return;
    }

    dragTargetRef.current = {
      ballId: nearest.ballId,
      frameIdx: nearest.frameIdx,
    };
    setDragPosition({ x: nearest.x, y: nearest.y });
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragTargetRef.current) {
      return;
    }

    const point = toNormalizedPoint(event);
    if (!point) {
      return;
    }

    setDragPosition(point);
  };

  const handleMouseUp = () => {
    if (!dragTargetRef.current || !dragPosition || !onCorrection) {
      dragTargetRef.current = null;
      setDragPosition(null);
      return;
    }

    onCorrection({
      ballId: dragTargetRef.current.ballId,
      cameraId,
      frameIdx: dragTargetRef.current.frameIdx,
      x_new: dragPosition.x,
      y_new: dragPosition.y,
    });

    dragTargetRef.current = null;
    setDragPosition(null);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    activeTracks.forEach((track) => {
      const color = BALL_COLORS[track.ballId % BALL_COLORS.length];

      // Draw full trajectory with lower opacity
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.globalAlpha = 0.3;

      track.points.forEach((point, i) => {
        const px = point.x * width;
        const py = point.y * height;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();

      // Draw trajectory up to current frame with solid line
      ctx.beginPath();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.8;

      const visiblePoints = track.points.filter((p) => p.frameIdx <= currentFrame);
      visiblePoints.forEach((point, i) => {
        const px = point.x * width;
        const py = point.y * height;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();

      // Draw current position marker
      const currentPoint = track.points.find((p) => p.frameIdx === currentFrame);
      if (currentPoint) {
        const px = currentPoint.x * width;
        const py = currentPoint.y * height;
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
        ctx.fill();

        // Flag low confidence
        if (currentPoint.isFlagged || currentPoint.confidence < 0.7) {
          ctx.strokeStyle = '#ef4444'; // red-500
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(px, py, 10, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    });

    if (correctedPoint) {
      const px = correctedPoint.x * width;
      const py = correctedPoint.y * height;
      ctx.globalAlpha = 1;
      ctx.fillStyle = correctedPoint.color;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }, [activeTracks, currentFrame, width, height, correctedPoint]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      className={`absolute inset-0 ${correctionEnabled ? 'cursor-grab pointer-events-auto' : 'pointer_events-none'}`}
    />
  );
};
