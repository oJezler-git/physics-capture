# packages/cv-service/physics/loader.py

import json
import numpy as np
from pathlib import Path
from dataclasses import dataclass
from typing import List, Dict, Any, Optional

@dataclass
class LoadedTrack:
    ball_id:       int
    camera_id:     int
    frame_indices: np.ndarray   # uint32, shape [N]
    timestamps_ms: np.ndarray   # float64, shape [N]
    x_px:          np.ndarray   # float64, shape [N]
    y_px:          np.ndarray   # float64, shape [N]
    confidence:    np.ndarray   # float32, shape [N]

@dataclass
class ScaleCalibration:
    scale_px_per_mm: float
    scale_uncertainty_px_per_mm: float

def load_experiment_data(
    experiment_dir: Path,
    camera_id_str: str = "cam0"
) -> tuple[List[LoadedTrack], ScaleCalibration]:
    """
    Load sync.json and tracks.json from disk; returns structured data.
    """
    results_dir = experiment_dir / "results"
    calibration_dir = experiment_dir / "calibration"
    
    sync_path = results_dir / "sync.json"
    tracks_path = results_dir / "tracks.json"
    calib_path = calibration_dir / f"{camera_id_str}_intrinsics.json"
    
    if not sync_path.exists():
        raise FileNotFoundError(f"Sync file not found: {sync_path}")
    if not tracks_path.exists():
        raise FileNotFoundError(f"Tracks file not found: {tracks_path}")
    if not calib_path.exists():
        raise FileNotFoundError(f"Calibration file not found: {calib_path}")

    with open(sync_path, 'r') as f:
        sync_data = json.load(f)
        
    with open(tracks_path, 'r') as f:
        tracks_data = json.load(f)
        
    with open(calib_path, 'r') as f:
        calib_data = json.load(f)

    # 1. Extract timestamps for the relevant camera
    if camera_id_str not in sync_data["cameras"]:
        raise ValueError(f"Camera {camera_id_str} not found in sync.json")
    
    cam_sync = sync_data["cameras"][camera_id_str]
    timestamps_ms = np.array(cam_sync["timestamps_ms"], dtype=np.float64)
    frame_count = len(timestamps_ms)
    
    # 2. Extract scale calibration
    scale = ScaleCalibration(
        scale_px_per_mm=calib_data["scale_px_per_mm"],
        scale_uncertainty_px_per_mm=calib_data.get("scale_uncertainty_px_per_mm", 0.0)
    )

    # 3. Process each ball
    loaded_tracks = []
    # camera_id might be an int in tracks.json, or string. Plan says int.
    # But files say cam0 (string). Let's assume cam0 maps to 0.
    camera_idx = int(camera_id_str.replace("cam", ""))

    for ball_data in tracks_data["balls"]:
        # Filter by camera if needed
        if ball_data["camera_id"] != camera_idx:
            continue
            
        ball_id = ball_data["ball_id"]
        
        # Initialize dense arrays with NaNs
        x_px = np.full(frame_count, np.nan, dtype=np.float64)
        y_px = np.full(frame_count, np.nan, dtype=np.float64)
        confidence = np.zeros(frame_count, dtype=np.float32)
        
        for frame in ball_data["frames"]:
            idx = frame["frame_idx"]
            if 0 <= idx < frame_count:
                x_px[idx] = frame["x_px"]
                y_px[idx] = frame["y_px"]
                confidence[idx] = frame["confidence"]
        
        loaded_tracks.append(LoadedTrack(
            ball_id=ball_id,
            camera_id=camera_idx,
            frame_indices=np.arange(frame_count, dtype=np.uint32),
            timestamps_ms=timestamps_ms,
            x_px=x_px,
            y_px=y_px,
            confidence=confidence
        ))
        
    return loaded_tracks, scale
