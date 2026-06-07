import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from physics.collision import detect_system_collision
from physics.converter import convert_to_metric
from physics.loader import load_experiment_data


def _write_two_ball_experiment(
    tmp_path,
    *,
    total_frames: int = 80,
    motion_start: int = 10,
    collision_frame: int = 44,
    seed_jitter_px: float = 0.2,
    seed_confidence: float = 0.0,
):
    experiment_id = "two_ball_collision"
    exp_dir = tmp_path / experiment_id
    results_dir = exp_dir / "results"
    calibration_dir = exp_dir / "calibration"
    frame_dir = exp_dir / "frames" / "cam0"

    results_dir.mkdir(parents=True)
    calibration_dir.mkdir(parents=True)
    frame_dir.mkdir(parents=True)
    Image.new("RGB", (1280, 720)).save(frame_dir / "000001.png")

    fps = 30.0
    dt = 1.0 / fps
    timestamps_ms = [i * dt * 1000.0 for i in range(total_frames)]

    ball0_frames = []
    ball1_frames = []
    center_x = 640.0
    center_y = 360.0
    start_x = 300.0
    approach_speed_px_per_s = (center_x - start_x) / ((collision_frame - motion_start) * dt)

    for i in range(total_frames):
        t = i * dt
        if i < collision_frame:
            ball0_frames.append(
                {
                    "frame_idx": i,
                    "x_px": center_x + np.random.default_rng(0).normal(0.0, 0.05),
                    "y_px": center_y + np.random.default_rng(1).normal(0.0, 0.05),
                    "confidence": 1.0,
                }
            )
        else:
            t_col = collision_frame * dt
            ball0_frames.append(
                {
                    "frame_idx": i,
                    "x_px": center_x + 150.0 * (t - t_col),
                    "y_px": center_y,
                    "confidence": 1.0,
                }
            )

        if i < motion_start:
            ball1_frames.append(
                {
                    "frame_idx": i,
                    "x_px": start_x + np.random.default_rng(2 + i).normal(0.0, seed_jitter_px),
                    "y_px": center_y + np.random.default_rng(3 + i).normal(0.0, seed_jitter_px),
                    "confidence": seed_confidence,
                }
            )
        elif i < collision_frame:
            x = start_x + approach_speed_px_per_s * (t - motion_start * dt)
            ball1_frames.append(
                {
                    "frame_idx": i,
                    "x_px": x,
                    "y_px": center_y,
                    "confidence": 1.0,
                }
            )
        else:
            t_col = collision_frame * dt
            x_col = start_x + approach_speed_px_per_s * (t_col - motion_start * dt)
            ball1_frames.append(
                {
                    "frame_idx": i,
                    "x_px": x_col - 200.0 * (t - t_col),
                    "y_px": center_y,
                    "confidence": 1.0,
                }
            )

    with open(results_dir / "sync.json", "w") as f:
        json.dump({"cameras": {"cam0": {"timestamps_ms": timestamps_ms}}}, f)
    with open(results_dir / "tracks.json", "w") as f:
        json.dump(
            {
                "balls": [
                    {"ball_id": 0, "camera_id": 0, "frames": ball0_frames},
                    {"ball_id": 1, "camera_id": 0, "frames": ball1_frames},
                ]
            },
            f,
        )
    with open(calibration_dir / "cam0_intrinsics.json", "w") as f:
        json.dump({"scale_px_per_mm": 1.0, "scale_uncertainty_px_per_mm": 0.001}, f)

    return experiment_id


def test_masks_low_confidence_seed_jitter_before_motion(tmp_path):
    experiment_id = _write_two_ball_experiment(
        tmp_path,
        motion_start=10,
        seed_jitter_px=0.25,
        seed_confidence=0.0,
    )
    tracks, _ = load_experiment_data(tmp_path / experiment_id)
    moving = next(track for track in tracks if track.ball_id == 1)

    assert np.all(np.isnan(moving.x_px[:10]))
    assert not np.isnan(moving.x_px[10])


def test_detects_two_ball_collision_not_motion_onset(tmp_path):
    motion_start = 10
    experiment_id = _write_two_ball_experiment(
        tmp_path,
        collision_frame=44,
        motion_start=motion_start,
    )
    loaded_tracks, scale = load_experiment_data(tmp_path / experiment_id)
    metric_tracks = [convert_to_metric(track, scale) for track in loaded_tracks]

    result = detect_system_collision(metric_tracks)

    assert 42 <= result.collision_frame <= 46
    assert result.collision_frame >= motion_start + 5


def test_two_ball_collision_rejects_single_ball_motion_onset(tmp_path):
    experiment_id = _write_two_ball_experiment(tmp_path, collision_frame=44, motion_start=10)
    loaded_tracks, scale = load_experiment_data(tmp_path / experiment_id)
    metric_tracks = [convert_to_metric(track, scale) for track in loaded_tracks]

    result = detect_system_collision(metric_tracks)

    assert result.collision_frame not in {8, 9, 10, 11, 12}


REAL_EXPERIMENT = Path(__file__).resolve().parents[3] / "experiments" / "2f562986-2322-4183-a09b-bd43d0457ade"


@pytest.mark.skipif(not REAL_EXPERIMENT.exists(), reason="Local capture fixture not present")
def test_real_planar_capture_detects_collision_near_frame_44():
    loaded_tracks, scale = load_experiment_data(REAL_EXPERIMENT)
    metric_tracks = [convert_to_metric(track, scale) for track in loaded_tracks]

    result = detect_system_collision(metric_tracks)

    assert 42 <= result.collision_frame <= 46
