from __future__ import annotations

import dataclasses
import json
import math
from pathlib import Path
from typing import Iterable, Optional

import cv2
import numpy as np


TAU = math.tau


@dataclasses.dataclass(frozen=True)
class SyncMarkerSpec:
    gray_bits: int = 10
    grating_cycles: int = 4
    phase_step_rad: float = TAU / 32
    roi_width_px: int = 400
    roi_height_px: int = 200


@dataclasses.dataclass(frozen=True)
class CameraSyncResult:
    camera_id: int
    frame_count: int
    timestamps_ms: list[float]
    true_fps: float
    phase_offset_ms: float
    fit_residual_rms_phi: float
    decoded_points: int


def _sorted_frame_files(frames_dir: Path) -> list[Path]:
    if not frames_dir.exists():
        return []
    candidates = list(frames_dir.glob("*.jpg")) + list(frames_dir.glob("*.jpeg")) + list(frames_dir.glob("*.png"))
    return sorted(candidates, key=lambda p: p.name)


def _gray_decode(gray: int) -> int:
    n = int(gray) & 0xFFFFFFFF
    n ^= n >> 16
    n ^= n >> 8
    n ^= n >> 4
    n ^= n >> 2
    n ^= n >> 1
    return n & 0xFFFFFFFF


def _find_marker_quad(frame_bgr: np.ndarray) -> Optional[np.ndarray]:
    """
    Best-effort detection of the marker border as a 4-point polygon.
    Returns points as float32 shape (4,2) in (x,y) order, or None.
    """
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blur, 60, 180)

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    best = None
    best_area = 0.0
    h, w = gray.shape[:2]
    frame_area = float(h * w)

    for contour in contours:
        area = float(cv2.contourArea(contour))
        if area < 0.02 * frame_area:
            continue
        peri = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
        if len(approx) != 4:
            continue
        if not cv2.isContourConvex(approx):
            continue
        if area > best_area:
            best_area = area
            best = approx.reshape(4, 2)

    if best is None:
        return None

    return best.astype(np.float32)


def _order_quad_points(pts: np.ndarray) -> np.ndarray:
    # Order points: top-left, top-right, bottom-right, bottom-left.
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1).reshape(-1)
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(diff)]
    bl = pts[np.argmax(diff)]
    return np.array([tl, tr, br, bl], dtype=np.float32)


def _build_warp(frame_bgr: np.ndarray, spec: SyncMarkerSpec) -> tuple[np.ndarray, tuple[int, int]]:
    quad = _find_marker_quad(frame_bgr)
    if quad is None:
        # Fallback: no perspective correction; treat the whole frame as ROI.
        h, w = frame_bgr.shape[:2]
        return np.eye(3, dtype=np.float32), (w, h)

    src = _order_quad_points(quad)
    dst_w = int(spec.roi_width_px)
    dst_h = int(spec.roi_height_px)
    dst = np.array([[0, 0], [dst_w - 1, 0], [dst_w - 1, dst_h - 1], [0, dst_h - 1]], dtype=np.float32)
    H = cv2.getPerspectiveTransform(src, dst)
    return H, (dst_w, dst_h)


def _decode_gray_bits(roi_gray: np.ndarray, gray_bits: int) -> Optional[int]:
    h, w = roi_gray.shape[:2]
    if gray_bits <= 0 or w < gray_bits:
        return None

    # Use proportions matching the renderer: Gray strip sits at the top of the marker.
    inner_y0 = int(0.05 * h)
    inner_y1 = int(0.05 * h + 0.30 * h)
    y0 = max(0, inner_y0)
    y1 = min(h, max(y0 + 1, inner_y1))

    x0 = int(0.05 * w)
    x1 = int(0.95 * w)
    if x1 <= x0 + gray_bits:
        return None

    strip = roi_gray[y0:y1, x0:x1]
    cell_w = strip.shape[1] / gray_bits

    bits = []
    for i in range(gray_bits):
        cx0 = int(i * cell_w + 0.20 * cell_w)
        cx1 = int((i + 1) * cell_w - 0.20 * cell_w)
        if cx1 <= cx0:
            cx0 = int(i * cell_w)
            cx1 = int((i + 1) * cell_w)
        cell = strip[:, cx0:cx1]
        if cell.size == 0:
            return None
        mean = float(cell.mean())
        bits.append(1 if mean > 127 else 0)

    gray = 0
    # Leftmost bit is MSB (matches frontend renderer).
    for bit in bits:
        gray = (gray << 1) | bit
    return _gray_decode(gray)


def _decode_grating_phase(roi_gray: np.ndarray, grating_cycles: int) -> Optional[float]:
    h, w = roi_gray.shape[:2]
    if w < 8 or h < 8:
        return None
    cycles = int(grating_cycles)
    if cycles <= 0 or cycles >= w // 4:
        return None

    # Crop lower region where the grating is rendered.
    y0 = int(0.40 * h)
    y1 = int(0.95 * h)
    x0 = int(0.05 * w)
    x1 = int(0.95 * w)
    crop = roi_gray[y0:y1, x0:x1]
    if crop.size == 0:
        return None

    signal = crop.mean(axis=0).astype(np.float64)
    signal -= float(signal.mean())
    fft = np.fft.rfft(signal)
    if cycles >= len(fft):
        return None

    coef = fft[cycles]
    mag = float(np.abs(coef))
    if not np.isfinite(mag) or mag < 1e3:
        return None

    phi = float(np.angle(coef))
    if phi < 0:
        phi += TAU
    return phi


def _fit_line(xs: np.ndarray, ys: np.ndarray) -> tuple[float, float, float]:
    """
    Fit y = m*x + c. Returns (m, c, rms_residual).
    """
    m, c = np.polyfit(xs, ys, 1)
    pred = m * xs + c
    residual = ys - pred
    rms = float(np.sqrt(np.mean(residual * residual))) if residual.size else 0.0
    return float(m), float(c), rms


def decode_camera_sync(
    *,
    experiment_dir: Path,
    camera_id: int,
    spec: SyncMarkerSpec,
    display_hz: float = 60.0,
    sample_stride: int = 5,
) -> Optional[tuple[CameraSyncResult, tuple[float, float]]]:
    frames_dir = experiment_dir / "frames" / f"cam{camera_id}"
    frame_files = _sorted_frame_files(frames_dir)
    if not frame_files:
        return None

    frame0 = cv2.imread(str(frame_files[0]), cv2.IMREAD_COLOR)
    if frame0 is None:
        return None

    H, (roi_w, roi_h) = _build_warp(frame0, spec)

    stride = max(1, int(sample_stride))
    sampled_indices = list(range(0, len(frame_files), stride))
    xs: list[int] = []
    phis: list[float] = []

    for idx in sampled_indices:
        frame = cv2.imread(str(frame_files[idx]), cv2.IMREAD_COLOR)
        if frame is None:
            continue
        roi = cv2.warpPerspective(frame, H, (roi_w, roi_h), flags=cv2.INTER_LINEAR)
        roi_gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

        n = _decode_gray_bits(roi_gray, int(spec.gray_bits))
        phi = _decode_grating_phase(roi_gray, int(spec.grating_cycles))
        if n is None or phi is None:
            continue
        # Unwrapped phase proxy: combine macro-time N and micro-time phase.
        Phi = TAU * float(n) + float(phi)
        if not np.isfinite(Phi):
            continue
        xs.append(idx)
        phis.append(Phi)

    if len(xs) < 8:
        return None

    x_arr = np.array(xs, dtype=np.float64)
    phi_arr = np.array(phis, dtype=np.float64)
    m, c, rms = _fit_line(x_arr, phi_arr)

    phase_step = float(spec.phase_step_rad)
    delta_phi_per_display_frame = TAU + phase_step
    display_hz = float(display_hz)
    if not np.isfinite(display_hz) or display_hz <= 1.0:
        display_hz = 60.0

    dphi_dt = delta_phi_per_display_frame * display_hz
    true_fps = dphi_dt / m if m != 0 else 30.0

    # Output timestamps for every extracted camera frame.
    indices = np.arange(len(frame_files), dtype=np.float64)
    phi_fit = m * indices + c
    timestamps_s = phi_fit / dphi_dt
    timestamps_ms = (timestamps_s * 1000.0).astype(np.float64).tolist()

    result = CameraSyncResult(
        camera_id=int(camera_id),
        frame_count=int(len(frame_files)),
        timestamps_ms=[float(v) for v in timestamps_ms],
        true_fps=float(true_fps),
        phase_offset_ms=0.0,  # filled once reference camera is known
        fit_residual_rms_phi=float(rms),
        decoded_points=int(len(xs)),
    )
    return result, (m, c)


def write_sync_json(
    *,
    experiment_dir: Path,
    camera_results: Iterable[CameraSyncResult],
    reference_camera: str,
    spec: SyncMarkerSpec,
    output_path: Path,
    sync_accuracy_ms: float = 0.0,
) -> None:
    cameras: dict[str, dict] = {}
    for res in camera_results:
        cameras[f"cam{res.camera_id}"] = {
            "frame_count": res.frame_count,
            "true_fps": res.true_fps,
            "phase_offset_ms": res.phase_offset_ms,
            "fit_residual_rms_phi": res.fit_residual_rms_phi,
            "decoded_points": res.decoded_points,
            "timestamps_ms": res.timestamps_ms,
        }

    payload = {
        "schema_version": "1.0",
        "experiment_id": experiment_dir.name,
        "reference_camera": reference_camera,
        "sync_accuracy_ms": float(sync_accuracy_ms),
        "sync_marker": dataclasses.asdict(spec),
        "cameras": cameras,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = output_path.with_suffix(output_path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(output_path)


def generate_sync_for_experiment(
    *,
    experiment_dir: Path,
    camera_ids: list[int],
    spec: SyncMarkerSpec = SyncMarkerSpec(),
    display_hz: float = 60.0,
    sample_stride: int = 5,
) -> list[CameraSyncResult]:
    decoded: list[tuple[CameraSyncResult, tuple[float, float]]] = []
    for camera_id in camera_ids:
        out = decode_camera_sync(
            experiment_dir=experiment_dir,
            camera_id=camera_id,
            spec=spec,
            display_hz=display_hz,
            sample_stride=sample_stride,
        )
        if out is None:
            continue
        decoded.append(out)

    if not decoded:
        return []

    # Reference to cam0 if present, else the first available camera.
    ref_idx = next((i for i, (res, _) in enumerate(decoded) if res.camera_id == 0), 0)
    _, (m0, c0) = decoded[ref_idx]

    phase_step = float(spec.phase_step_rad)
    delta_phi_per_display_frame = TAU + phase_step
    dphi_dt = delta_phi_per_display_frame * float(display_hz)

    results: list[CameraSyncResult] = []
    for res, (m, c) in decoded:
        offset_s = (c - c0) / dphi_dt
        offset_ms = float(offset_s * 1000.0)
        # Shift timeline so reference camera frame 0 == 0ms.
        shifted = [float(v - (c0 / dphi_dt) * 1000.0) for v in res.timestamps_ms]
        results.append(
            dataclasses.replace(
                res,
                phase_offset_ms=offset_ms,
                timestamps_ms=shifted,
            )
        )

    results.sort(key=lambda r: r.camera_id)
    return results

