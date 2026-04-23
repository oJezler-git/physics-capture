// --- Core domain types ---

export type SessionPhase = 'setup' | 'calibration' | 'recording' | 'tracking' | 'results';
export type RecordingMode = 'legacy' | 'browser-high' | 'future-extreme';

export interface CameraDevice {
  id: string; // UUID, assigned on registration
  type: 'pc' | 'phone';
  label: string; // e.g. "iPhone 14 (side)"
  stream: MediaStream | null;
  status: 'connecting' | 'live' | 'disconnected';
  peerId: string | null; // WebRTC peer ID, null for PC webcam
}

export interface BallMassConfig {
  ballId: number; // 0, 1, or 2
  mass_g: number; // grams, float64, > 0
  uncertainty_g: number; // grams, float64, > 0, default 1.0
}

export interface SyncMarkerConfig {
  roi_width_px: number; // uint32 (rendered)
  roi_height_px: number; // uint32 (rendered)
  gray_bits: number; // uint32, e.g. 10
  grating_cycles: number; // uint32, e.g. 3-5 across ROI width
  phase_step_rad: number; // float64 per display frame
  rAF_interval_ms?: number; // float64, optional diagnostics
  rAF_jitter_ms?: number; // float64, optional diagnostics
}

export interface BallSeed {
  ballId: number; // 0, 1, 2
  cameraId: string; // Changed to string to match CameraDevice.id
  frameIdx: number; // always 0
  x: number; // pixels, float64, in frame coordinates
  y: number; // pixels, float64, in frame coordinates
  bbox?: [number, number, number, number]; // [x0,y0,x1,y1], optional
}

export interface CorrectionKeyframe {
  ballId: number;
  cameraId: string; // Changed to string for consistency
  frameIdx: number; // uint32
  x_new: number; // pixels, float64
  y_new: number; // pixels, float64
}

// --- Calibration ---

export interface CameraIntrinsics {
  cameraId: string;
  fx: number;
  fy: number; // focal lengths, pixels
  cx: number;
  cy: number; // principal point, pixels
  k1: number;
  k2: number;
  p1: number;
  p2: number;
  k3: number; // distortion
  reprojection_error_px: number; // RMS, float64
}

export interface StereoExtrinsics {
  R: number[][]; // 3×3 rotation matrix, float64
  T: number[]; // 3-vector translation, mm, float64
  reprojection_error_px: number;
}

export interface CalibrationResult {
  experimentId: string;
  intrinsics: CameraIntrinsics[];
  stereo: StereoExtrinsics | null;
  rulerScaleFactor: number | null; // px/mm; null if stereo used
  completedAt: number; // Unix timestamp ms
}

export interface CalibrationProfile {
  id: string;
  name: string; // e.g. "Lab Bench A"
  result: CalibrationResult;
  createdAt: number;
}

// --- Tracking ---

export interface TrackPoint {
  frameIdx: number;
  x: number; // pixels, float64
  y: number; // pixels, float64
  confidence: number; // 0.0–1.0
  isFlagged: boolean; // confidence < 0.7
  isCorrected: boolean;
}

export interface BallTrack {
  ballId: number;
  cameraId: string;
  points: TrackPoint[];
}

// --- Physics Results ---

export interface UFloat {
  value: number; // point estimate
  uncertainty: number; // ±1σ
}

export interface BallResult {
  ballId: number;
  mass_kg: UFloat;
  v_before: UFloat; // m/s
  v_after: UFloat; // m/s
  p_before: UFloat; // kg·m/s
  p_after: UFloat; // kg·m/s
  ke_before: UFloat; // joules
  ke_after: UFloat; // joules
}

export interface SystemResult {
  p_before_total: UFloat; // kg·m/s
  p_after_total: UFloat; // kg·m/s
  ke_before_total: UFloat; // J
  ke_after_total: UFloat; // J
  momentum_conserved_pct: UFloat; // %
  coeff_of_restitution: UFloat; // dimensionless
  collision_frame_idx: number;
}

export interface PhysicsResult {
  experimentId: string;
  balls: BallResult[];
  system: SystemResult;
  velocityTimeSeries: VelocityTimeSeries[];
  computedAt: number;
}

export interface VelocityTimeSeries {
  ballId: number;
  points: Array<{
    time_ms: number; // true timestamp from sync.json master array
    v: number; // m/s
    v_uncertainty: number; // ±1σ m/s
  }>;
}

export interface SyncData {
  experimentId: string;
  frameToMs: Record<number, number>; // frame_index → true_ms
  phase_offset_ms: number[]; // per camera
  true_fps: number[]; // per camera
  fit_residual_ms: number[]; // RMS of linear fit, per camera
}
