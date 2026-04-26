import pytest
import grpc

import physics_pb2
import physics_pb2_grpc
from grpc_server import PhysicsCaptureServicer

@pytest.fixture
def servicer():
    return PhysicsCaptureServicer()

@pytest.mark.asyncio
async def test_calibration_request_validation(servicer, tmp_path):
    # Setup a mock server on an ephemeral port
    servicer.base_dir = tmp_path
    server = grpc.aio.server()
    physics_pb2_grpc.add_PhysicsCaptureServicer_to_server(servicer, server)
    port = server.add_insecure_port('[::]:0')
    await server.start()
    
    try:
        async with grpc.aio.insecure_channel(f'localhost:{port}') as channel:
            stub = physics_pb2_grpc.PhysicsCaptureStub(channel)
            request = physics_pb2.CalibrationRequest(experiment_id="test_exp", camera_ids=[0])
            
            responses = []
            async for response in stub.RunCalibration(request):
                responses.append(response)
                
            assert len(responses) > 0
            assert responses[-1].stage == physics_pb2.CalibrationStage.FAILED
            assert "Frames directory not found" in responses[-1].message
    finally:
        await server.stop(None)

@pytest.mark.asyncio
async def test_compute_physics_error_handling(servicer, tmp_path):
    # Test how the servicer handles missing experiment data
    server = grpc.aio.server()
    servicer.base_dir = tmp_path # Use isolated tmp dir
    physics_pb2_grpc.add_PhysicsCaptureServicer_to_server(servicer, server)
    port = server.add_insecure_port('[::]:0')
    await server.start()
    
    try:
        async with grpc.aio.insecure_channel(f'localhost:{port}') as channel:
            stub = physics_pb2_grpc.PhysicsCaptureStub(channel)
            # Experiment doesn't exist in tmp_path
            request = physics_pb2.PhysicsRequest(
                experiment_id="non_existent",
                ball_configs=[physics_pb2.BallConfig(ball_id=0, mass_kg=0.1, mass_uncertainty_kg=0.01)]
            )
            
            with pytest.raises(grpc.RpcError) as excinfo:
                await stub.ComputePhysics(request)
            
            assert excinfo.value.code() == grpc.StatusCode.INTERNAL
    finally:
        await server.stop(None)
