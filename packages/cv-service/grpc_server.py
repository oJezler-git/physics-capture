import asyncio
import logging
import grpc
import sys
import os
import socket
import time
import traceback
import signal
from concurrent import futures
from pathlib import Path

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s'
)
logger = logging.getLogger(__name__)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

CODE_VERSION = "lifecycle-fix-v3-2026-06-07"


def _can_bind_locally(port: int) -> bool:
    """Best-effort local port availability probe for friendlier startup errors."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False

# Add the generated directory to the system path to allow imports within the generated stubs
sys.path.append(os.path.join(os.path.dirname(__file__), 'generated'))
import physics_pb2
import physics_pb2_grpc

# Import tracker
try:
    from tracking.sam2_tracker import SAM2Tracker
except ImportError:
    # Fallback for systems without SAM2 installed
    class SAM2Tracker:
        def __init__(self, **kwargs): pass
        def track(self, frames_dir, seeds, start_frame_idx=None, end_frame_idx=None):
            # Fallback for when SAM2 is not installed: just yield seed positions
            logger.warning("SAM2 is not installed. Using basic seed-only tracking fallback.")
            frame_files = sorted(list(frames_dir.glob("*.jpg")) + list(frames_dir.glob("*.png")))
            total_frames = len(frame_files)
            for i in range(total_frames):
                yield i, [{"ball_id": s["ball_id"], "x": s["x"], "y": s["y"], "confidence": 0.1} for s in seeds], i / max(1, total_frames - 1)
    logger.warning("SAM2Tracker not found, tracking will use basic seed positions.")

# Import physics pipeline
from physics.pipeline import run_physics_pipeline

class PhysicsCaptureServicer(physics_pb2_grpc.PhysicsCaptureServicer):
    def __init__(self):
        logger.info("CV service starting. Code version: %s", CODE_VERSION)
        self.tracker = SAM2Tracker()
        self.base_dir = Path(__file__).parent.parent / "experiments"

    @staticmethod
    def _read_optional_float(metric, key: str, default: float = 0.0) -> float:
        if not metric:
            return default
        value = metric.get(key)
        if value is None:
            return default
        return float(value)

    @staticmethod
    def _looks_like_invalid_argument(exc: Exception) -> bool:
        text = str(exc).lower()
        return "[errno 22]" in text or "invalid argument" in text

    async def RunCalibration(self, request, context):
        experiment_id = request.experiment_id
        camera_ids = list(request.camera_ids) if request.camera_ids else [0]
        logger.info(
            "RunCalibration for experiment=%s cameras=%s", experiment_id, camera_ids
        )

        experiment_dir = self.base_dir / experiment_id
        calib_dir = experiment_dir / "calibration"
        calib_dir.mkdir(parents=True, exist_ok=True)

        from calibration.intrinsic import (
            detect_corners_in_dir,
            calibrate_camera_from_corners,
            save_intrinsics,
        )
        from calibration.stereo import stereo_calibrate, save_stereo_extrinsics

        # --- Stage 1: Detect corners per camera ---
        corners_per_camera: dict[int, list] = {}
        total_cameras = len(camera_ids)

        for cam_idx, camera_id in enumerate(camera_ids):
            frames_dir = experiment_dir / "frames" / f"cam{camera_id}"
            if not frames_dir.exists():
                yield physics_pb2.CalibrationStatus(
                    camera_id=camera_id,
                    stage=physics_pb2.CalibrationStage.FAILED,
                    progress=0.0,
                    message=f"Frames directory not found: {frames_dir}",
                )
                return

            observations = []
            for frame_i, total_frames, obs in detect_corners_in_dir(frames_dir):
                progress = (cam_idx + frame_i / max(1, total_frames)) / total_cameras * 0.5
                msg = (
                    f"Camera {camera_id}: frame {frame_i}/{total_frames} — "
                    + ("✓ board found" if obs is not None else "no board")
                )
                if obs is not None:
                    observations.append(obs)
                yield physics_pb2.CalibrationStatus(
                    camera_id=camera_id,
                    stage=physics_pb2.CalibrationStage.DETECTING_CORNERS,
                    progress=progress,
                    message=msg,
                )
                await asyncio.sleep(0)

            corners_per_camera[camera_id] = observations
            logger.info(
                "Camera %d: found %d valid calibration frames", camera_id, len(observations)
            )

        # --- Stage 2: Intrinsic calibration per camera ---
        worst_reproj = 0.0
        intrinsic_ok = True
        for camera_id in camera_ids:
            observations = corners_per_camera.get(camera_id, [])
            start_msg = f"Camera {camera_id}: solving intrinsics ({len(observations)} frames)..."
            yield physics_pb2.CalibrationStatus(
                camera_id=camera_id,
                stage=physics_pb2.CalibrationStage.CALIBRATING_INTRINSICS,
                progress=0.5,
                message=start_msg,
            )
            await asyncio.sleep(0)

            start_ts = time.perf_counter()
            task = asyncio.create_task(
                asyncio.to_thread(calibrate_camera_from_corners, observations)
            )
            while not task.done():
                await asyncio.sleep(2.0)
                if task.done():
                    break
                elapsed = time.perf_counter() - start_ts
                yield physics_pb2.CalibrationStatus(
                    camera_id=camera_id,
                    stage=physics_pb2.CalibrationStage.CALIBRATING_INTRINSICS,
                    progress=0.5,
                    message=(
                        f"Camera {camera_id}: intrinsics solve still running "
                        f"({elapsed:.1f}s elapsed)"
                    ),
                )
                await asyncio.sleep(0)
            result = await task
            logger.info("%s completed in %.2fs", start_msg, time.perf_counter() - start_ts)
            if result is None:
                yield physics_pb2.CalibrationStatus(
                    camera_id=camera_id,
                    stage=physics_pb2.CalibrationStage.FAILED,
                    progress=0.5,
                    message=(
                        f"Camera {camera_id}: not enough checkerboard detections "
                        f"({len(observations)} frames found, need ≥10). "
                        "Move the board to more positions and ensure good lighting."
                    ),
                )
                intrinsic_ok = False
                break

            out_path = calib_dir / f"cam{camera_id}_intrinsics.json"
            save_intrinsics(result, out_path, camera_id=camera_id)
            worst_reproj = max(worst_reproj, result.reprojection_error_px)

            yield physics_pb2.CalibrationStatus(
                camera_id=camera_id,
                stage=physics_pb2.CalibrationStage.CALIBRATING_INTRINSICS,
                progress=0.65,
                reprojection_error_px=result.reprojection_error_px,
                message=f"Camera {camera_id} intrinsics: {result.reprojection_error_px:.3f}px RMS",
            )
            await asyncio.sleep(0)

        if not intrinsic_ok:
            return

        # --- Stage 3: Stereo calibration (only if two cameras) ---
        if len(camera_ids) >= 2:
            start_msg = "Stereo: scanning paired frames and solving extrinsics..."
            yield physics_pb2.CalibrationStatus(
                camera_id=camera_ids[0],
                stage=physics_pb2.CalibrationStage.CALIBRATING_STEREO,
                progress=0.75,
                message=start_msg,
            )
            await asyncio.sleep(0)

            start_ts = time.perf_counter()
            task = asyncio.create_task(
                asyncio.to_thread(stereo_calibrate, experiment_dir, camera_ids[:2])
            )
            while not task.done():
                await asyncio.sleep(2.0)
                if task.done():
                    break
                elapsed = time.perf_counter() - start_ts
                yield physics_pb2.CalibrationStatus(
                    camera_id=camera_ids[0],
                    stage=physics_pb2.CalibrationStage.CALIBRATING_STEREO,
                    progress=0.75,
                    message=f"Stereo calibration still running ({elapsed:.1f}s elapsed)",
                )
                await asyncio.sleep(0)
            stereo_result = await task
            logger.info("%s completed in %.2fs", start_msg, time.perf_counter() - start_ts)
            if stereo_result is not None:
                import numpy as np
                save_stereo_extrinsics(
                    stereo_result,
                    calib_dir / "stereo_extrinsics.json",
                )
                worst_reproj = max(worst_reproj, stereo_result.reprojection_error_px)
                baseline_mm = float(np.linalg.norm(stereo_result.T))
                yield physics_pb2.CalibrationStatus(
                    camera_id=camera_ids[0],
                    stage=physics_pb2.CalibrationStage.CALIBRATING_STEREO,
                    progress=0.90,
                    reprojection_error_px=stereo_result.reprojection_error_px,
                    message=f"Stereo: {stereo_result.reprojection_error_px:.3f}px RMS, baseline {baseline_mm:.1f}mm",
                )
                await asyncio.sleep(0)
            else:
                yield physics_pb2.CalibrationStatus(
                    camera_id=camera_ids[0],
                    stage=physics_pb2.CalibrationStage.CALIBRATING_STEREO,
                    progress=0.90,
                    message=(
                        "Stereo calibration skipped: not enough simultaneous "
                        "board views. Intrinsics saved."
                    ),
                )
                await asyncio.sleep(0)

        # --- Stage 4: Done ---
        yield physics_pb2.CalibrationStatus(
            camera_id=camera_ids[0],
            stage=physics_pb2.CalibrationStage.DONE,
            progress=1.0,
            reprojection_error_px=worst_reproj,
            message="Calibration complete.",
        )

    async def TrackBalls(self, request, context):
        logger.info(
            "TrackBalls called for experiment %s code_version=%s",
            request.experiment_id,
            CODE_VERSION,
        )
        
        # Determine target model
        requested_model = request.model_id or os.getenv("SAM2_MODEL_ID", "facebook/sam2-hiera-tiny").strip()
        
        # Hot-swap tracker if model changed
        if not hasattr(self, "current_model_id") or self.current_model_id != requested_model:
            logger.info(f"[CV] Switching model from {getattr(self, 'current_model_id', 'None')} to {requested_model}")
            try:
                self.tracker = SAM2Tracker(model_id=requested_model)
                self.current_model_id = requested_model
            except Exception as e:
                logger.error(f"[CV] Failed to load model {requested_model}: {e}")
                # Fallback to existing or ignore - servicer stays alive
        
        experiment_id = request.experiment_id
        seeds = request.seeds
        start_frame_idx = request.start_frame_idx if request.HasField("start_frame_idx") else None
        end_frame_idx = request.end_frame_idx if request.HasField("end_frame_idx") else None
        
        if not seeds:
            logger.warning("No seeds provided for tracking.")
            return

        # Group seeds by camera
        seeds_by_camera = {}
        for s in seeds:
            if s.camera_id not in seeds_by_camera:
                seeds_by_camera[s.camera_id] = []
            seeds_by_camera[s.camera_id].append({
                "ball_id": s.ball_id,
                "frame_idx": s.frame_idx,
                "x": s.x,
                "y": s.y
            })
            
        all_cameras = sorted(seeds_by_camera.keys())
        total_cameras = len(all_cameras)
        
        for cam_idx, camera_id in enumerate(all_cameras):
            frames_dir = self.base_dir / experiment_id / "frames" / f"cam{camera_id}"
            if not frames_dir.exists():
                logger.error(f"Frames directory not found: {frames_dir}")
                continue
            
            logger.info(f"Starting tracking for camera {camera_id} in {frames_dir}")
            
            try:
                # Iterate through the tracker generator. 
                tracker_gen = self.tracker.track(
                    frames_dir,
                    seeds_by_camera[camera_id],
                    start_frame_idx=start_frame_idx,
                    end_frame_idx=end_frame_idx,
                )
                for frame_idx, frame_results, progress in tracker_gen:
                    pb_points = []
                    for res in frame_results:
                        pb_points.append(physics_pb2.TrackedPoint(
                            ball_id=res["ball_id"],
                            camera_id=camera_id,
                            x=res["x"],
                            y=res["y"],
                            confidence=res["confidence"]
                        ))
                    
                    # Overall progress across all cameras
                    overall_progress = (cam_idx + progress) / total_cameras
                    
                    yield physics_pb2.TrackingStatus(
                        frame=frame_idx,
                        progress=overall_progress,
                        points=pb_points,
                        frame_confidence=max((p.confidence for p in pb_points), default=0.0)
                    )
                    
                    # Brief yield to allowing other async tasks to breathe
                    await asyncio.sleep(0)
                    
            except Exception as e:
                if (
                    self._looks_like_invalid_argument(e)
                    and "cuda" in str(getattr(self.tracker, "device", "")).lower()
                ):
                    logger.warning(
                        "CUDA tracking failed with invalid argument for camera %s; retrying on CPU.",
                        camera_id,
                        exc_info=True,
                    )
                    try:
                        self.tracker = SAM2Tracker(model_id=requested_model, force_device="cpu")
                        tracker_gen = self.tracker.track(
                            frames_dir,
                            seeds_by_camera[camera_id],
                            start_frame_idx=start_frame_idx,
                            end_frame_idx=end_frame_idx,
                        )
                        for frame_idx, frame_results, progress in tracker_gen:
                            pb_points = []
                            for res in frame_results:
                                pb_points.append(physics_pb2.TrackedPoint(
                                    ball_id=res["ball_id"],
                                    camera_id=camera_id,
                                    x=res["x"],
                                    y=res["y"],
                                    confidence=res["confidence"]
                                ))

                            overall_progress = (cam_idx + progress) / total_cameras

                            yield physics_pb2.TrackingStatus(
                                frame=frame_idx,
                                progress=overall_progress,
                                points=pb_points,
                                frame_confidence=max((p.confidence for p in pb_points), default=0.0)
                            )
                            await asyncio.sleep(0)
                        continue
                    except Exception as retry_error:
                        e = retry_error

                logger.exception(f"Error tracking camera {camera_id}: {e}")
                context.set_code(grpc.StatusCode.INTERNAL)
                tb = traceback.extract_tb(e.__traceback__)
                origin = tb[-1] if tb else None
                origin_msg = (
                    f" at {origin.filename}:{origin.lineno} in {origin.name}"
                    if origin
                    else ""
                )
                context.set_details(
                    f"Tracking failed for camera {camera_id}: "
                    f"{type(e).__name__}: {e}{origin_msg}"
                )
                return

    async def ComputePhysics(self, request, context):
        logger.info(f"ComputePhysics for experiment {request.experiment_id}")
        
        try:
            masses = []
            for m in request.ball_configs:
                masses.append({
                    "ball_id": m.ball_id,
                    "mass_g": m.mass_kg * 1000.0,
                    "uncertainty_g": m.mass_uncertainty_kg * 1000.0
                })
                
            mode_value = request.mode if request.mode else physics_pb2.SINGLE_CAMERA_PLANAR
            mode_name = physics_pb2.PhysicsMode.Name(mode_value)
            ke_mode = os.getenv("PHYSICS_KE_MODE", "rolling_sphere")
            friction_mode = os.getenv("PHYSICS_FRICTION_MODE", "IGNORE")

            # Run the actual pipeline
            results = run_physics_pipeline(
                experiment_id=request.experiment_id,
                base_dir=self.base_dir,
                masses=masses,
                mode=mode_name,
                ke_mode=ke_mode,
                friction_mode=friction_mode
            )
            
            p_data = results["momentum"]
            v_data = results["velocities"]
            positions_3d_data = results.get("positions_3d") or {}
            trajectory_by_ball = {}
            for frame in positions_3d_data.get("frames", []):
                frame_idx = int(frame.get("frame", 0))
                for ball_point in frame.get("balls", []):
                    ball_id = int(ball_point.get("ball_id", -1))
                    if ball_id < 0:
                        continue
                    trajectory_by_ball.setdefault(ball_id, []).append(
                        physics_pb2.Point3D(
                            x=float(ball_point.get("x_m", 0.0)),
                            y=float(ball_point.get("y_m", 0.0)),
                            z=float(ball_point.get("z_m", 0.0)),
                            x_unc=float(ball_point.get("x_unc_m", 0.0)),
                            y_unc=float(ball_point.get("y_unc_m", 0.0)),
                            z_unc=float(ball_point.get("z_unc_m", 0.0)),
                            flagged=bool(ball_point.get("flagged", False)),
                            frame_idx=frame_idx,
                        )
                    )
            
            # Map results to protobuf
            ball_results = []
            for b_p in p_data["per_ball"]:
                ball_id = b_p["ball_id"]
                # Find corresponding velocity data
                b_v = next((v for v in v_data["balls"] if v["ball_id"] == ball_id), None)
                
                ball_results.append(physics_pb2.BallResult(
                    ball_id=ball_id,
                    v_before=b_v["v_before"]["value_mps"],
                    v_before_uncertainty=b_v["v_before"]["uncertainty_mps"],
                    v_after=b_v["v_after"]["value_mps"] if b_v["v_after"]["value_mps"] is not None else 0.0,
                    v_after_uncertainty=b_v["v_after"]["uncertainty_mps"] if b_v["v_after"]["uncertainty_mps"] is not None else 0.0,
                    momentum_before=b_p["p_before"]["value_kgmps"],
                    momentum_before_uncertainty=b_p["p_before"]["uncertainty_kgmps"],
                    momentum_after=b_p["p_after"]["value_kgmps"],
                    momentum_after_uncertainty=b_p["p_after"]["uncertainty_kgmps"],
                    trajectory_3d=trajectory_by_ball.get(ball_id, []),
                ))
                
            sys_p = p_data["system"]
            return physics_pb2.PhysicsResult(
                balls=ball_results,
                system=physics_pb2.SystemResult(
                    total_momentum_before=sys_p["p_before"]["value_kgmps"],
                    total_momentum_before_uncertainty=sys_p["p_before"]["uncertainty_kgmps"],
                    total_momentum_after=sys_p["p_after"]["value_kgmps"],
                    total_momentum_after_uncertainty=sys_p["p_after"]["uncertainty_kgmps"],
                    ke_before=sys_p["ke_before"]["value_J"],
                    ke_before_uncertainty=sys_p["ke_before"]["uncertainty_J"],
                    ke_after=sys_p["ke_after"]["value_J"],
                    ke_after_uncertainty=sys_p["ke_after"]["uncertainty_J"],
                    # ufloat_to_dict(unit="pct") yields keys like value_pct/uncertainty_pct.
                    momentum_conservation_error_pct=self._read_optional_float(sys_p.get("conservation_pct"), "value_pct"),
                    momentum_conservation_error_pct_uncertainty=self._read_optional_float(sys_p.get("conservation_pct"), "uncertainty_pct"),
                    coefficient_of_restitution=sys_p["cor"]["value"] if sys_p["cor"] else -1.0,
                    coefficient_of_restitution_uncertainty=sys_p["cor"]["uncertainty"] if sys_p["cor"] else 0.0,
                    collision_frame_idx=v_data.get("collision_frame", -1)
                )
            )
            
        except Exception as e:
            logger.error(f"Error in ComputePhysics: {str(e)}", exc_info=True)
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return physics_pb2.PhysicsResult()


async def watchdog_task(stop_event):
    """
    Terminates the process if the parent process (npm/concurrently) dies.
    This prevents 'ghost' processes on Windows.
    """
    import psutil
    parent_pid = os.getppid()
    try:
        parent = psutil.Process(parent_pid)
    except psutil.NoSuchProcess:
        logger.warning("No parent process found at startup. Watchdog disabled.")
        return

    logger.info("Watchdog active: monitoring parent PID %d (%s)", parent_pid, parent.name())
    
    while not stop_event.is_set():
        if not parent.is_running():
            logger.warning("Parent process %d has terminated. Shutting down server...", parent_pid)
            stop_event.set()
            break
        await asyncio.sleep(2.0)


async def serve():
    stop_event = asyncio.Event()
    
    # Setup Signal Handlers (SIGINT/SIGTERM)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, lambda: stop_event.set())
        except NotImplementedError:
            # add_signal_handler is not implemented on Windows for some signals
            pass

    server = grpc.aio.server()
    physics_pb2_grpc.add_PhysicsCaptureServicer_to_server(PhysicsCaptureServicer(), server)
    
    grpc_port = os.getenv("PYTHON_GRPC_PORT", "50052")
    server.add_insecure_port(f"[::]:{grpc_port}")

    logger.info("Starting CV gRPC server on port %s", grpc_port)
    await server.start()
    
    # Start the watchdog
    watchdog = asyncio.create_task(watchdog_task(stop_event))

    # Wait for the stop event (either SIGINT or Watchdog trigger)
    await stop_event.wait()
    
    logger.info("Shutdown initiated...")
    await server.stop(grace=2.0)
    watchdog.cancel()
    logger.info("CV gRPC server stopped.")


if __name__ == "__main__":
    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        pass
