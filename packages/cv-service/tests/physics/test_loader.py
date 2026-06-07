import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from physics.loader import load_experiment_data


def test_load_experiment_data_scales_normalized_tracks(tmp_path: Path):
    experiment_dir = tmp_path / "exp"
    frames_dir = experiment_dir / "frames" / "cam0"
    results_dir = experiment_dir / "results"
    calibration_dir = experiment_dir / "calibration"

    frames_dir.mkdir(parents=True)
    results_dir.mkdir(parents=True)
    calibration_dir.mkdir(parents=True)

    Image.new("RGB", (1280, 720), color="black").save(frames_dir / "000001.jpg")

    with open(results_dir / "sync.json", "w") as f:
        json.dump({"cameras": {"cam0": {"timestamps_ms": [0.0, 33.3333333333]}}}, f)

    with open(results_dir / "tracks.json", "w") as f:
        json.dump(
            {
                "balls": [
                    {
                        "ball_id": 0,
                        "camera_id": 0,
                        "frames": [
                            {"frame_idx": 0, "x_px": 0.25, "y_px": 0.5, "confidence": 1.0},
                            {"frame_idx": 1, "x_px": 0.5, "y_px": 0.5, "confidence": 1.0},
                        ],
                    }
                ]
            },
            f,
        )

    with open(calibration_dir / "cam0_intrinsics.json", "w") as f:
        json.dump({"scale_px_per_mm": 1.0, "scale_uncertainty_px_per_mm": 0.001}, f)

    tracks, scale = load_experiment_data(experiment_dir)

    assert pytest.approx(scale.scale_px_per_mm, abs=1e-9) == 1.0
    assert pytest.approx(tracks[0].x_px[0], abs=1e-6) == 320.0
    assert pytest.approx(tracks[0].x_px[1], abs=1e-6) == 640.0


def test_load_experiment_data_prefers_calibrated_intrinsics(tmp_path: Path):
    experiment_dir = tmp_path / "exp_scale"
    frames_dir = experiment_dir / "frames" / "cam0"
    results_dir = experiment_dir / "results"
    calibration_dir = experiment_dir / "calibration"

    frames_dir.mkdir(parents=True)
    results_dir.mkdir(parents=True)
    calibration_dir.mkdir(parents=True)

    Image.new("RGB", (1280, 720), color="black").save(frames_dir / "000001.jpg")

    with open(results_dir / "sync.json", "w") as f:
        json.dump({"cameras": {"cam0": {"timestamps_ms": [0.0]}}}, f)
    with open(results_dir / "tracks.json", "w") as f:
        json.dump(
            {
                "balls": [
                    {
                        "ball_id": 0,
                        "camera_id": 0,
                        "frames": [{"frame_idx": 0, "x_px": 100.0, "y_px": 50.0, "confidence": 1.0}],
                    }
                ]
            },
            f,
        )
    # scale.json has 2.5
    with open(results_dir / "scale.json", "w") as f:
        json.dump({"px_per_mm": 2.5, "scale_uncertainty_px_per_mm": 0.02}, f)
    # intrinsics has 1.1 (Active calibration)
    with open(calibration_dir / "cam0_intrinsics.json", "w") as f:
        json.dump({"scale_px_per_mm": 1.1, "scale_uncertainty_px_per_mm": 0.5}, f)

    _tracks, scale = load_experiment_data(experiment_dir)
    # Now prefers the active calibration (1.1)
    assert pytest.approx(scale.scale_px_per_mm, abs=1e-9) == 1.1
    assert pytest.approx(scale.scale_uncertainty_px_per_mm, abs=1e-9) == 0.5


def test_masks_low_confidence_leading_frames(tmp_path: Path):
    experiment_dir = tmp_path / "exp_mask"
    frames_dir = experiment_dir / "frames" / "cam0"
    results_dir = experiment_dir / "results"
    calibration_dir = experiment_dir / "calibration"

    frames_dir.mkdir(parents=True)
    results_dir.mkdir(parents=True)
    calibration_dir.mkdir(parents=True)
    Image.new("RGB", (1280, 720), color="black").save(frames_dir / "000001.jpg")

    with open(results_dir / "sync.json", "w") as f:
        json.dump({"cameras": {"cam0": {"timestamps_ms": [0.0, 33.3333333333, 66.6666666666]}}}, f)
    with open(results_dir / "tracks.json", "w") as f:
        json.dump(
            {
                "balls": [
                    {
                        "ball_id": 0,
                        "camera_id": 0,
                        "frames": [
                            {"frame_idx": 0, "x_px": 100.0, "y_px": 50.0, "confidence": 0.0},
                            {"frame_idx": 1, "x_px": 100.1, "y_px": 50.2, "confidence": 0.0},
                            {"frame_idx": 2, "x_px": 150.0, "y_px": 50.0, "confidence": 1.0},
                        ],
                    }
                ]
            },
            f,
        )
    with open(calibration_dir / "cam0_intrinsics.json", "w") as f:
        json.dump({"scale_px_per_mm": 1.0, "scale_uncertainty_px_per_mm": 0.001}, f)

    tracks, _ = load_experiment_data(experiment_dir)

    assert np.isnan(tracks[0].x_px[0])
    assert np.isnan(tracks[0].x_px[1])
    assert tracks[0].x_px[2] == pytest.approx(150.0)

