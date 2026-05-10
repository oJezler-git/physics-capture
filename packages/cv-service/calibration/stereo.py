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
from dataclasses import dataclass, field
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
    _check_corner_sanity,
)

logger = logging.getLogger(__name__)

# Minimum simultaneous observations required for stereo calibration.
MIN_STEREO_FRAMES = 8
EARLY_STOP_MISS_STREAK = 12  # sampled frames; with stride=5 this is ~60 source frames.
STEREO_SCAN_STRIDE = 3
STEREO_PAIR_DEBUG_IMAGE_LIMIT = 40
PNP_BASELINE_ABS_TOL_MM = 15.0
PNP_BASELINE_REL_TOL = 0.25
PNP_DIRECTION_MAX_DEG = 18.0
STEREO_VIEW_ERROR_MIN_CUTOFF_PX = 1.0
STEREO_VIEW_ERROR_MULTIPLIER = 3.0


class StereoResult(NamedTuple):
    R: np.ndarray           # 3x3 rotation matrix (cam0 → cam1)
    T: np.ndarray           # 3-vector translation (mm)
    E: np.ndarray           # Essential matrix
    F: np.ndarray           # Fundamental matrix
    P0: np.ndarray          # 3x4 projection matrix for cam0
    P1: np.ndarray          # 3x4 projection matrix for cam1
    reprojection_error_px: float


@dataclass
class StereoPairCandidate:
    """One simultaneous checkerboard observation plus stereo quality metadata."""

    frame_idx: int
    obj_points: np.ndarray
    img_points_0: np.ndarray
    img_points_1: np.ndarray
    image_size_0: tuple[int, int]
    image_size_1: tuple[int, int]
    detector0: str
    detector1: str
    area0: float
    area1: float
    pnp_baseline_mm: float | None = None
    pnp_translation_mm: list[float] | None = None
    pnp_reprojection0_px: float | None = None
    pnp_reprojection1_px: float | None = None
    stereo_view_error_px: float | None = None
    accepted: bool = True
    rejection_reasons: list[str] = field(default_factory=list)


def _detect_stereo_corners(gray: np.ndarray) -> tuple[bool, np.ndarray | None, str]:
    """
    Detect checkerboard corners for stereo calibration.

    Prefer SB first so both cameras use the same ordering convention whenever
    possible. The classic/SB mixed cases are exactly where synthetic runs were
    producing geometrically inconsistent corner indices.
    """
    if hasattr(cv2, "findChessboardCornersSB"):
        found, corners = cv2.findChessboardCornersSB(
            gray,
            BOARD_SIZE,
            flags=cv2.CALIB_CB_EXHAUSTIVE | cv2.CALIB_CB_ACCURACY,
        )
        if found:
            return True, corners, "sb"

    found, corners = cv2.findChessboardCorners(
        gray,
        BOARD_SIZE,
        flags=(
            cv2.CALIB_CB_ADAPTIVE_THRESH
            | cv2.CALIB_CB_NORMALIZE_IMAGE
            | cv2.CALIB_CB_FAST_CHECK
        ),
    )
    if found:
        cv2.cornerSubPix(gray, corners, SUBPIX_WINDOW, SUBPIX_ZERO_ZONE, SUBPIX_CRITERIA)
        return True, corners, "classic"
    return False, None, "none"


def _solve_pnp_reprojection_error(
    objp: np.ndarray,
    imgp: np.ndarray,
    camera_matrix: np.ndarray,
    dist_coeffs: np.ndarray,
    rvec: np.ndarray,
    tvec: np.ndarray,
) -> float:
    projected, _ = cv2.projectPoints(objp, rvec, tvec, camera_matrix, dist_coeffs)
    diff = imgp.reshape(-1, 2) - projected.reshape(-1, 2)
    return float(np.sqrt(np.mean(np.sum(diff * diff, axis=1))))


def _estimate_pair_pnp_pose(
    pair: StereoPairCandidate,
    K0: np.ndarray,
    D0: np.ndarray,
    K1: np.ndarray,
    D1: np.ndarray,
) -> None:
    """
    Estimate an independent cam0->cam1 transform from the two single-camera
    board poses. This is a cheap, strong consistency check before global stereo.
    """
    ok0, rvec0, tvec0 = cv2.solvePnP(
        pair.obj_points,
        pair.img_points_0,
        K0,
        D0,
        flags=cv2.SOLVEPNP_ITERATIVE,
    )
    ok1, rvec1, tvec1 = cv2.solvePnP(
        pair.obj_points,
        pair.img_points_1,
        K1,
        D1,
        flags=cv2.SOLVEPNP_ITERATIVE,
    )
    if not (ok0 and ok1):
        pair.rejection_reasons.append("pnp_failed")
        pair.accepted = False
        return

    R0, _ = cv2.Rodrigues(rvec0)
    R1, _ = cv2.Rodrigues(rvec1)
    R_rel = R1 @ R0.T
    T_rel = tvec1 - R_rel @ tvec0
    pair.pnp_baseline_mm = float(np.linalg.norm(T_rel))
    pair.pnp_translation_mm = [float(v) for v in T_rel.reshape(-1)]
    pair.pnp_reprojection0_px = _solve_pnp_reprojection_error(
        pair.obj_points, pair.img_points_0, K0, D0, rvec0, tvec0
    )
    pair.pnp_reprojection1_px = _solve_pnp_reprojection_error(
        pair.obj_points, pair.img_points_1, K1, D1, rvec1, tvec1
    )


def _append_rejection(pair: StereoPairCandidate, reason: str) -> None:
    pair.accepted = False
    if reason not in pair.rejection_reasons:
        pair.rejection_reasons.append(reason)


def _filter_pairs_by_pnp_consensus(
    pairs: list[StereoPairCandidate],
) -> list[StereoPairCandidate]:
    """Reject pairs whose independent PnP baseline/direction disagrees."""
    pnp_pairs = [
        p for p in pairs
        if p.accepted and p.pnp_baseline_mm is not None and p.pnp_translation_mm is not None
    ]
    if len(pnp_pairs) < MIN_STEREO_FRAMES:
        return [p for p in pairs if p.accepted]

    baselines = np.array([p.pnp_baseline_mm for p in pnp_pairs], dtype=np.float64)
    median_baseline = float(np.median(baselines))
    mad = float(np.median(np.abs(baselines - median_baseline)))
    robust_sigma = 1.4826 * mad
    baseline_tol = max(
        PNP_BASELINE_ABS_TOL_MM,
        PNP_BASELINE_REL_TOL * max(1.0, median_baseline),
        3.0 * robust_sigma,
    )

    translations = np.array([p.pnp_translation_mm for p in pnp_pairs], dtype=np.float64)
    median_translation = np.median(translations, axis=0)
    median_norm = float(np.linalg.norm(median_translation))
    min_direction_dot = float(np.cos(np.deg2rad(PNP_DIRECTION_MAX_DEG)))

    for pair in pnp_pairs:
        baseline_delta = abs(float(pair.pnp_baseline_mm) - median_baseline)
        if baseline_delta > baseline_tol:
            _append_rejection(
                pair,
                (
                    "pnp_baseline_outlier:"
                    f"baseline={pair.pnp_baseline_mm:.2f}mm "
                    f"median={median_baseline:.2f}mm tol={baseline_tol:.2f}mm"
                ),
            )
            continue

        if median_norm > 1.0:
            t = np.array(pair.pnp_translation_mm, dtype=np.float64)
            t_norm = float(np.linalg.norm(t))
            if t_norm > 1.0:
                direction_dot = float(np.dot(t, median_translation) / (t_norm * median_norm))
                if direction_dot < min_direction_dot:
                    _append_rejection(
                        pair,
                        (
                            "pnp_direction_outlier:"
                            f"dot={direction_dot:.3f} min={min_direction_dot:.3f}"
                        ),
                    )

    kept = [p for p in pairs if p.accepted]
    logger.info(
        "Stereo PnP consensus filter: kept=%d/%d median_baseline=%.2fmm tol=%.2fmm",
        len(kept),
        len(pairs),
        median_baseline,
        baseline_tol,
    )
    return kept


def _stereo_view_errors(
    pairs: list[StereoPairCandidate],
    K0: np.ndarray,
    D0: np.ndarray,
    K1: np.ndarray,
    D1: np.ndarray,
    R: np.ndarray,
    T: np.ndarray,
) -> list[float]:
    """
    Approximate per-pair stereo consistency by solving the board pose in cam0
    and projecting the same board through the stereo transform into cam1.
    """
    errors: list[float] = []
    for pair in pairs:
        ok, rvec0, tvec0 = cv2.solvePnP(
            pair.obj_points,
            pair.img_points_0,
            K0,
            D0,
            flags=cv2.SOLVEPNP_ITERATIVE,
        )
        if not ok:
            pair.stereo_view_error_px = None
            errors.append(float("inf"))
            continue
        R0, _ = cv2.Rodrigues(rvec0)
        rvec1, _ = cv2.Rodrigues(R @ R0)
        tvec1 = R @ tvec0 + T

        projected0, _ = cv2.projectPoints(pair.obj_points, rvec0, tvec0, K0, D0)
        projected1, _ = cv2.projectPoints(pair.obj_points, rvec1, tvec1, K1, D1)
        err0 = pair.img_points_0.reshape(-1, 2) - projected0.reshape(-1, 2)
        err1 = pair.img_points_1.reshape(-1, 2) - projected1.reshape(-1, 2)
        combined = np.vstack([err0, err1])
        rms = float(np.sqrt(np.mean(np.sum(combined * combined, axis=1))))
        pair.stereo_view_error_px = rms
        errors.append(rms)
    return errors


def _solve_stereo(
    pairs: list[StereoPairCandidate],
    K0: np.ndarray,
    D0: np.ndarray,
    K1: np.ndarray,
    D1: np.ndarray,
    img_size: tuple[int, int],
) -> tuple[float, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    obj_points = [p.obj_points for p in pairs]
    img_pts0 = [p.img_points_0 for p in pairs]
    img_pts1 = [p.img_points_1 for p in pairs]
    rms, _, _, _, _, R, T, E, F = cv2.stereoCalibrate(
        obj_points,
        img_pts0,
        img_pts1,
        K0,
        D0,
        K1,
        D1,
        img_size,
        flags=cv2.CALIB_FIX_INTRINSIC,
        criteria=(cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 100, 1e-5),
    )
    return float(rms), R, T, E, F


def _filter_pairs_by_stereo_view_error(
    pairs: list[StereoPairCandidate],
    errors: list[float],
) -> list[StereoPairCandidate]:
    finite_errors = np.array([e for e in errors if np.isfinite(e)], dtype=np.float64)
    if len(finite_errors) < MIN_STEREO_FRAMES:
        return pairs

    median_err = float(np.median(finite_errors))
    mad = float(np.median(np.abs(finite_errors - median_err)))
    robust_sigma = 1.4826 * mad
    cutoff = max(
        STEREO_VIEW_ERROR_MIN_CUTOFF_PX,
        median_err * STEREO_VIEW_ERROR_MULTIPLIER,
        median_err + 3.0 * robust_sigma,
    )

    outliers: list[tuple[StereoPairCandidate, str]] = []
    for pair in pairs:
        err = pair.stereo_view_error_px
        if err is None or not np.isfinite(err):
            outliers.append((pair, "stereo_view_error_failed"))
        elif err > cutoff:
            outliers.append(
                (
                    pair,
                    f"stereo_view_error_outlier:error={err:.3f}px cutoff={cutoff:.3f}px",
                )
            )

    if not outliers:
        return pairs

    if len(pairs) - len(outliers) < MIN_STEREO_FRAMES:
        logger.warning(
            "Stereo view-error filter found %d outliers but keeping them because only %d/%d pairs would remain.",
            len(outliers),
            len(pairs) - len(outliers),
            MIN_STEREO_FRAMES,
        )
        return pairs

    for pair, reason in outliers:
        _append_rejection(pair, reason)

    kept = [p for p in pairs if p.accepted]
    if len(kept) >= MIN_STEREO_FRAMES:
        logger.info(
            "Stereo view-error filter: kept=%d/%d median=%.3fpx cutoff=%.3fpx",
            len(kept),
            len(pairs),
            median_err,
            cutoff,
        )
        return kept
    return pairs


def _draw_pair_debug_image(
    pair: StereoPairCandidate,
    bgr0: np.ndarray,
    bgr1: np.ndarray,
    debug_dir: Path,
) -> None:
    status = "accepted" if pair.accepted else "rejected"
    reason = "ok" if pair.accepted else pair.rejection_reasons[0].split(":", 1)[0]
    vis0 = bgr0.copy()
    vis1 = bgr1.copy()
    cv2.drawChessboardCorners(vis0, BOARD_SIZE, pair.img_points_0, True)
    cv2.drawChessboardCorners(vis1, BOARD_SIZE, pair.img_points_1, True)
    label = (
        f"{status.upper()} frame={pair.frame_idx} {reason} "
        f"pnp_bl={pair.pnp_baseline_mm or 0.0:.1f}mm"
    )
    for vis in (vis0, vis1):
        cv2.putText(
            vis,
            label,
            (20, 36),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.8,
            (0, 255, 0) if pair.accepted else (0, 0, 255),
            2,
            cv2.LINE_AA,
        )
    combined = np.hstack([vis0, vis1])
    out_path = debug_dir / f"{status}_frame_{pair.frame_idx:06d}_{reason}.jpg"
    cv2.imwrite(str(out_path), combined)


def _write_stereo_pair_diagnostics(
    pairs: list[StereoPairCandidate],
    debug_dir: Path,
    final_rms: float | None,
    final_baseline_mm: float | None,
) -> None:
    debug_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "board_cols": BOARD_COLS,
        "board_rows": BOARD_ROWS,
        "square_size_mm": SQUARE_SIZE_MM,
        "scan_stride": STEREO_SCAN_STRIDE,
        "min_stereo_frames": MIN_STEREO_FRAMES,
        "accepted_count": sum(1 for p in pairs if p.accepted),
        "rejected_count": sum(1 for p in pairs if not p.accepted),
        "final_reprojection_error_px": final_rms,
        "final_baseline_mm": final_baseline_mm,
        "pairs": [
            {
                "frame_idx": p.frame_idx,
                "accepted": p.accepted,
                "rejection_reasons": p.rejection_reasons,
                "detector0": p.detector0,
                "detector1": p.detector1,
                "area0_pct": p.area0 * 100.0,
                "area1_pct": p.area1 * 100.0,
                "pnp_baseline_mm": p.pnp_baseline_mm,
                "pnp_translation_mm": p.pnp_translation_mm,
                "pnp_reprojection0_px": p.pnp_reprojection0_px,
                "pnp_reprojection1_px": p.pnp_reprojection1_px,
                "stereo_view_error_px": p.stereo_view_error_px,
            }
            for p in pairs
        ],
    }
    with open(debug_dir / "pair_diagnostics.json", "w") as f:
        json.dump(payload, f, indent=2)
    logger.info("Saved stereo pair diagnostics to %s", debug_dir / "pair_diagnostics.json")


def _find_simultaneous_corners(
    frames_dir0: Path,
    frames_dir1: Path,
) -> tuple[list[StereoPairCandidate], tuple[int, int], tuple[int, int]]:
    """
    Find frames where the checkerboard is visible in **both** cameras simultaneously.

    Assumes frames are numbered identically (same ffmpeg extraction pipeline).
    Returns (pair_candidates, image_size_0, image_size_1).
    """
    files0 = _sorted_frame_files(frames_dir0)
    files1 = _sorted_frame_files(frames_dir1)

    # Use the shorter sequence as the reference length.
    n = min(len(files0), len(files1))
    if n == 0:
        raise ValueError("No frames found in one or both frame directories.")

    objp = _object_points()
    pairs: list[StereoPairCandidate] = []
    image_size_0 = image_size_1 = None

    stride = STEREO_SCAN_STRIDE
    sampled_total = max(1, (n + stride - 1) // stride)
    start_ts = cv2.getTickCount()
    miss_streak = 0
    found_any = False

    for sample_idx, i in enumerate(range(0, n, stride)):
        bgr0 = cv2.imread(str(files0[i]))
        bgr1 = cv2.imread(str(files1[i]))
        if sample_idx % 25 == 0:
            elapsed_s = (cv2.getTickCount() - start_ts) / cv2.getTickFrequency()
            logger.info(
                "Stereo corner scan progress: %d/%d sampled, paired=%d, elapsed=%.1fs",
                sample_idx + 1,
                sampled_total,
                len(pairs),
                elapsed_s,
            )
        if bgr0 is None or bgr1 is None:
            continue

        gray0 = cv2.cvtColor(bgr0, cv2.COLOR_BGR2GRAY)
        gray1 = cv2.cvtColor(bgr1, cv2.COLOR_BGR2GRAY)

        found0, corners0, detector0 = _detect_stereo_corners(gray0)
        found1, corners1, detector1 = _detect_stereo_corners(gray1)

        if not (found0 and found1):
            miss_streak += 1
            if found_any and miss_streak >= EARLY_STOP_MISS_STREAK:
                logger.info(
                    "Stereo corner scan early-stop: miss streak=%d after paired detections; ending scan.",
                    miss_streak,
                )
                break
            continue  # Board not visible in both cameras in this frame.

        sanity0_ok, sanity0_reason, area0 = _check_corner_sanity(corners0, (gray0.shape[1], gray0.shape[0]))
        sanity1_ok, sanity1_reason, area1 = _check_corner_sanity(corners1, (gray1.shape[1], gray1.shape[0]))
        if not (sanity0_ok and sanity1_ok):
            logger.info(
                "Stereo pair rejected frame=%d cam0_ok=%s cam1_ok=%s reason0=%s reason1=%s area0=%.3f%% area1=%.3f%%",
                i,
                sanity0_ok,
                sanity1_ok,
                sanity0_reason,
                sanity1_reason,
                area0 * 100.0,
                area1 * 100.0,
            )
            miss_streak += 1
            continue

        found_any = True
        miss_streak = 0
        h0, w0 = gray0.shape[:2]
        h1, w1 = gray1.shape[:2]
        image_size_0 = (w0, h0)
        image_size_1 = (w1, h1)
        pairs.append(
            StereoPairCandidate(
                frame_idx=i,
                obj_points=objp,
                img_points_0=corners0,
                img_points_1=corners1,
                image_size_0=image_size_0,
                image_size_1=image_size_1,
                detector0=detector0,
                detector1=detector1,
                area0=area0,
                area1=area1,
            )
        )

    elapsed_s = (cv2.getTickCount() - start_ts) / cv2.getTickFrequency()
    logger.info(
        "Stereo corner scan complete: sampled=%d stride=%d paired=%d elapsed=%.1fs",
        sampled_total,
        stride,
        len(pairs),
        elapsed_s,
    )

    return pairs, image_size_0, image_size_1


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

    debug_dir = calib_dir / "debug" / "stereo"
    debug_dir.mkdir(parents=True, exist_ok=True)

    logger.info("Scanning frames for simultaneous checkerboard observations...")
    pairs, img_size0, img_size1 = _find_simultaneous_corners(frames_dir0, frames_dir1)
    logger.info(
        "Stereo simultaneous corners: %d paired frames (min required=%d)",
        len(pairs),
        MIN_STEREO_FRAMES,
    )

    if len(pairs) < MIN_STEREO_FRAMES:
        logger.warning(
            "Only %d simultaneous frames found; need at least %d. "
            "Stereo calibration skipped.",
            len(pairs),
            MIN_STEREO_FRAMES,
        )
        _write_stereo_pair_diagnostics(pairs, debug_dir, None, None)
        return None

    if img_size0 != img_size1:
        logger.warning(
            "Stereo cameras have different image sizes: cam0=%s cam1=%s; using cam0 size for OpenCV.",
            img_size0,
            img_size1,
        )

    for pair in pairs:
        _estimate_pair_pnp_pose(pair, K0, D0, K1, D1)

    accepted_pairs = _filter_pairs_by_pnp_consensus(pairs)
    if len(accepted_pairs) < MIN_STEREO_FRAMES:
        logger.warning(
            "Only %d stereo pairs survived PnP consensus; need at least %d. Stereo calibration skipped.",
            len(accepted_pairs),
            MIN_STEREO_FRAMES,
        )
        _write_stereo_pair_diagnostics(pairs, debug_dir, None, None)
        return None

    logger.info(
        "Running stereoCalibrate with %d/%d quality-filtered observations...",
        len(accepted_pairs),
        len(pairs),
    )
    rms, R, T, E, F = _solve_stereo(accepted_pairs, K0, D0, K1, D1, img_size0)
    errors = _stereo_view_errors(accepted_pairs, K0, D0, K1, D1, R, T)
    refined_pairs = _filter_pairs_by_stereo_view_error(accepted_pairs, errors)
    if len(refined_pairs) >= MIN_STEREO_FRAMES and len(refined_pairs) < len(accepted_pairs):
        logger.info(
            "Re-running stereoCalibrate after stereo view-error filtering: %d -> %d pairs",
            len(accepted_pairs),
            len(refined_pairs),
        )
        accepted_pairs = refined_pairs
        rms, R, T, E, F = _solve_stereo(accepted_pairs, K0, D0, K1, D1, img_size0)
        _stereo_view_errors(accepted_pairs, K0, D0, K1, D1, R, T)

    baseline_mm = float(np.linalg.norm(T))

    logger.info(
        "Stereo calibration complete: RMS=%.4fpx, baseline_mm=%.2f, accepted_pairs=%d/%d",
        rms,
        baseline_mm,
        len(accepted_pairs),
        len(pairs),
    )

    saved_debug = 0
    files0 = _sorted_frame_files(frames_dir0)
    files1 = _sorted_frame_files(frames_dir1)
    n = min(len(files0), len(files1))
    for pair in pairs:
        if saved_debug >= STEREO_PAIR_DEBUG_IMAGE_LIMIT:
            break
        if pair.frame_idx >= n:
            continue
        bgr0 = cv2.imread(str(files0[pair.frame_idx]))
        bgr1 = cv2.imread(str(files1[pair.frame_idx]))
        if bgr0 is None or bgr1 is None:
            continue
        _draw_pair_debug_image(pair, bgr0, bgr1, debug_dir)
        saved_debug += 1
    _write_stereo_pair_diagnostics(pairs, debug_dir, rms, baseline_mm)

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
