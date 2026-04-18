import asyncio
import logging
import grpc
import sys
import os
import socket
from concurrent import futures
from pathlib import Path
import queue

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


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
        pass
    logger.warning("SAM2Tracker not found, tracking will use simulation.")

# Import physics pipeline
from physics.pipeline import run_physics_pipeline

class PhysicsCaptureServicer(physics_pb2_grpc.PhysicsCaptureServicer):
    def __init__(self):
        self.tracker = SAM2Tracker()
        self.base_dir = Path(__file__).parent.parent / "experiments"

    async def RunCalibration(self, request, context):
        logger.info(f"RunCalibration for experiment {request.experiment_id}")
        # Placeholder implementation
        yield physics_pb2.CalibrationStatus(
            camera_id=request.camera_ids[0] if request.camera_ids else 0,
            stage=physics_pb2.CalibrationStage.DONE,
            progress=1.0,
            reprojection_error_px=0.1,
            message="Calibration complete (simulated)"
        )

    async def TrackBalls(self, request, context):
        logger.info(f"TrackBalls called for experiment {request.experiment_id}")
        # (Existing simulation implementation preserved for now)
        total_frames = 200
        for frame_idx in range(total_frames):
            yield physics_pb2.TrackingStatus(
                frame=frame_idx,
                progress=frame_idx / (total_frames - 1),
                points=[],
                frame_confidence=1.0
            )

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
                
            # Run the actual pipeline
            results = run_physics_pipeline(
                experiment_id=request.experiment_id,
                base_dir=self.base_dir,
                masses=masses,
                ke_mode="rolling_sphere", # Could be configurable
                friction_mode="IGNORE"     # Could be configurable
            )
            
            p_data = results["momentum"]
            v_data = results["velocities"]
            
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
                    momentum_after_uncertainty=b_p["p_after"]["uncertainty_kgmps"]
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
                    momentum_conservation_error_pct=sys_p["conservation_pct"]["value"] if sys_p["conservation_pct"] else 0.0,
                    momentum_conservation_error_pct_uncertainty=sys_p["conservation_pct"]["uncertainty"] if sys_p["conservation_pct"] else 0.0,
                    coefficient_of_restitution=sys_p["cor"]["value"] if sys_p["cor"] else -1.0,
                    coefficient_of_restitution_uncertainty=sys_p["cor"]["uncertainty"] if sys_p["cor"] else 0.0
                )
            )
            
        except Exception as e:
            logger.error(f"Error in ComputePhysics: {str(e)}", exc_info=True)
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return physics_pb2.PhysicsResult()

async def serve():
    server = grpc.aio.server()
    physics_pb2_grpc.add_PhysicsCaptureServicer_to_server(PhysicsCaptureServicer(), server)
    grpc_port = os.getenv("PYTHON_GRPC_PORT", "50052")
    configured_addr = os.getenv("PYTHON_GRPC_BIND_ADDR")
    candidate_addrs = []
    if configured_addr:
        candidate_addrs.append(configured_addr)
    candidate_addrs.extend([f"[::]:{grpc_port}", f"0.0.0.0:{grpc_port}", f"127.0.0.1:{grpc_port}"])

    bound_addr = None
    seen = set()
    for addr in candidate_addrs:
        if addr in seen:
            continue
        seen.add(addr)
        try:
            server.add_insecure_port(addr)
            bound_addr = addr
            break
        except RuntimeError as exc:
            logger.warning(f"Failed to bind gRPC server to {addr}: {exc}")

    if bound_addr is None:
        local_bind_ok = True
        try:
            local_bind_ok = _can_bind_locally(int(grpc_port))
        except ValueError:
            local_bind_ok = False

        port_hint = (
            f"Port {grpc_port} appears to be unavailable (possibly already in use). "
            f"Stop the process using it, or choose another port via PYTHON_GRPC_PORT (for example {int(grpc_port) + 1})."
            if not local_bind_ok
            else "Set PYTHON_GRPC_BIND_ADDR to an explicit reachable host:port."
        )
        raise RuntimeError(
            "Failed to bind gRPC server to any candidate address. "
            + port_hint
        )

    logger.info(f"Starting server on {bound_addr}")
    await server.start()
    try:
        await server.wait_for_termination()
    except asyncio.CancelledError:
        logger.info("Shutdown requested; stopping CV gRPC server.")
        raise
    finally:
        # Ensure clean gRPC shutdown to avoid noisy destructor warnings on Ctrl+C.
        await server.stop(grace=2.0)
        logger.info("CV gRPC server stopped.")

if __name__ == "__main__":
    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        logger.info("CV service interrupted by user.")
        raise SystemExit(0)
    except RuntimeError as exc:
        logger.error(str(exc))
        raise SystemExit(1)
