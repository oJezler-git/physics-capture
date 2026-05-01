# packages/cv-service/tests/physics/test_pipeline.py

import pytest
import json
import numpy as np
from pathlib import Path
from physics.pipeline import run_physics_pipeline

def test_full_pipeline_synthetic(tmp_path):
    # 1. Create dummy experiment structure
    experiment_id = "test_experiment"
    exp_dir = tmp_path / experiment_id
    results_dir = exp_dir / "results"
    calibration_dir = exp_dir / "calibration"
    
    results_dir.mkdir(parents=True)
    calibration_dir.mkdir(parents=True)
    
    # 1b. Create dummy frames dir to satisfy loader check
    frame_dir = exp_dir / "frames" / "cam0"
    frame_dir.mkdir(parents=True)
    from PIL import Image
    Image.new("RGB", (1280, 720)).save(frame_dir / "000001.png")
    
    # 2. Generate synthetic data
    # Ball 0: moving right, collision at frame 50
    total_frames = 100
    collision_frame = 50
    fps = 30.0
    dt = 1.0 / fps
    timestamps_ms = [i * dt * 1000.0 for i in range(total_frames)]
    
    # Ball 0
    # Before: v = 1.0 m/s -> x = 100.0 + 1000.0 * t (mm)
    # Scale: 1 px/mm for simplicity
    ball0_frames = []
    for i in range(total_frames):
        t = i * dt
        if i < collision_frame:
            x = 100.0 + 1000.0 * t
        else:
            # Rebound at v = -0.5 m/s
            t_col = collision_frame * dt
            x_col = 100.0 + 1000.0 * t_col
            x = x_col - 500.0 * (t - t_col)
            
        ball0_frames.append({
            "frame_idx": i,
            "x_px": x,
            "y_px": 200.0,
            "confidence": 1.0
        })
        
    sync_data = {
        "cameras": {
            "cam0": {
                "timestamps_ms": timestamps_ms
            }
        }
    }
    
    tracks_data = {
        "balls": [
            {
                "ball_id": 0,
                "camera_id": 0,
                "frames": ball0_frames
            }
        ]
    }
    
    calib_data = {
        "scale_px_per_mm": 1.0,
        "scale_uncertainty_px_per_mm": 0.001
    }
    
    with open(results_dir / "sync.json", 'w') as f:
        json.dump(sync_data, f)
    with open(results_dir / "tracks.json", 'w') as f:
        json.dump(tracks_data, f)
    with open(calibration_dir / "cam0_intrinsics.json", 'w') as f:
        json.dump(calib_data, f)
        
    # 3. Run pipeline
    masses = [{"ball_id": 0, "mass_g": 100.0, "uncertainty_g": 1.0}]
    results = run_physics_pipeline(
        experiment_id=experiment_id,
        base_dir=tmp_path,
        masses=masses,
        ke_mode="point_mass"
    )
    
    # 4. Assertions
    v0_before = results["velocities"]["balls"][0]["v_before"]["value_mps"]
    v0_after = results["velocities"]["balls"][0]["v_after"]["value_mps"]
    
    assert pytest.approx(v0_before, abs=0.01) == 1.0
    assert pytest.approx(v0_after, abs=0.01) == -0.5
    
    # Check momentum
    p_before = results["momentum"]["system"]["p_before"]["value_kgmps"]
    assert pytest.approx(p_before, abs=0.001) == 0.1
    
    # Check CoR
    cor = results["momentum"]["system"]["cor"]["value"]
    assert pytest.approx(cor, abs=0.01) == 0.5


def test_full_pipeline_synthetic_without_calibration_file(tmp_path):
    experiment_id = "test_experiment_no_calibration"
    exp_dir = tmp_path / experiment_id
    results_dir = exp_dir / "results"
    calibration_dir = exp_dir / "calibration"

    results_dir.mkdir(parents=True)
    calibration_dir.mkdir(parents=True)
    
    # Add dummy frames dir for loader
    frame_dir = exp_dir / "frames" / "cam0"
    frame_dir.mkdir(parents=True)
    from PIL import Image
    Image.new("RGB", (1280, 720)).save(frame_dir / "000001.png")

    total_frames = 20
    timestamps_ms = [i * (1000.0 / 30.0) for i in range(total_frames)]
    frames = [
        {
            "frame_idx": i,
            "x_px": float(i),
            "y_px": 10.0,
            "confidence": 1.0,
        }
        for i in range(total_frames)
    ]

    with open(results_dir / "sync.json", "w") as f:
        json.dump({"cameras": {"cam0": {"timestamps_ms": timestamps_ms}}}, f)
    with open(results_dir / "tracks.json", "w") as f:
        json.dump({"balls": [{"ball_id": 0, "camera_id": 0, "frames": frames}]}, f)

    results = run_physics_pipeline(
        experiment_id=experiment_id,
        base_dir=tmp_path,
        masses=[{"ball_id": 0, "mass_g": 100.0, "uncertainty_g": 1.0}],
        ke_mode="point_mass",
    )

    assert results["momentum"]["system"]["p_before"]["value_kgmps"] is not None


def test_full_pipeline_stereo_mode_synthetic(tmp_path):
    experiment_id = "test_experiment_stereo"
    exp_dir = tmp_path / experiment_id
    results_dir = exp_dir / "results"
    calibration_dir = exp_dir / "calibration"
    frame_dir0 = exp_dir / "frames" / "cam0"
    frame_dir1 = exp_dir / "frames" / "cam1"

    results_dir.mkdir(parents=True)
    calibration_dir.mkdir(parents=True)
    frame_dir0.mkdir(parents=True)
    frame_dir1.mkdir(parents=True)

    from PIL import Image
    Image.new("RGB", (1280, 720)).save(frame_dir0 / "000001.png")
    Image.new("RGB", (1280, 720)).save(frame_dir1 / "000001.png")

    total_frames = 80
    fps = 30.0
    dt = 1.0 / fps
    timestamps_ms = [i * dt * 1000.0 for i in range(total_frames)]
    collision_frame = 40

    fx = 1000.0
    fy = 1000.0
    cx = 640.0
    cy = 360.0
    baseline_mm = 100.0
    z_mm = 2000.0

    ball0_cam0_frames = []
    ball0_cam1_frames = []
    for i in range(total_frames):
        t = i * dt
        if i < collision_frame:
            x_world_mm = 100.0 + 1000.0 * t
        else:
            t_col = collision_frame * dt
            x_col = 100.0 + 1000.0 * t_col
            x_world_mm = x_col - 500.0 * (t - t_col)

        y_world_mm = 0.0
        x0 = fx * (x_world_mm / z_mm) + cx
        y0 = fy * (y_world_mm / z_mm) + cy
        x1 = fx * ((x_world_mm - baseline_mm) / z_mm) + cx
        y1 = y0

        ball0_cam0_frames.append({"frame_idx": i, "x_px": x0, "y_px": y0, "confidence": 1.0})
        ball0_cam1_frames.append({"frame_idx": i, "x_px": x1, "y_px": y1, "confidence": 1.0})

    with open(results_dir / "sync.json", "w") as f:
        json.dump(
            {
                "cameras": {
                    "cam0": {"timestamps_ms": timestamps_ms},
                    "cam1": {"timestamps_ms": timestamps_ms},
                }
            },
            f,
        )
    with open(results_dir / "tracks.json", "w") as f:
        json.dump(
            {
                "balls": [
                    {"ball_id": 0, "camera_id": 0, "frames": ball0_cam0_frames},
                    {"ball_id": 0, "camera_id": 1, "frames": ball0_cam1_frames},
                ]
            },
            f,
        )

    intrinsics_payload = {
        "fx": fx,
        "fy": fy,
        "cx": cx,
        "cy": cy,
        "k1": 0.0,
        "k2": 0.0,
        "p1": 0.0,
        "p2": 0.0,
        "k3": 0.0,
        "scale_px_per_mm": 1.0,
        "scale_uncertainty_px_per_mm": 0.001,
    }
    with open(calibration_dir / "cam0_intrinsics.json", "w") as f:
        json.dump(intrinsics_payload, f)
    with open(calibration_dir / "cam1_intrinsics.json", "w") as f:
        json.dump(intrinsics_payload, f)
    with open(calibration_dir / "stereo_extrinsics.json", "w") as f:
        json.dump(
            {
                "R": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
                "T": [-baseline_mm, 0.0, 0.0],
                "E": [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]],
                "F": [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]],
                "P0": [[fx, 0.0, cx, 0.0], [0.0, fy, cy, 0.0], [0.0, 0.0, 1.0, 0.0]],
                "P1": [[fx, 0.0, cx, -fx * baseline_mm], [0.0, fy, cy, 0.0], [0.0, 0.0, 1.0, 0.0]],
                "reprojection_error_px": 0.1,
            },
            f,
        )

    results = run_physics_pipeline(
        experiment_id=experiment_id,
        base_dir=tmp_path,
        masses=[{"ball_id": 0, "mass_g": 100.0, "uncertainty_g": 1.0}],
        mode="STEREO_3D",
        ke_mode="point_mass",
    )

    v_before = results["velocities"]["balls"][0]["v_before"]["value_mps"]
    v_after = results["velocities"]["balls"][0]["v_after"]["value_mps"]
    assert pytest.approx(v_before, abs=0.03) == 1.0
    assert pytest.approx(v_after, abs=0.03) == -0.5
