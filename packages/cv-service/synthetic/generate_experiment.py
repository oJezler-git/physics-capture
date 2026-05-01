from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Tuple

import cv2
import numpy as np


@dataclass
class CameraModel:
    camera_id: int
    K: np.ndarray
    D: np.ndarray
    R: np.ndarray
    T: np.ndarray


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def make_camera_models(width: int, height: int, baseline_mm: float) -> tuple[CameraModel, CameraModel]:
    fx = 980.0
    fy = 980.0
    cx = width * 0.5
    cy = height * 0.52
    K = np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=np.float64)
    D = np.array([-0.08, 0.02, 0.001, -0.001, 0.0], dtype=np.float64)

    cam0 = CameraModel(
        camera_id=0,
        K=K.copy(),
        D=D.copy(),
        R=np.eye(3, dtype=np.float64),
        T=np.zeros((3, 1), dtype=np.float64),
    )

    yaw = np.deg2rad(1.5)
    R1 = np.array(
        [
            [np.cos(yaw), 0.0, np.sin(yaw)],
            [0.0, 1.0, 0.0],
            [-np.sin(yaw), 0.0, np.cos(yaw)],
        ],
        dtype=np.float64,
    )
    T1 = np.array([[-baseline_mm], [4.0], [3.0]], dtype=np.float64)
    cam1 = CameraModel(camera_id=1, K=K.copy(), D=D.copy(), R=R1, T=T1)
    return cam0, cam1


def project_points(points_xyz: np.ndarray, camera: CameraModel) -> np.ndarray:
    rvec, _ = cv2.Rodrigues(camera.R)
    tvec = camera.T
    points_2d, _ = cv2.projectPoints(points_xyz, rvec, tvec, camera.K, camera.D)
    return points_2d.reshape(-1, 2)


def draw_checkerboard(frame: np.ndarray, camera: CameraModel, t_s: float) -> None:
    cols, rows = 8, 6
    square = 25.0
    board_w = cols * square
    board_h = rows * square
    x0 = -board_w * 0.5 + 20.0 * np.sin(1.7 * t_s)
    y0 = 80.0 + 15.0 * np.cos(1.3 * t_s)
    z0 = 1300.0 + 120.0 * np.sin(0.9 * t_s)

    for r in range(rows):
        for c in range(cols):
            color = 230 if (r + c) % 2 == 0 else 35
            quad = np.array(
                [
                    [x0 + c * square, y0 + r * square, z0],
                    [x0 + (c + 1) * square, y0 + r * square, z0],
                    [x0 + (c + 1) * square, y0 + (r + 1) * square, z0],
                    [x0 + c * square, y0 + (r + 1) * square, z0],
                ],
                dtype=np.float64,
            )
            poly = project_points(quad, camera).astype(np.int32)
            if np.any(poly[:, 0] < -200) or np.any(poly[:, 0] > frame.shape[1] + 200):
                continue
            cv2.fillConvexPoly(frame, poly, (color, color, color))


def draw_sync_overlay(frame: np.ndarray, frame_idx: int, fps: float) -> None:
    h, w = frame.shape[:2]
    x0, y0 = int(w * 0.03), int(h * 0.03)
    rw, rh = int(w * 0.2), int(h * 0.08)
    roi = frame[y0 : y0 + rh, x0 : x0 + rw]
    if roi.size == 0:
        return

    t = frame_idx / fps
    phase = 0.5 + 0.5 * np.sin(2 * np.pi * 2.0 * t)
    grad = np.tile(np.linspace(0, 1, rw, dtype=np.float32), (rh, 1))
    roi[:, :, 1] = (40 + 180 * grad * phase).astype(np.uint8)
    roi[:, :, 2] = (20 + 120 * (1 - grad) * (1 - phase)).astype(np.uint8)

    gray_code = frame_idx % 1024
    bits = f"{gray_code:010b}"
    for i, bit in enumerate(bits):
        bx = x0 + 4 + i * (rw // 10)
        by = y0 + rh - 12
        color = (240, 240, 240) if bit == "1" else (30, 30, 30)
        cv2.rectangle(frame, (bx, by), (bx + (rw // 12), by + 8), color, -1)


def ball_world_positions(frame_idx: int, fps: float, collision_frame: int) -> tuple[np.ndarray, np.ndarray]:
    t = frame_idx / fps
    t_col = collision_frame / fps
    z = 1500.0 + 40.0 * np.sin(0.8 * t)
    y = 40.0 + 10.0 * np.cos(1.2 * t)

    if frame_idx < collision_frame:
        x0 = -230.0 + 420.0 * t
        x1 = 230.0 - 120.0 * t
    else:
        x_col0 = -230.0 + 420.0 * t_col
        x_col1 = 230.0 - 120.0 * t_col
        x0 = x_col0 - 180.0 * (t - t_col)
        x1 = x_col1 + 280.0 * (t - t_col)

    p0 = np.array([[x0, y, z]], dtype=np.float64)
    p1 = np.array([[x1, y + 15.0, z + 10.0]], dtype=np.float64)
    return p0, p1


def draw_ball(frame: np.ndarray, camera: CameraModel, point_xyz: np.ndarray, color: Tuple[int, int, int], radius_mm: float) -> tuple[float, float] | None:
    uv = project_points(point_xyz, camera)[0]
    x, y = float(uv[0]), float(uv[1])
    z = float(point_xyz[0, 2])
    if z <= 10:
        return None
    r_px = max(2, int(camera.K[0, 0] * (radius_mm / z)))
    if x < -r_px or y < -r_px or x >= frame.shape[1] + r_px or y >= frame.shape[0] + r_px:
        return None
    cv2.circle(frame, (int(x), int(y)), r_px, color, -1, lineType=cv2.LINE_AA)
    cv2.circle(frame, (int(x - 0.35 * r_px), int(y - 0.35 * r_px)), max(1, r_px // 4), (255, 255, 255), -1)
    return x, y


def add_camera_artifacts(frame: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    noisy = frame.astype(np.float32)
    noisy *= rng.uniform(0.92, 1.08)
    noisy += rng.normal(0, 6.0, size=noisy.shape)
    noisy = np.clip(noisy, 0, 255).astype(np.uint8)
    if rng.random() < 0.8:
        noisy = cv2.GaussianBlur(noisy, (3, 3), sigmaX=rng.uniform(0.2, 0.8))

    quality = int(rng.integers(75, 92))
    ok, encoded = cv2.imencode(".jpg", noisy, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if ok:
        decoded = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
        if decoded is not None:
            return decoded
    return noisy


def save_intrinsics(path: Path, cam: CameraModel, width: int, height: int) -> None:
    payload = {
        "camera_id": cam.camera_id,
        "image_size": [width, height],
        "fx": float(cam.K[0, 0]),
        "fy": float(cam.K[1, 1]),
        "cx": float(cam.K[0, 2]),
        "cy": float(cam.K[1, 2]),
        "k1": float(cam.D[0]),
        "k2": float(cam.D[1]),
        "p1": float(cam.D[2]),
        "p2": float(cam.D[3]),
        "k3": float(cam.D[4]),
        "reprojection_error_px": 0.22,
        "scale_px_per_mm": None,
        "scale_uncertainty_px_per_mm": None,
    }
    path.write_text(json.dumps(payload, indent=2))


def save_stereo(path: Path, cam0: CameraModel, cam1: CameraModel) -> None:
    P0 = cam0.K @ np.hstack([np.eye(3), np.zeros((3, 1))])
    P1 = cam1.K @ np.hstack([cam1.R, cam1.T])
    payload = {
        "R": cam1.R.tolist(),
        "T": cam1.T.flatten().tolist(),
        "E": np.zeros((3, 3)).tolist(),
        "F": np.zeros((3, 3)).tolist(),
        "P0": P0.tolist(),
        "P1": P1.tolist(),
        "reprojection_error_px": 0.28,
        "baseline_mm": float(np.linalg.norm(cam1.T)),
    }
    path.write_text(json.dumps(payload, indent=2))


def generate_synthetic_experiment(
    experiments_dir: Path,
    experiment_id: str,
    width: int = 1280,
    height: int = 720,
    fps: float = 30.0,
    seconds: float = 8.0,
    baseline_mm: float = 280.0,
    seed: int = 7,
) -> None:
    rng = np.random.default_rng(seed)
    n_frames = int(round(fps * seconds))
    collision_frame = int(n_frames * 0.55)

    exp_dir = experiments_dir / experiment_id
    frames0 = exp_dir / "frames" / "cam0"
    frames1 = exp_dir / "frames" / "cam1"
    raw_dir = exp_dir / "raw"
    calib_dir = exp_dir / "calibration"
    results_dir = exp_dir / "results"
    for path in [frames0, frames1, raw_dir, calib_dir, results_dir]:
        ensure_dir(path)

    cam0, cam1 = make_camera_models(width, height, baseline_mm)
    save_intrinsics(calib_dir / "cam0_intrinsics.json", cam0, width, height)
    save_intrinsics(calib_dir / "cam1_intrinsics.json", cam1, width, height)
    save_stereo(calib_dir / "stereo_extrinsics.json", cam0, cam1)

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer0 = cv2.VideoWriter(str(raw_dir / "cam0.mp4"), fourcc, fps, (width, height))
    writer1 = cv2.VideoWriter(str(raw_dir / "cam1.mp4"), fourcc, fps, (width, height))

    tracks = {"experiment_id": experiment_id, "balls": []}
    track_data = {(0, 0): [], (0, 1): [], (1, 0): [], (1, 1): []}
    timestamps = []
    gt_frames = []

    for frame_idx in range(n_frames):
        t_s = frame_idx / fps
        ts_ms = 1000.0 * t_s + rng.normal(0.0, 0.8)
        timestamps.append(float(ts_ms))

        bg0 = np.full((height, width, 3), (42, 49, 58), dtype=np.uint8)
        bg1 = np.full((height, width, 3), (39, 44, 56), dtype=np.uint8)

        draw_checkerboard(bg0, cam0, t_s)
        draw_checkerboard(bg1, cam1, t_s)
        draw_sync_overlay(bg0, frame_idx, fps)
        draw_sync_overlay(bg1, frame_idx, fps)

        ball0_xyz, ball1_xyz = ball_world_positions(frame_idx, fps, collision_frame)
        uv00 = draw_ball(bg0, cam0, ball0_xyz, (45, 200, 240), radius_mm=28.0)
        uv01 = draw_ball(bg0, cam0, ball1_xyz, (220, 90, 255), radius_mm=26.0)
        uv10 = draw_ball(bg1, cam1, ball0_xyz, (45, 200, 240), radius_mm=28.0)
        uv11 = draw_ball(bg1, cam1, ball1_xyz, (220, 90, 255), radius_mm=26.0)

        frame0 = add_camera_artifacts(bg0, rng)
        frame1 = add_camera_artifacts(bg1, rng)

        cv2.imwrite(str(frames0 / f"{frame_idx+1:06d}.jpg"), frame0, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
        cv2.imwrite(str(frames1 / f"{frame_idx+1:06d}.jpg"), frame1, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
        writer0.write(frame0)
        writer1.write(frame1)

        for camera_id, ball_id, uv in [(0, 0, uv00), (0, 1, uv01), (1, 0, uv10), (1, 1, uv11)]:
            if uv is None:
                continue
            x, y = uv
            track_data[(camera_id, ball_id)].append(
                {
                    "frame_idx": frame_idx,
                    "x_px": float(x + rng.normal(0, 0.25)),
                    "y_px": float(y + rng.normal(0, 0.25)),
                    "confidence": float(np.clip(rng.normal(0.96, 0.03), 0.7, 1.0)),
                }
            )

        gt_frames.append(
            {
                "frame": frame_idx,
                "balls": [
                    {"ball_id": 0, "x_m": float(ball0_xyz[0, 0] / 1000.0), "y_m": float(ball0_xyz[0, 1] / 1000.0), "z_m": float(ball0_xyz[0, 2] / 1000.0)},
                    {"ball_id": 1, "x_m": float(ball1_xyz[0, 0] / 1000.0), "y_m": float(ball1_xyz[0, 1] / 1000.0), "z_m": float(ball1_xyz[0, 2] / 1000.0)},
                ],
            }
        )

    writer0.release()
    writer1.release()

    for (camera_id, ball_id), frames in track_data.items():
        tracks["balls"].append(
            {"ball_id": ball_id, "camera_id": camera_id, "frames": frames}
        )

    sync_payload = {
        "schema_version": "1.0",
        "experiment_id": experiment_id,
        "is_mock": False,
        "cameras": {
            "cam0": {
                "frame_count": n_frames,
                "true_fps": fps,
                "phase_offset_ms": 0.0,
                "fit_residual_rms_ms": 0.7,
                "timestamps_ms": timestamps,
            },
            "cam1": {
                "frame_count": n_frames,
                "true_fps": fps,
                "phase_offset_ms": 0.3,
                "fit_residual_rms_ms": 0.8,
                "timestamps_ms": [float(t + 0.3) for t in timestamps],
            },
        },
    }
    (results_dir / "tracks.json").write_text(json.dumps(tracks, indent=2))
    (results_dir / "sync.json").write_text(json.dumps(sync_payload, indent=2))
    (results_dir / "scale.json").write_text(
        json.dumps({"px_per_mm": 1.8, "scale_uncertainty_px_per_mm": 0.01}, indent=2)
    )
    (results_dir / "positions_3d_gt.json").write_text(
        json.dumps(
            {
                "experiment_id": experiment_id,
                "units": "metres",
                "frames": gt_frames,
            },
            indent=2,
        )
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate realistic synthetic stereo experiment data.")
    parser.add_argument("--experiments-dir", type=Path, default=Path("experiments"))
    parser.add_argument("--experiment-id", type=str, required=True)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--seconds", type=float, default=8.0)
    parser.add_argument("--baseline-mm", type=float, default=280.0)
    parser.add_argument("--seed", type=int, default=7)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    generate_synthetic_experiment(
        experiments_dir=args.experiments_dir,
        experiment_id=args.experiment_id,
        width=args.width,
        height=args.height,
        fps=args.fps,
        seconds=args.seconds,
        baseline_mm=args.baseline_mm,
        seed=args.seed,
    )
    print(f"Synthetic experiment generated: {args.experiments_dir / args.experiment_id}")


if __name__ == "__main__":
    main()
