"""
calibration/intrinsic.py

Production-quality single-camera intrinsic calibration using OpenCV.

Reads extracted PNG/JPEG frames from an experiment's frames directory,
detects checkerboard corners with sub-pixel refinement, and runs
cv2.calibrateCamera to recover the camera matrix K and distortion
coefficients D.

Designed to be called from grpc_server.RunCalibration as a generator
so progress can be streamed to the frontend.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Generator, NamedTuple

import cv2
import numpy as np

logger = logging.getLogger(__name__)

# Inner corner count of the calibration board (cols, rows).
# We intentionally use odd/even counts (9x6) to avoid 180-degree corner-order ambiguity
# that can occur with even/even checkerboards.
BOARD_COLS = 9   # inner corners along the long axis
BOARD_ROWS = 6   # inner corners along the short axis
BOARD_SIZE = (BOARD_COLS, BOARD_ROWS)

# Physical size of one checkerboard square in mm.
# The Blender synthetic generator uses the same CALIBRATION_SQUARE_SIZE_MM
# default so stereo translation scale matches the rendered board.
SQUARE_SIZE_MM = float(os.getenv("CALIBRATION_SQUARE_SIZE_MM", "40.0"))

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
INTRINSIC_OUTLIER_MULTIPLIER = 2.5
MIN_INTRINSIC_INLIERS = 20
MAX_CALIBRATION_VIEWS = 32
DEBUG_FOUND_OVERLAYS_LIMIT = 20
DEBUG_REJECTED_OVERLAYS_LIMIT = 20
MIN_BOARD_AREA_RATIO = float(os.getenv("CALIBRATION_MIN_BOARD_AREA_RATIO", "0.0025"))
MIN_NEIGHBOR_STEP_PX = 6.0
MAX_STEP_ANISOTROPY = 3.0
MAX_SCAN_FRAMES = int(os.getenv("CALIBRATION_MAX_SCAN_FRAMES", "100"))


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


def _view_reprojection_errors(
    obj_points: list[np.ndarray],
    img_points: list[np.ndarray],
    rvecs: list[np.ndarray],
    tvecs: list[np.ndarray],
    camera_matrix: np.ndarray,
    dist_coeffs: np.ndarray,
) -> list[float]:
    """Compute per-view RMS reprojection error in pixels."""
    view_errors: list[float] = []
    for objp, imgp, rvec, tvec in zip(obj_points, img_points, rvecs, tvecs):
        projected, _ = cv2.projectPoints(objp, rvec, tvec, camera_matrix, dist_coeffs)
        err = cv2.norm(imgp, projected, cv2.NORM_L2) / max(1, len(projected))
        view_errors.append(float(err))
    return view_errors


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
    files = sorted(candidates, key=lambda p: p.name)
    if MAX_SCAN_FRAMES > 0:
        files = files[:MAX_SCAN_FRAMES]
    return files


def _check_corner_sanity(
    corners: np.ndarray,
    image_size: tuple[int, int],
) -> tuple[bool, str, float]:
    """
    Reject detections that are too small or geometrically implausible.
    Returns (ok, reason, area_ratio).
    """
    w, h = image_size
    pts = corners.reshape(-1, 2)
    min_xy = pts.min(axis=0)
    max_xy = pts.max(axis=0)
    bbox_w = float(max_xy[0] - min_xy[0])
    bbox_h = float(max_xy[1] - min_xy[1])
    area_ratio = (bbox_w * bbox_h) / max(1.0, float(w * h))
    if area_ratio < MIN_BOARD_AREA_RATIO:
        return False, f"tiny board area ({area_ratio * 100.0:.2f}%)", area_ratio

    grid = corners.reshape(BOARD_ROWS, BOARD_COLS, 2)
    dx = np.linalg.norm(grid[:, 1:, :] - grid[:, :-1, :], axis=2).reshape(-1)
    dy = np.linalg.norm(grid[1:, :, :] - grid[:-1, :, :], axis=2).reshape(-1)
    med_dx = float(np.median(dx)) if dx.size else 0.0
    med_dy = float(np.median(dy)) if dy.size else 0.0
    if med_dx < MIN_NEIGHBOR_STEP_PX or med_dy < MIN_NEIGHBOR_STEP_PX:
        return (
            False,
            f"corner spacing too small (dx={med_dx:.1f}px, dy={med_dy:.1f}px)",
            area_ratio,
        )
    ratio = max(med_dx, med_dy) / max(1e-6, min(med_dx, med_dy))
    if ratio > MAX_STEP_ANISOTROPY:
        return (
            False,
            f"checker anisotropy too high (step ratio={ratio:.2f})",
            area_ratio,
        )
    return True, "ok", area_ratio


def _calibration_debug_dir(frames_dir: Path) -> Path:
    """Map frames/.../camN to calibration/debug/camN."""
    exp_dir = frames_dir.parent.parent
    cam_name = frames_dir.name
    out_dir = exp_dir / "calibration" / "debug" / cam_name
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


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
    rejected_count = 0
    found_frame_indices: list[int] = []
    debug_dir = _calibration_debug_dir(frames_dir)
    saved_found = 0
    saved_rejected = 0
    for i, path in enumerate(sampled):
        frame_idx = i * stride
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
        used_sb = False
        # Fallback for synthetic/low-texture cases where classic detector misses.
        if not found and hasattr(cv2, "findChessboardCornersSB"):
            found, corners = cv2.findChessboardCornersSB(
                gray,
                BOARD_SIZE,
                flags=cv2.CALIB_CB_EXHAUSTIVE | cv2.CALIB_CB_ACCURACY,
            )
            used_sb = found

        if not found:
            yield i, len(sampled), None
            continue

        sanity_ok, sanity_reason, area_ratio = _check_corner_sanity(corners, (w, h))
        if not sanity_ok:
            rejected_count += 1
            if saved_rejected < DEBUG_REJECTED_OVERLAYS_LIMIT:
                rejected_vis = bgr.copy()
                cv2.drawChessboardCorners(rejected_vis, BOARD_SIZE, corners, True)
                cv2.putText(
                    rejected_vis,
                    f"REJECTED: {sanity_reason}",
                    (20, 36),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.8,
                    (0, 0, 255),
                    2,
                    cv2.LINE_AA,
                )
                cv2.imwrite(
                    str(debug_dir / f"rejected_frame_{frame_idx:06d}.jpg"),
                    rejected_vis,
                )
                saved_rejected += 1
            logger.info(
                "Rejected checkerboard candidate in %s frame=%d: %s",
                frames_dir,
                frame_idx,
                sanity_reason,
            )
            yield i, len(sampled), None
            continue

        # SB detector already returns sub-pixel corners; refining again can drift on
        # small/blurred boards. Keep cornerSubPix only for classic detector results.
        if not used_sb:
            cv2.cornerSubPix(gray, corners, SUBPIX_WINDOW, SUBPIX_ZERO_ZONE, SUBPIX_CRITERIA)
        found_count += 1
        found_frame_indices.append(frame_idx)
        if saved_found < DEBUG_FOUND_OVERLAYS_LIMIT:
            found_vis = bgr.copy()
            cv2.drawChessboardCorners(found_vis, BOARD_SIZE, corners, True)
            cv2.putText(
                found_vis,
                f"FOUND: area={area_ratio * 100.0:.2f}%",
                (20, 36),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                (0, 255, 0),
                2,
                cv2.LINE_AA,
            )
            cv2.imwrite(str(debug_dir / f"found_frame_{frame_idx:06d}.jpg"), found_vis)
            saved_found += 1

        obs = CornerObservation(
            frame_idx=frame_idx,
            image_points=corners,
            image_size=(w, h),
        )
        yield i, len(sampled), obs
    active_span_frames = 0
    active_coverage_pct = 0.0
    if found_frame_indices:
        first_idx = min(found_frame_indices)
        last_idx = max(found_frame_indices)
        active_span_frames = (last_idx - first_idx) + 1
        active_coverage_pct = 100.0 * found_count / max(1, active_span_frames)
        logger.info(
            "Corner active window for %s: first=%d last=%d span=%d found=%d (%.1f%% within active window)",
            frames_dir,
            first_idx,
            last_idx,
            active_span_frames,
            found_count,
            active_coverage_pct,
        )
    logger.info(
        "Corner detection summary for %s: sampled=%d stride=%d found=%d rejected=%d (%.1f%%)",
        frames_dir,
        len(sampled),
        stride,
        found_count,
        rejected_count,
        (100.0 * found_count / max(1, len(sampled))),
    )
    logger.info("Saved calibration debug overlays to %s", debug_dir)


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

    if len(observations) > MAX_CALIBRATION_VIEWS:
        original_count = len(observations)
        sample_idx = np.linspace(0, original_count - 1, MAX_CALIBRATION_VIEWS, dtype=int)
        observations = [observations[int(i)] for i in sample_idx]
        logger.info(
            "Intrinsic view downsample: using %d/%d frames for solve",
            len(observations),
            original_count,
        )

    objp = _object_points()
    obj_points = [objp for _ in observations]
    img_points = [obs.image_points for obs in observations]
    image_size = observations[0].image_size  # (w, h)

    base_flags = cv2.CALIB_ZERO_TANGENT_DIST | cv2.CALIB_FIX_K3
    init_K = cv2.initCameraMatrix2D(obj_points, img_points, image_size)
    init_D = np.zeros((5, 1), dtype=np.float64)
    rms, camera_matrix, dist_coeffs, rvecs, tvecs = cv2.calibrateCamera(
        obj_points,
        img_points,
        image_size,
        init_K,
        init_D,
        flags=base_flags | cv2.CALIB_USE_INTRINSIC_GUESS,
        criteria=(cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, 1e-4),
    )

    view_errors = _view_reprojection_errors(
        obj_points, img_points, rvecs, tvecs, camera_matrix, dist_coeffs
    )
    median_err = float(np.median(view_errors)) if view_errors else float(rms)
    outlier_cutoff = max(1.0, median_err * INTRINSIC_OUTLIER_MULTIPLIER)
    inlier_idx = [i for i, e in enumerate(view_errors) if e <= outlier_cutoff]
    if len(inlier_idx) >= MIN_INTRINSIC_INLIERS and len(inlier_idx) < len(observations):
        inlier_obj = [obj_points[i] for i in inlier_idx]
        inlier_img = [img_points[i] for i in inlier_idx]
        logger.info(
            "Intrinsic outlier rejection: kept=%d/%d views (cutoff=%.3fpx, median=%.3fpx)",
            len(inlier_idx),
            len(observations),
            outlier_cutoff,
            median_err,
        )
        rms, camera_matrix, dist_coeffs, rvecs, tvecs = cv2.calibrateCamera(
            inlier_obj,
            inlier_img,
            image_size,
            camera_matrix,
            dist_coeffs,
            flags=base_flags | cv2.CALIB_USE_INTRINSIC_GUESS,
            criteria=(cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, 1e-4),
        )
        obj_points = inlier_obj

    logger.info(
        "Intrinsic calibration complete: RMS=%.4fpx, frames=%d, image_size=%s, fx=%.2f, fy=%.2f, cx=%.2f, cy=%.2f",
        rms,
        len(obj_points),
        image_size,
        camera_matrix[0, 0],
        camera_matrix[1, 1],
        camera_matrix[0, 2],
        camera_matrix[1, 2],
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
