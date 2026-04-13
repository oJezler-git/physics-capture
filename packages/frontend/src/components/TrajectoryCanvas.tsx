import React, { useEffect, useRef } from 'react';
import type { BallTrack } from '../types';

interface TrajectoryCanvasProps {
  tracks: BallTrack[];
  currentFrame: number;
  cameraId: string;
  width: number;
  height: number;
}

const BALL_COLORS = ['#3b82f6', '#10b981', '#f59e0b']; // Blue, Green, Amber

export const TrajectoryCanvas: React.FC<TrajectoryCanvasProps> = ({
  tracks,
  currentFrame,
  cameraId,
  width,
  height,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    tracks.forEach((track) => {
      if (track.cameraId !== cameraId) return;

      const color = BALL_COLORS[track.ballId % BALL_COLORS.length];
      
      // Draw full trajectory with lower opacity
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.globalAlpha = 0.3;

      track.points.forEach((point, i) => {
        if (i === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();

      // Draw trajectory up to current frame with solid line
      ctx.beginPath();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.8;
      
      const visiblePoints = track.points.filter(p => p.frameIdx <= currentFrame);
      visiblePoints.forEach((point, i) => {
        if (i === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();

      // Draw current position marker
      const currentPoint = track.points.find(p => p.frameIdx === currentFrame);
      if (currentPoint) {
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(currentPoint.x, currentPoint.y, 6, 0, Math.PI * 2);
        ctx.fill();
        
        // Flag low confidence
        if (currentPoint.isFlagged || currentPoint.confidence < 0.7) {
          ctx.strokeStyle = '#ef4444'; // red-500
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(currentPoint.x, currentPoint.y, 10, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    });
  }, [tracks, currentFrame, cameraId, width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className="absolute inset-0 pointer-events-none"
    />
  );
};
