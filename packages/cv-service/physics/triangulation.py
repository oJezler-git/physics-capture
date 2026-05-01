from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from calibration.intrinsic import load_intrinsics
from calibration.stereo import load_stereo_extrinsics
from .exceptions import InsufficientDataError
from .converter import MetricTrack
from .loader import LoadedTrack


@dataclass
class TriangulatedTrack:
    ball_id: int
    t_s: np.ndarray
    xyz_m: np.ndarray


def triangulate_loaded_tracks(
    experiment_dir: Path,
    cam0_track: LoadedTrack,
    cam1_track: LoadedTrack,
) -> TriangulatedTrack:
    stereo_path = experiment_dir / "calibration" / "stereo_extrinsics.json"
    stereo = load_stereo_extrinsics(stereo_path)
    if stereo is None:
        raise FileNotFoundError(f"Stereo extrinsics not found: {stereo_path}")
    intrinsics0 = load_intrinsics(experiment_dir / "calibration" / "cam0_intrinsics.json")
    intrinsics1 = load_intrinsics(experiment_dir / "calibration" / "cam1_intrinsics.json")
    if intrinsics0 is None or intrinsics1 is None:
        raise FileNotFoundError("Stereo triangulation requires cam0/cam1 intrinsics.")
    K0, D0 = intrinsics0
    K1, D1 = intrinsics1

    frame_count = min(len(cam0_track.timestamps_ms), len(cam1_track.timestamps_ms))
    xyz_m = np.full((frame_count, 3), np.nan, dtype=np.float64)
    timestamps_s = cam0_track.timestamps_ms[:frame_count] / 1000.0

    valid_mask = (
        ~np.isnan(cam0_track.x_px[:frame_count])
        & ~np.isnan(cam0_track.y_px[:frame_count])
        & ~np.isnan(cam1_track.x_px[:frame_count])
        & ~np.isnan(cam1_track.y_px[:frame_count])
    )
    valid_indices = np.where(valid_mask)[0]
    if valid_indices.size < 2:
        raise InsufficientDataError(
            f"Ball {cam0_track.ball_id} has less than 2 stereo-overlap frames"
        )

    points0 = np.vstack(
        [cam0_track.x_px[valid_indices], cam0_track.y_px[valid_indices]]
    ).astype(np.float64)
    points1 = np.vstack(
        [cam1_track.x_px[valid_indices], cam1_track.y_px[valid_indices]]
    ).astype(np.float64)

    # Explicitly undistort tracker points before triangulation to avoid
    # calibration-model mismatch when tracker emits raw pixel coordinates.
    points0_cv = points0.T.reshape(-1, 1, 2)
    points1_cv = points1.T.reshape(-1, 1, 2)
    undist0 = cv2.undistortPoints(points0_cv, K0, D0, P=K0).reshape(-1, 2).T
    undist1 = cv2.undistortPoints(points1_cv, K1, D1, P=K1).reshape(-1, 2).T

    points_4d = cv2.triangulatePoints(stereo.P0, stereo.P1, undist0, undist1)
    points_3d = (points_4d[:3, :] / points_4d[3, :]).T

    xyz_m[valid_indices] = points_3d / 1000.0

    return TriangulatedTrack(
        ball_id=cam0_track.ball_id,
        t_s=timestamps_s,
        xyz_m=xyz_m,
    )


def triangulated_to_metric_track(
    tri_track: TriangulatedTrack,
    position_sigma_m: float = 0.001,
) -> MetricTrack:
    valid_mask = ~np.isnan(tri_track.xyz_m).any(axis=1)
    valid_points = tri_track.xyz_m[valid_mask]
    if valid_points.shape[0] < 2:
        raise InsufficientDataError(
            f"Ball {tri_track.ball_id} has less than 2 valid 3D points"
        )

    centered = valid_points - np.mean(valid_points, axis=0)
    _, _, vh = np.linalg.svd(centered, full_matrices=False)
    principal_axis = vh[0]
    projected = np.full(tri_track.xyz_m.shape[0], np.nan, dtype=np.float64)
    projected[valid_mask] = centered @ principal_axis
    projected[valid_mask] -= projected[valid_mask][0]

    sigma = np.full_like(projected, position_sigma_m, dtype=np.float64)

    return MetricTrack(
        ball_id=tri_track.ball_id,
        t_s=tri_track.t_s,
        x_m=projected,
        sigma_x_m=sigma,
    )
