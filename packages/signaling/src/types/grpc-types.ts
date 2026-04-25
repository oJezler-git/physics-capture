// packages/signaling/src/types/grpc-types.ts

export interface CalibrationRequest {
  experiment_id: string;
  camera_ids: number[];
}

export type CalibrationStage =
  | "CALIBRATION_STAGE_UNSPECIFIED"
  | "DETECTING_CORNERS"
  | "CALIBRATING_INTRINSICS"
  | "CALIBRATING_STEREO"
  | "DONE"
  | "FAILED";

export interface CalibrationStatus {
  camera_id: number;
  stage: CalibrationStage;
  progress: number;
  reprojection_error_px: number;
  message: string;
}

export type PhysicsMode =
  | "PHYSICS_MODE_UNSPECIFIED"
  | "SINGLE_CAMERA_PLANAR"
  | "STEREO_3D";

export interface BallSeed {
  ball_id: number;
  camera_id: number;
  frame_idx: number;
  x: number;
  y: number;
}

export interface TrackingRequest {
  experiment_id: string;
  seeds: BallSeed[];
  model_id?: string;
  start_frame_idx?: number;
  end_frame_idx?: number;
}

export interface TrackedPoint {
  ball_id: number;
  camera_id: number;
  x: number;
  y: number;
  confidence: number;
}

export interface TrackingStatus {
  frame: number;
  progress: number;
  points: TrackedPoint[];
  frame_confidence: number;
}

export interface BallConfig {
  ball_id: number;
  mass_kg: number;
  mass_uncertainty_kg: number;
}

export interface PhysicsRequest {
  experiment_id: string;
  ball_configs: BallConfig[];
  mode: PhysicsMode;
}

export interface BallResult {
  ball_id: number;
  v_before: number;
  v_before_uncertainty: number;
  v_after: number;
  v_after_uncertainty: number;
  momentum_before: number;
  momentum_before_uncertainty: number;
  momentum_after: number;
  momentum_after_uncertainty: number;
}

export interface SystemResult {
  total_momentum_before: number;
  total_momentum_before_uncertainty: number;
  total_momentum_after: number;
  total_momentum_after_uncertainty: number;
  ke_before: number;
  ke_before_uncertainty: number;
  ke_after: number;
  ke_after_uncertainty: number;
  momentum_conservation_error_pct: number;
  momentum_conservation_error_pct_uncertainty: number;
  coefficient_of_restitution: number;
  coefficient_of_restitution_uncertainty: number;
}

export interface PhysicsResult {
  balls: BallResult[];
  system: SystemResult;
}

// Error type surfaced by gRPC client wrapper
export interface GrpcError extends Error {
  code: number; // grpc.status enum value
  details: string; // human-readable error message from Python
}
