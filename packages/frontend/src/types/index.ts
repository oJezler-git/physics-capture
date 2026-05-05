// --- Core domain types ---

export type SessionPhase = 'setup' | 'calibration' | 'recording' | 'tracking' | 'results';
export type RecordingMode = 'legacy' | 'browser-high' | 'future-extreme';

export interface CameraDevice {
  id: string;
  type: 'pc' | 'phone';
  label: string;
  stream: MediaStream | null;
  status: 'connecting' | 'live' | 'disconnected';
  peerId: string | null;
}

export interface BallMassConfig {
  ballId: number;
  mass_g: number;
  uncertainty_g: number;
}

export interface SyncMarkerConfig {
  roi_width_px: number;
  roi_height_px: number;
  gray_bits: number;
  grating_cycles: number;
  phase_step_rad: number;
  rAF_interval_ms?: number;
  rAF_jitter_ms?: number;
}

export interface BallSeed {
  ballId: number;
  cameraId: string;
  frameIdx: number;
  x: number;
  y: number;
  bbox?: [number, number, number, number];
}

export interface CorrectionKeyframe {
  ballId: number;
  cameraId: string;
  frameIdx: number;
  x_new: number;
  y_new: number;
}

// --- Calibration ---

export interface CameraIntrinsics {
  cameraId: string;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  k1: number;
  k2: number;
  p1: number;
  p2: number;
  k3: number;
  reprojection_error_px: number;
}

export interface StereoExtrinsics {
  R: number[][];
  T: number[];
  reprojection_error_px: number;
}

export interface CalibrationResult {
  experimentId: string;
  intrinsics: CameraIntrinsics[];
  stereo: StereoExtrinsics | null;
  rulerScaleFactor: number | null;
  completedAt: number;
}

export interface CalibrationProfile {
  id: string;
  name: string;
  result: CalibrationResult;
  createdAt: number;
}

// --- Tracking ---

export interface TrackPoint {
  frameIdx: number;
  x: number;
  y: number;
  confidence: number;
  isFlagged: boolean;
  isCorrected: boolean;
}

export interface BallTrack {
  ballId: number;
  cameraId: string;
  points: TrackPoint[];
}

// --- Physics Results ---

export interface UFloat {
  value: number;
  uncertainty: number;
}

export interface Point3D {
  frameIdx: number;
  x: number;
  y: number;
  z: number;
  x_unc: number;
  y_unc: number;
  z_unc: number;
  flagged: boolean;
}

export interface BallResult {
  ballId: number;
  mass_kg: UFloat;
  v_before: UFloat;
  v_after: UFloat;
  p_before: UFloat;
  p_after: UFloat;
  ke_before: UFloat;
  ke_after: UFloat;
  trajectory3d?: Point3D[];
}

export interface SystemResult {
  p_before_total: UFloat;
  p_after_total: UFloat;
  ke_before_total: UFloat;
  ke_after_total: UFloat;
  momentum_conserved_pct: UFloat;
  coeff_of_restitution: UFloat;
  collision_frame_idx: number;
}

export interface Reconstruction3D {
  mode: 'SINGLE_CAMERA_PLANAR' | 'STEREO_3D';
  stereoExtrinsics: {
    R?: number[][];
    T?: number[];
  } | null;
}

export interface PhysicsResult {
  experimentId: string;
  balls: BallResult[];
  system: SystemResult;
  velocityTimeSeries: VelocityTimeSeries[];
  computedAt: number;
  reconstruction3d?: Reconstruction3D;
  reconstructionDiagnostics?: {
    overallConfidence: number;
    verdict: 'high' | 'medium' | 'low';
    issues: string[];
    checks: Array<{
      id: string;
      label: string;
      status: 'pass' | 'warn' | 'fail';
      value?: string;
      details?: string;
    }>;
    metrics: {
      mode: 'SINGLE_CAMERA_PLANAR' | 'STEREO_3D';
      baselineMm: number | null;
      stereoReprojectionPx: number | null;
      syncRmsMs: number | null;
      syncIsMock: boolean;
      avgTrackConfidence: number | null;
      frameCoverageCam0: number | null;
      frameCoverageCam1: number | null;
      triangulationFlaggedPct: number | null;
      maxLineDeviationM: number | null;
      gtRmseM: number | null;
    };
  };
  syncStatus?: {
    isMock: boolean;
    trueFps?: number;
    rmsMs?: number;
  };
}

export interface VelocityTimeSeries {
  ballId: number;
  points: Array<{
    time_ms: number;
    v: number;
    v_uncertainty: number;
  }>;
}

export interface SyncData {
  experimentId: string;
  frameToMs: Record<number, number>;
  phase_offset_ms: number[];
  true_fps: number[];
  fit_residual_ms: number[];
}
