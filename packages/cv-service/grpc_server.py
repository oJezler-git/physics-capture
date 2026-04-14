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

class PhysicsCaptureServicer(physics_pb2_grpc.PhysicsCaptureServicer):
    async def RunCalibration(self, request, context):
        logger.info(f"RunCalibration called for experiment {request.experiment_id}")
        # Stub implementation
        yield physics_pb2.CalibrationStatus(
            camera_id=request.camera_ids[0] if request.camera_ids else 0,
            stage=physics_pb2.CalibrationStage.DONE,
            progress=1.0,
            reprojection_error_px=0.2,
            message="Calibration complete (stub)"
        )

    async def TrackBalls(self, request, context):
        logger.info(f"TrackBalls called for experiment {request.experiment_id}")
        # Stub implementation
        yield physics_pb2.TrackingStatus(
            frame=0,
            progress=1.0,
            points=[],
            frame_confidence=1.0
        )

    async def ComputePhysics(self, request, context):
        logger.info(f"ComputePhysics called for experiment {request.experiment_id}")
        # Stub implementation
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
