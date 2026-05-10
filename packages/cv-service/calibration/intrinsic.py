"""
calibration/intrinsic.py

Production-quality single-camera intrinsic calibration using OpenCV.

Reads extracted PNG/JPEG frames from an experiment's frames directory,
detects 9x7 checkerboard corners with sub-pixel refinement, and runs
cv2.calibrateCamera to recover the camera matrix K and distortion
coefficients D.

Designed to be called from grpc_server.RunCalibration as a generator
so progress can be streamed to the frontend.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Generator, NamedTuple

import cv2
import numpy as np

logger = logging.getLogger(__name__)

# Inner corner count of the calibration board (cols, rows).
# A standard 9x7 board has 8x6 inner corners.
BOARD_COLS = 8   # inner corners along the long axis
BOARD_ROWS = 6   # inner corners along the short axis
BOARD_SIZE = (BOARD_COLS, BOARD_ROWS)

# Physical size of one checkerboard square in mm.
# Adjust this to match your printed board.
SQUARE_SIZE_MM = 25.0  # 25mm = 1 inch squares

# Sub-pixel corner refinement window (half-size in pixels).
SUBPIX_WINDOW = (11, 11)
SUBPIX_ZERO_ZONE = (-1, -1)
SUBPIX_CRITERIA = (
    cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER,
    30,    # max iterations
    0.001, # epsilon
)

# Minimum number of valid frames needed for a reliable calibration.
MIN_VALID_FRAMES = 10

# Default stride fallback when dynamic selection cannot be computed.
FRAME_STRIDE_DEFAULT = 5

# Adaptive stride tuning:
# target runtime and estimated checkerboard-detection cost per sampled frame.
TARGET_CALIBRATION_SECONDS = 30.0
ESTIMATED_MS_PER_FRAME = 35.0
MAX_FRAME_STRIDE = 60


class IntrinsicResult(NamedTuple):
    camera_matrix: np.ndarray   # 3x3 float64
    dist_coeffs: np.ndarray     # (5,) float64: k1, k2, p1, p2, k3
    image_size: tuple[int, int] # (width, height)
    reprojection_error_px: float


class CornerObservation(NamedTuple):
    """All corner data collected from a single valid frame."""
    frame_idx: int
    image_points: np.ndarray   # shape (N, 1, 2) float32
    image_size: tuple[int, int]


def _object_points() -> np.ndarray:
    """
    Generate the 3D object-space coordinates for a single checkerboard view.
    The board lies in the Z=0 plane; X and Y are multiples of SQUARE_SIZE_MM.
    """
    objp = np.zeros((BOARD_ROWS * BOARD_COLS, 3), dtype=np.float32)
    objp[:, :2] = (
        np.mgrid[0:BOARD_COLS, 0:BOARD_ROWS].T.reshape(-1, 2) * SQUARE_SIZE_MM
    )
    return objp


def _sorted_frame_files(frames_dir: Path) -> list[Path]:
    candidates = (
        list(frames_dir.glob("*.png"))
        + list(frames_dir.glob("*.jpg"))
        + list(frames_dir.glob("*.jpeg"))
    )
    return sorted(candidates, key=lambda p: p.name)


def choose_frame_stride(
    total_frames: int,
    target_seconds: float = TARGET_CALIBRATION_SECONDS,
    estimated_ms_per_frame: float = ESTIMATED_MS_PER_FRAME,
) -> int:
    """
    Pick a sampling stride that aims to keep checkerboard scanning under target_seconds.

    We bound the stride so tiny datasets are fully scanned, and huge datasets do not
    devolve into extremely sparse sampling.
    """
    if total_frames <= 0:
        return 1
    if target_seconds <= 0 or estimated_ms_per_frame <= 0:
        return FRAME_STRIDE_DEFAULT

    frame_budget = max(1, int((target_seconds * 1000.0) / estimated_ms_per_frame))
    stride = int(np.ceil(total_frames / frame_budget)) if total_frames > frame_budget else 1
    return int(max(1, min(MAX_FRAME_STRIDE, stride)))


def detect_corners_in_dir(
    frames_dir: Path,
    stride: int | None = None,
) -> Generator[tuple[int, int, CornerObservation | None], None, None]:
    """
    Scan frames_dir for checkerboard corners.

    Yields (frame_idx, total_frames, observation_or_None) for each frame
    checked so the caller can stream progress.

    Parameters
    ----------
    frames_dir : Path
        Directory containing extracted JPEG/PNG frames.
    stride : int
        Sample every `stride` frames to avoid redundant views.

    Yields
    ------
    (frame_idx, total_frames, observation | None)
    """
    frame_files = _sorted_frame_files(frames_dir)
    total = len(frame_files)
    if total == 0:
        logger.warning("No frames found in %s", frames_dir)
        return

    if stride is None:
        stride = choose_frame_stride(total)
    stride = max(1, int(stride))

    sampled = frame_files[::stride]

    found_count = 0
    for i, path in enumerate(sampled):
        bgr = cv2.imread(str(path))
        if bgr is None:
            logger.debug("Could not read frame %s", path.name)
            yield i, len(sampled), None
            continue

        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        h, w = gray.shape[:2]

        # Fast check first (no sub-pixel), then refine if found.
        found, corners = cv2.findChessboardCorners(
            gray,
            BOARD_SIZE,
            flags=(
                cv2.CALIB_CB_ADAPTIVE_THRESH
                | cv2.CALIB_CB_NORMALIZE_IMAGE
                | cv2.CALIB_CB_FAST_CHECK
            ),
        )
        # Fallback for synthetic/low-texture cases where classic detector misses.
        if not found and hasattr(cv2, "findChessboardCornersSB"):
            found, corners = cv2.findChessboardCornersSB(
                gray,
                BOARD_SIZE,
                flags=cv2.CALIB_CB_EXHAUSTIVE | cv2.CALIB_CB_ACCURACY,
            )

        if not found:
            yield i, len(sampled), None
            continue

        # Sub-pixel refinement for accuracy.
        cv2.cornerSubPix(gray, corners, SUBPIX_WINDOW, SUBPIX_ZERO_ZONE, SUBPIX_CRITERIA)
        found_count += 1

        obs = CornerObservation(
            frame_idx=i,
            image_points=corners,
            image_size=(w, h),
        )
        yield i, len(sampled), obs
    logger.info(
        "Corner detection summary for %s: sampled=%d stride=%d found=%d (%.1f%%)",
        frames_dir,
        len(sampled),
        stride,
        found_count,
        (100.0 * found_count / max(1, len(sampled))),
    )


def calibrate_camera_from_corners(
    observations: list[CornerObservation],
) -> IntrinsicResult | None:
    """
    Run cv2.calibrateCamera on a list of corner observations.

    Returns None if fewer than MIN_VALID_FRAMES valid observations exist.
    """
    if len(observations) < MIN_VALID_FRAMES:
        logger.warning(
            "Only %d valid frames found; need at least %d for reliable calibration.",
            len(observations),
            MIN_VALID_FRAMES,
        )
        return None

    objp = _object_points()
    obj_points = [objp for _ in observations]
    img_points = [obs.image_points for obs in observations]
    image_size = observations[0].image_size  # (w, h)

    rms, camera_matrix, dist_coeffs, rvecs, tvecs = cv2.calibrateCamera(
        obj_points,
        img_points,
        image_size,
        None,
        None,
        flags=cv2.CALIB_RATIONAL_MODEL,  # more accurate for wide-angle phone lenses
    )

    logger.info(
        "Intrinsic calibration complete: RMS=%.4fpx, frames=%d, image_size=%s",
        rms,
        len(observations),
        image_size,
    )

    return IntrinsicResult(
        camera_matrix=camera_matrix,
        dist_coeffs=dist_coeffs.flatten(),
        image_size=image_size,
        reprojection_error_px=float(rms),
    )


def save_intrinsics(
    result: IntrinsicResult,
    out_path: Path,
    camera_id: int = 0,
    scale_px_per_mm: float | None = None,
) -> None:
    """Persist intrinsic calibration to a JSON file for the physics pipeline."""
    K = result.camera_matrix
    D = result.dist_coeffs
    data: dict = {
        "camera_id": camera_id,
        "image_size": list(result.image_size),
        "fx": float(K[0, 0]),
        "fy": float(K[1, 1]),
        "cx": float(K[0, 2]),
        "cy": float(K[1, 2]),
        "k1": float(D[0]),
        "k2": float(D[1]),
        "p1": float(D[2]),
        "p2": float(D[3]),
        "k3": float(D[4]) if len(D) > 4 else 0.0,
        "reprojection_error_px": result.reprojection_error_px,
    }
    if scale_px_per_mm is not None:
        # Compute a scale estimate from the calibrated focal length if not explicitly provided.
        data["scale_px_per_mm"] = scale_px_per_mm
        data["scale_uncertainty_px_per_mm"] = 0.005
    else:
        # Rough estimate: fx / (object_distance_mm). Not reliable without known distance.
        # Leave as None so the physics pipeline falls back to the ruler scale.
        data["scale_px_per_mm"] = None
        data["scale_uncertainty_px_per_mm"] = None

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(data, f, indent=2)
    logger.info("Saved intrinsics to %s", out_path)


def load_intrinsics(calib_path: Path) -> tuple[np.ndarray, np.ndarray] | None:
    """
    Load camera matrix and distortion coefficients from a saved JSON file.

    Returns (camera_matrix, dist_coeffs) or None if file doesn't exist.
    """
    if not calib_path.exists():
        return None
    with open(calib_path) as f:
        data = json.load(f)

    K = np.array([
        [data["fx"], 0.0,        data["cx"]],
        [0.0,        data["fy"], data["cy"]],
        [0.0,        0.0,        1.0],
    ], dtype=np.float64)

    D = np.array(
        [data["k1"], data["k2"], data["p1"], data["p2"], data.get("k3", 0.0)],
        dtype=np.float64,
    )
    return K, D
