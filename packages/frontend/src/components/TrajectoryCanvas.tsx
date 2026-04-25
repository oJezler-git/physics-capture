import React, { useMemo } from 'react';
import type { BallTrack, CorrectionKeyframe } from '../types';

interface TrajectoryCanvasProps {
  width: number;
  height: number;
  tracks: BallTrack[];
  currentFrame: number;
  cameraId: string;
  correctionEnabled?: boolean;
  onCorrection?: (correction: CorrectionKeyframe) => void;
}

const BALL_COLORS = ['#4cc3ff', '#9ad46f', '#ff7244'];

export const TrajectoryCanvas: React.FC<TrajectoryCanvasProps> = ({
  width,
  height,
  tracks,
  currentFrame,
  cameraId,
  correctionEnabled: _correctionEnabled = false,
  onCorrection: _onCorrection,
}) => {
  // SVG points for each track
  const renderedTracks = useMemo(() => {
    return tracks
      .filter((t) => String(t.cameraId) === String(cameraId))
      .map((track) => {
        // Filter out (0,0) or invalid points which indicate a tracking failure
        const validPoints = track.points.filter(
          (p) => (p.x > 0.001 || p.y > 0.001) && p.frameIdx <= currentFrame,
        );

        if (validPoints.length === 0) return null;

        const polyline = validPoints.map((p) => `${p.x * width},${p.y * height}`).join(' ');

        // Find points with low confidence or significant jumps to highlight
        const issues = validPoints.filter((p, i) => {
          if (p.confidence < 0.5) return true;
          if (i > 0) {
            const prev = validPoints[i - 1];
            const dist = Math.sqrt(Math.pow(p.x - prev.x, 2) + Math.pow(p.y - prev.y, 2));
            if (dist > 0.1) return true; // Jumped more than 10% of screen
          }
          return false;
        });

        return {
          id: track.ballId,
          color: BALL_COLORS[track.ballId % BALL_COLORS.length],
          polyline,
          issues,
          currentPoint: track.points.find((p) => p.frameIdx === currentFrame),
        };
      })
      .filter(Boolean);
  }, [tracks, cameraId, currentFrame, width, height]);

  return (
    <svg
      className={`absolute inset-0 pointer-events-none z-10`}
      viewBox={`0 0 ${width || 1280} ${height || 720}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ width: '100%', height: '100%' }}
    >
      <defs>
        <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>

      {/* Trajectory Lines */}
      {renderedTracks.map((track) => (
        <g key={`track-${track!.id}`}>
          <polyline
            points={track!.polyline}
            fill="none"
            stroke={track!.color}
            strokeWidth="3"
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeDasharray="6 3"
            style={{ filter: 'url(#glow)', opacity: 0.8 }}
          />

          {/* Issue Indicators (Confidence Alerts) */}
          {track!.issues.map((issue, idx) => (
            <circle
              key={`issue-${track!.id}-${idx}`}
              cx={issue.x * width}
              cy={issue.y * height}
              r="12"
              fill="none"
              stroke="#fb7185" // rose-400
              strokeWidth="2"
              className="animate-pulse"
              style={{ opacity: 0.6 }}
            />
          ))}

          {/* Current Position Marker */}
          {track!.currentPoint && (
            <circle
              cx={track!.currentPoint.x * width}
              cy={track!.currentPoint.y * height}
              r="6"
              fill={track!.color}
              stroke="white"
              strokeWidth="2"
            />
          )}
        </g>
      ))}
    </svg>
  );
};
