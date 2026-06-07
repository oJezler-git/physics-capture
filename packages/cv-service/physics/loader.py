# packages/cv-service/physics/loader.py

import json
import logging
import numpy as np
from pathlib import Path
from dataclasses import dataclass
from typing import List
from PIL import Image

logger = logging.getLogger(__name__)

# SAM2 often freezes a ball at its seed (or last valid) position before/after real
# tracking. Positions may jitter slightly, so use tolerance rather than exact match.
PLATEAU_EPS_PX = 0.5
RELIABLE_CONFIDENCE = 0.7


def _mask_sentinel_plateaus(
    x: np.ndarray,
    y: np.ndarray,
    confidence: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Remove SAM2 sentinel positions from the start/end of a track.

    1. Drop low-confidence frames before the first reliable observation.
    2. Drop low-confidence frozen runs at the end.
    3. Drop tolerance plateaus (near-identical x/y) when mean confidence is low.
    """
    nx = x.copy()
    ny = y.copy()
    conf = confidence.copy()
    n = len(nx)
    if n < 2:
        return nx, ny, conf

    def _within_eps(xa: float, ya: float, xb: float, yb: float) -> bool:
        return abs(xa - xb) <= PLATEAU_EPS_PX and abs(ya - yb) <= PLATEAU_EPS_PX

    def _mask_index(idx: int) -> None:
        nx[idx] = np.nan
        ny[idx] = np.nan
        conf[idx] = 0.0

    # Leading low-confidence frames before first reliable track point.
    first_reliable = next(
        (
            i
            for i in range(n)
            if conf[i] >= RELIABLE_CONFIDENCE and not np.isnan(nx[i]) and not np.isnan(ny[i])
        ),
        None,
    )
    if first_reliable is not None:
        for i in range(first_reliable):
            if conf[i] < RELIABLE_CONFIDENCE:
                _mask_index(i)

    # Trailing low-confidence frames after the last reliable track point.
    last_reliable = next(
        (
            i
            for i in range(n - 1, -1, -1)
            if conf[i] >= RELIABLE_CONFIDENCE and not np.isnan(nx[i]) and not np.isnan(ny[i])
        ),
        None,
    )
    if last_reliable is not None:
        for i in range(last_reliable + 1, n):
            if conf[i] < RELIABLE_CONFIDENCE:
                _mask_index(i)

    # Leading tolerance plateau with low confidence (seed freeze with jitter).
    lead_start = next((i for i in range(n) if not np.isnan(nx[i]) and not np.isnan(ny[i])), None)
    if lead_start is not None:
        lx, ly = nx[lead_start], ny[lead_start]
        lead_end = lead_start
        while lead_end + 1 < n and not np.isnan(nx[lead_end + 1]) and _within_eps(
            nx[lead_end + 1], ny[lead_end + 1], lx, ly
        ):
            lead_end += 1
        if lead_end > lead_start and np.mean(conf[lead_start : lead_end + 1]) < RELIABLE_CONFIDENCE:
            for i in range(lead_start, lead_end + 1):
                _mask_index(i)

    # Trailing tolerance plateau with low confidence.
    trail_end = next(
        (i for i in range(n - 1, -1, -1) if not np.isnan(nx[i]) and not np.isnan(ny[i])),
        None,
    )
    if trail_end is not None:
        tx, ty = nx[trail_end], ny[trail_end]
        trail_start = trail_end
        while trail_start > 0 and not np.isnan(nx[trail_start - 1]) and _within_eps(
            nx[trail_start - 1], ny[trail_start - 1], tx, ty
        ):
            trail_start -= 1
        if trail_start < trail_end and np.mean(conf[trail_start : trail_end + 1]) < RELIABLE_CONFIDENCE:
            for i in range(trail_start, trail_end + 1):
                _mask_index(i)

    return nx, ny, conf


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
    scale_path = results_dir / "scale.json"
    
    if not sync_path.exists():
        raise FileNotFoundError(f"Sync file not found: {sync_path}")
    if not tracks_path.exists():
        raise FileNotFoundError(f"Tracks file not found: {tracks_path}")
    if not calib_path.exists():
        logger.warning(
            "Calibration file not found at %s; falling back to default scale calibration for debug/synthetic runs.",
            calib_path,
        )

    with open(sync_path, 'r') as f:
        sync_data = json.load(f)
        
    with open(tracks_path, 'r') as f:
        tracks_data = json.load(f)

    frame_dir = experiment_dir / "frames" / camera_id_str
    frame_files = sorted(
        [
            path
            for path in frame_dir.iterdir()
            if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png"}
        ],
        key=lambda path: path.name,
    )
    frame_width = frame_height = None
    if frame_files:
        with Image.open(frame_files[0]) as img:
            frame_width, frame_height = img.size
        
    calib_data = {}
    if calib_path.exists():
        with open(calib_path, 'r') as f:
            calib_data = json.load(f)

    # Scale priority:
    # 1. Calibrated scale from cam0_intrinsics.json (Active calibration)
    # 2. Provided scale from scale.json (Generator ground truth)
    # 3. Default fallback (1.0 px/mm)
    
    scale_px_per_mm = calib_data.get("scale_px_per_mm")
    scale_unc_px_per_mm = calib_data.get("scale_uncertainty_px_per_mm")
    
    gt_scale = None
    if scale_path.exists():
        with open(scale_path, "r") as f:
            scale_data = json.load(f)
        gt_scale = scale_data.get("px_per_mm") or scale_data.get("scale_px_per_mm")
        logger.info(f"Ground truth scale from generator: {gt_scale} px/mm")

    if (scale_px_per_mm is None or float(scale_px_per_mm) <= 0):
        if gt_scale:
            scale_px_per_mm = gt_scale
            logger.info(f"Using ground truth scale: {scale_px_per_mm} px/mm")
        else:
            logger.warning(
                "No valid scale calibration found for %s; falling back to default 1.0 px/mm.",
                experiment_dir,
            )
            scale_px_per_mm = 1.0
    else:
        logger.info(f"Using active manual scale: {scale_px_per_mm} px/mm")
        if gt_scale and abs(float(scale_px_per_mm) - float(gt_scale)) / float(gt_scale) > 0.1:
            logger.warning(f"Active scale ({scale_px_per_mm}) deviates from ground truth ({gt_scale}) by >10%!")

    if scale_unc_px_per_mm is None:
        scale_unc_px_per_mm = 0.001

    # 1. Extract timestamps for the relevant camera
    if camera_id_str not in sync_data["cameras"]:
        raise ValueError(f"Camera {camera_id_str} not found in sync.json")
    
    cam_sync = sync_data["cameras"][camera_id_str]
    timestamps_ms = np.array(cam_sync["timestamps_ms"], dtype=np.float64)
    frame_count = len(timestamps_ms)
    
    # 2. Extract scale calibration
    scale = ScaleCalibration(
        scale_px_per_mm=float(scale_px_per_mm),
        scale_uncertainty_px_per_mm=float(scale_unc_px_per_mm)
    )

    # 3. Process each ball
    loaded_tracks = []
    # camera_id might be an int in tracks.json, or string. Plan says int.
    # But files say cam0 (string). Let's assume cam0 maps to 0.
    camera_idx = int(camera_id_str.replace("cam", ""))

    sample_points = []
    for ball_data in tracks_data.get("balls", []):
        for frame in ball_data.get("frames", []):
            x_val = frame.get("x_px")
            y_val = frame.get("y_px")
            if x_val is None or y_val is None:
                continue
            sample_points.append((float(x_val), float(y_val)))
            if len(sample_points) >= 32:
                break
        if len(sample_points) >= 32:
            break

    looks_normalized = False
    if sample_points and frame_width and frame_height:
        xs = np.array([x for x, _ in sample_points], dtype=np.float64)
        ys = np.array([y for _, y in sample_points], dtype=np.float64)
        looks_normalized = (
            np.nanmax(xs) <= 1.5
            and np.nanmax(ys) <= 1.5
            and np.nanmin(xs) >= -0.05
            and np.nanmin(ys) >= -0.05
        )
        if looks_normalized:
            logger.info(
                "Detected normalized track coordinates in %s; scaling by frame size %sx%s.",
                tracks_path,
                frame_width,
                frame_height,
            )

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
                x_val = frame["x_px"]
                y_val = frame["y_px"]
                if looks_normalized and frame_width and frame_height:
                    x_px[idx] = float(x_val) * frame_width
                    y_px[idx] = float(y_val) * frame_height
                else:
                    x_px[idx] = x_val
                    y_px[idx] = y_val
                confidence[idx] = frame["confidence"]
        
        x_px, y_px, confidence = _mask_sentinel_plateaus(x_px, y_px, confidence)

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


def load_experiment_data_multi(
    experiment_dir: Path,
    camera_id_strs: List[str],
) -> tuple[dict[str, List[LoadedTrack]], ScaleCalibration]:
    """
    Load tracks for multiple cameras from shared files.
    Returns a map of camera id string -> tracks, plus scale from cam0 calibration.
    """
    if not camera_id_strs:
        raise ValueError("At least one camera id is required.")

    tracks_by_camera: dict[str, List[LoadedTrack]] = {}
    scale: ScaleCalibration | None = None

    for camera_id_str in camera_id_strs:
        tracks, camera_scale = load_experiment_data(
            experiment_dir=experiment_dir,
            camera_id_str=camera_id_str,
        )
        tracks_by_camera[camera_id_str] = tracks
        if scale is None:
            scale = camera_scale

    if scale is None:
        raise ValueError("Unable to load scale calibration.")

    return tracks_by_camera, scale
