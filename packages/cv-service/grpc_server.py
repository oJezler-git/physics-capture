import asyncio
import logging
import grpc
import sys
import os
from concurrent import futures

# Add the generated directory to the system path to allow imports within the generated stubs
sys.path.append(os.path.join(os.path.dirname(__file__), 'generated'))
import physics_pb2
import physics_pb2_grpc

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

import asyncio
import logging
import grpc
import sys
import os
from concurrent import futures
from pathlib import Path

# Add the generated directory to the system path to allow imports within the generated stubs
sys.path.append(os.path.join(os.path.dirname(__file__), 'generated'))
import physics_pb2
import physics_pb2_grpc

# Import tracker
from tracking.sam2_tracker import SAM2Tracker

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class PhysicsCaptureServicer(physics_pb2_grpc.PhysicsCaptureServicer):
    def __init__(self):
        self.tracker = SAM2Tracker()

    async def RunCalibration(self, request, context):
        # ... (keep calibration stub)
        yield physics_pb2.CalibrationStatus(
            camera_id=request.camera_ids[0] if request.camera_ids else 0,
            stage=physics_pb2.CalibrationStage.DONE,
            progress=1.0,
            reprojection_error_px=0.2,
            message="Calibration complete (stub)"
        )

    async def TrackBalls(self, request, context):
        logger.info(f"TrackBalls called for experiment {request.experiment_id}")
        
        # Path structure: /experiments/{id}/frames/cam{n}
        experiment_dir = Path(__file__).parent.parent / "experiments" / request.experiment_id
        
        # Aggregate seeds per camera
        seeds_by_cam = {}
        for seed in request.seeds:
            if seed.camera_id not in seeds_by_cam: seeds_by_cam[seed.camera_id] = []
            seeds_by_cam[seed.camera_id].append((seed.x, seed.y))
        
        for cam_id, seeds in seeds_by_cam.items():
            frames_dir = experiment_dir / "frames" / f"cam{cam_id}"
            
            # Run tracker (blocking CPU/GPU task)
            loop = asyncio.get_event_loop()
            results = await loop.run_in_executor(None, self.tracker.track, frames_dir, seeds)
            
            # Stream status back
            for frame_idx, points in results.items():
                yield physics_pb2.TrackingStatus(
                    frame=frame_idx,
                    progress=frame_idx / 100, # Simplified
                    points=[physics_pb2.TrackedPoint(
                        ball_id=p["ball_id"],
                        camera_id=cam_id,
                        x=p["x"],
                        y=p["y"],
                        confidence=p["confidence"]
                    ) for p in points],
                    frame_confidence=max([p["confidence"] for p in points])
                )

    async def ComputePhysics(self, request, context):
        # ... (keep physics stub)
        return physics_pb2.PhysicsResult(
            balls=[],
            system=physics_pb2.SystemResult(
                total_momentum_before=0.0,
                total_momentum_after=0.0,
                ke_before=0.0,
                ke_after=0.0
            )
        )

async def serve():
    server = grpc.aio.server()
    physics_pb2_grpc.add_PhysicsCaptureServicer_to_server(PhysicsCaptureServicer(), server)
    listen_addr = "[::]:50051"
    server.add_insecure_port(listen_addr)
    logger.info(f"Starting server on {listen_addr}")
    await server.start()
    await server.wait_for_termination()

if __name__ == "__main__":
    asyncio.run(serve())
