"""
calibration/stereo.py

Stereo extrinsic calibration using OpenCV.

Given intrinsic parameters for two cameras and a set of simultaneous
checkerboard observations from both, computes:
  - Rotation matrix R and translation vector T (cam0 → cam1 baseline)
  - Essential matrix E and fundamental matrix F
  - 3x4 projection matrices P0, P1 ready for cv2.triangulatePoints

Results are written to calibration/stereo_extrinsics.json.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import NamedTuple

import cv2
import numpy as np

from .intrinsic import (
    BOARD_SIZE,
    BOARD_ROWS,
    BOARD_COLS,
    SUBPIX_WINDOW,
    SUBPIX_ZERO_ZONE,
    SUBPIX_CRITERIA,
    SQUARE_SIZE_MM,
    CornerObservation,
    _object_points,
    _sorted_frame_files,
    load_intrinsics,
)

logger = logging.getLogger(__name__)

# Minimum simultaneous observations required for stereo calibration.
MIN_STEREO_FRAMES = 8


class StereoResult(NamedTuple):
    R: np.ndarray           # 3x3 rotation matrix (cam0 → cam1)
    T: np.ndarray           # 3-vector translation (mm)
    E: np.ndarray           # Essential matrix
    F: np.ndarray           # Fundamental matrix
    P0: np.ndarray          # 3x4 projection matrix for cam0
    P1: np.ndarray          # 3x4 projection matrix for cam1
    reprojection_error_px: float


def _find_simultaneous_corners(
    frames_dir0: Path,
    frames_dir1: Path,
) -> tuple[list[np.ndarray], list[np.ndarray], list[np.ndarray], tuple[int, int], tuple[int, int]]:
    """
    Find frames where the checkerboard is visible in **both** cameras simultaneously.

    Assumes frames are numbered identically (same ffmpeg extraction pipeline).
    Returns (obj_points, img_points_0, img_points_1, image_size_0, image_size_1).
    """
    files0 = _sorted_frame_files(frames_dir0)
    files1 = _sorted_frame_files(frames_dir1)

    # Use the shorter sequence as the reference length.
    n = min(len(files0), len(files1))
    if n == 0:
        raise ValueError("No frames found in one or both frame directories.")

    objp = _object_points()
    obj_points: list[np.ndarray] = []
    img_points_0: list[np.ndarray] = []
    img_points_1: list[np.ndarray] = []
    image_size_0 = image_size_1 = None

    for i in range(0, n, 5):  # stride=5 to sample diverse views
        bgr0 = cv2.imread(str(files0[i]))
        bgr1 = cv2.imread(str(files1[i]))
        if bgr0 is None or bgr1 is None:
            continue

        gray0 = cv2.cvtColor(bgr0, cv2.COLOR_BGR2GRAY)
        gray1 = cv2.cvtColor(bgr1, cv2.COLOR_BGR2GRAY)

        found0, corners0 = cv2.findChessboardCorners(
            gray0, BOARD_SIZE,
            flags=cv2.CALIB_CB_ADAPTIVE_THRESH | cv2.CALIB_CB_NORMALIZE_IMAGE,
        )
        found1, corners1 = cv2.findChessboardCorners(
            gray1, BOARD_SIZE,
            flags=cv2.CALIB_CB_ADAPTIVE_THRESH | cv2.CALIB_CB_NORMALIZE_IMAGE,
        )

        if not (found0 and found1):
            continue  # Board not visible in both cameras in this frame.

        cv2.cornerSubPix(gray0, corners0, SUBPIX_WINDOW, SUBPIX_ZERO_ZONE, SUBPIX_CRITERIA)
        cv2.cornerSubPix(gray1, corners1, SUBPIX_WINDOW, SUBPIX_ZERO_ZONE, SUBPIX_CRITERIA)

        obj_points.append(objp)
        img_points_0.append(corners0)
        img_points_1.append(corners1)

        h0, w0 = gray0.shape[:2]
        h1, w1 = gray1.shape[:2]
        image_size_0 = (w0, h0)
        image_size_1 = (w1, h1)

    return obj_points, img_points_0, img_points_1, image_size_0, image_size_1


def stereo_calibrate(
    experiment_dir: Path,
    camera_ids: list[int] = (0, 1),
) -> StereoResult | None:
    """
    Run stereo calibration for the given experiment using pre-computed intrinsics.

    Reads from:
      - experiment_dir/frames/camN/ (extracted frames)
      - experiment_dir/calibration/camN_intrinsics.json

    Returns None if insufficient simultaneous observations are found.
    """
    cam0, cam1 = int(camera_ids[0]), int(camera_ids[1])
    frames_dir0 = experiment_dir / "frames" / f"cam{cam0}"
    frames_dir1 = experiment_dir / "frames" / f"cam{cam1}"
    calib_dir = experiment_dir / "calibration"
    calib_path0 = calib_dir / f"cam{cam0}_intrinsics.json"
    calib_path1 = calib_dir / f"cam{cam1}_intrinsics.json"

    intrinsics0 = load_intrinsics(calib_path0)
    intrinsics1 = load_intrinsics(calib_path1)
    if intrinsics0 is None or intrinsics1 is None:
        logger.error(
            "Cannot run stereo calibration: intrinsics not found for both cameras. "
            "Run intrinsic calibration first."
        )
        return None

    K0, D0 = intrinsics0
    K1, D1 = intrinsics1

    logger.info("Scanning frames for simultaneous checkerboard observations...")
    obj_points, img_pts0, img_pts1, img_size0, img_size1 = (
        _find_simultaneous_corners(frames_dir0, frames_dir1)
    )

    if len(obj_points) < MIN_STEREO_FRAMES:
        logger.warning(
            "Only %d simultaneous frames found; need at least %d. "
            "Stereo calibration skipped.",
            len(obj_points),
            MIN_STEREO_FRAMES,
        )
        return None

    logger.info(
        "Running stereoCalibrate with %d simultaneous observations...", len(obj_points)
    )

    # Use CALIB_FIX_INTRINSIC: intrinsics are already optimised; only compute R, T, E, F.
    rms, _, _, _, _, R, T, E, F = cv2.stereoCalibrate(
        obj_points,
        img_pts0,
        img_pts1,
        K0,
        D0,
        K1,
        D1,
        img_size0,
        flags=cv2.CALIB_FIX_INTRINSIC,
        criteria=(cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 100, 1e-5),
    )

    logger.info(
        "Stereo calibration complete: RMS=%.4fpx, baseline_mm=%.2f",
        rms,
        float(np.linalg.norm(T)),
    )

    # Build 3x4 projection matrices: P = K [R | t]
    # cam0 is the reference: P0 = K0 [I | 0]
    P0 = K0 @ np.hstack([np.eye(3), np.zeros((3, 1))])
    # cam1: P1 = K1 [R | T]
    P1 = K1 @ np.hstack([R, T])

    return StereoResult(
        R=R,
        T=T,
        E=E,
        F=F,
        P0=P0,
        P1=P1,
        reprojection_error_px=float(rms),
    )


def save_stereo_extrinsics(result: StereoResult, out_path: Path) -> None:
    """Persist stereo extrinsics to JSON for the physics triangulation pipeline."""
    data = {
        "R": result.R.tolist(),
        "T": result.T.flatten().tolist(),   # mm
        "E": result.E.tolist(),
        "F": result.F.tolist(),
        "P0": result.P0.tolist(),
        "P1": result.P1.tolist(),
        "reprojection_error_px": result.reprojection_error_px,
        "baseline_mm": float(np.linalg.norm(result.T)),
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(data, f, indent=2)
    logger.info("Saved stereo extrinsics to %s", out_path)


def load_stereo_extrinsics(stereo_path: Path) -> StereoResult | None:
    """Load stereo extrinsics from JSON. Returns None if the file doesn't exist."""
    if not stereo_path.exists():
        return None
    with open(stereo_path) as f:
        data = json.load(f)
    return StereoResult(
        R=np.array(data["R"], dtype=np.float64),
        T=np.array(data["T"], dtype=np.float64),
        E=np.array(data["E"], dtype=np.float64),
        F=np.array(data["F"], dtype=np.float64),
        P0=np.array(data["P0"], dtype=np.float64),
        P1=np.array(data["P1"], dtype=np.float64),
        reprojection_error_px=float(data["reprojection_error_px"]),
    )
