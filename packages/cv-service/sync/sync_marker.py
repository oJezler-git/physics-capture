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
    fit_residual_rms_ms: float
    decoded_points: int
    grating_bin: int


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


def _find_candidate_quads(frame_bgr: np.ndarray) -> list[np.ndarray]:
    """
    Best-effort detection of rectangular-ish candidates as 4-point polygons.
    Returns a list of points arrays, each float32 shape (4,2).
    """
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    # Try to isolate the bright border without relying on absolute brightness.
    _, thresh = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8), iterations=1)

    edges = cv2.Canny(blur, 60, 180)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)
    combined = cv2.bitwise_or(thresh, edges)

    # Use RETR_LIST so we can detect rectangles inside the frame (the marker is on-screen).
    contours, _ = cv2.findContours(combined, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return []

    h, w = gray.shape[:2]
    frame_area = float(h * w)
    candidates: list[tuple[float, np.ndarray]] = []

    for contour in contours:
        area = float(cv2.contourArea(contour))
        # Allow small markers; scoring will decide which candidate is best.
        if area < 0.0015 * frame_area:
            continue
        peri = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
        if len(approx) != 4:
            continue
        if not cv2.isContourConvex(approx):
            continue

        candidates.append((area, approx.reshape(4, 2).astype(np.float32)))

    candidates.sort(key=lambda t: t[0], reverse=True)
    return [quad for _, quad in candidates[:15]]


def _order_quad_points(pts: np.ndarray) -> np.ndarray:
    # Order points: top-left, top-right, bottom-right, bottom-left.
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1).reshape(-1)
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(diff)]
    bl = pts[np.argmax(diff)]
    return np.array([tl, tr, br, bl], dtype=np.float32)


def _build_warp(frame_bgr: np.ndarray, spec: SyncMarkerSpec) -> Optional[tuple[np.ndarray, tuple[int, int]]]:
    candidates = _find_candidate_quads(frame_bgr)
    if not candidates:
        return None

    dst_w = int(spec.roi_width_px)
    dst_h = int(spec.roi_height_px)
    dst = np.array([[0, 0], [dst_w - 1, 0], [dst_w - 1, dst_h - 1], [0, dst_h - 1]], dtype=np.float32)

    expected_ar = float(dst_w) / float(dst_h) if dst_h else 2.0

    # Pick the first candidate that looks like our marker after a quick decode attempt.
    for quad in candidates:
        src = _order_quad_points(quad)
        H = cv2.getPerspectiveTransform(src, dst)
        roi = cv2.warpPerspective(frame_bgr, H, (dst_w, dst_h), flags=cv2.INTER_LINEAR)
        roi_gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

        # Aspect ratio sanity via the candidate's bounding rect.
        x, y, w, h = cv2.boundingRect(quad.astype(np.int32))
        ar = float(w) / float(h) if h else 0.0
        if ar <= 0 or abs(math.log(ar / expected_ar)) > math.log(2.5):
            continue

        if _decode_gray_bits(roi_gray, int(spec.gray_bits)) is None:
            continue
        if _decode_grating_phase(roi_gray, int(spec.grating_cycles)) is None:
            continue
        return H, (dst_w, dst_h)

    return None


def _decode_gray_bits(roi_gray: np.ndarray, gray_bits: int) -> Optional[int]:
    h, w = roi_gray.shape[:2]
    if gray_bits <= 0 or w < gray_bits:
        return None

    # Use stable proportions matching the renderer: the Gray strip sits at the top of the marker.
    # (We already rectify to a fixed ROI size, so this is more reliable than edge-based heuristics.)
    y0 = int(0.05 * h)
    y1 = int(0.35 * h)
    if y1 <= y0 + 8:
        return None

    x0 = int(0.08 * w)
    x1 = int(0.92 * w)
    if x1 <= x0 + gray_bits:
        return None

    strip = roi_gray[y0:y1, x0:x1]
    cell_w = strip.shape[1] / gray_bits

    # Adaptive threshold per-frame for robustness to exposure/white balance.
    _, strip_bin = cv2.threshold(strip, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    bits = []
    for i in range(gray_bits):
        cx0 = int(i * cell_w + 0.20 * cell_w)
        cx1 = int((i + 1) * cell_w - 0.20 * cell_w)
        if cx1 <= cx0:
            cx0 = int(i * cell_w)
            cx1 = int((i + 1) * cell_w)
        cell = strip_bin[:, cx0:cx1]
        if cell.size == 0:
            return None
        # Majority vote for the cell.
        white_frac = float((cell > 0).mean())
        bits.append(1 if white_frac >= 0.5 else 0)

    gray = 0
    # Leftmost bit is MSB (matches frontend renderer).
    for bit in bits:
        gray = (gray << 1) | bit
    return _gray_decode(gray)


def _read_gray_observation(
    roi_gray: np.ndarray,
    gray_bits: int,
) -> Optional[tuple[list[int], list[float], int]]:
    """
    Returns (observed_bits_msb_first, per_bit_confidence, decoded_counter_mod).
    Confidence is proportional to distance from the adaptive threshold.
    """
    h, w = roi_gray.shape[:2]
    if gray_bits <= 0 or w < gray_bits:
        return None

    y0 = int(0.05 * h)
    y1 = int(0.35 * h)
    if y1 <= y0 + 8:
        return None

    x0 = int(0.08 * w)
    x1 = int(0.92 * w)
    if x1 <= x0 + gray_bits:
        return None

    strip = roi_gray[y0:y1, x0:x1]
    if strip.size == 0:
        return None

    # Threshold for bit decisions.
    thr, _ = cv2.threshold(strip, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    cell_w = strip.shape[1] / gray_bits

    bits: list[int] = []
    conf: list[float] = []
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
        bits.append(1 if mean > thr else 0)
        conf.append(abs(mean - float(thr)))

    gray = 0
    for bit in bits:
        gray = (gray << 1) | bit
    decoded = _gray_decode(gray) & 0xFFFFFFFF
    return bits, conf, int(decoded)


def _gray_encode_bits(value: int, bits: int) -> list[int]:
    safe_bits = max(1, min(30, int(bits)))
    mask = (1 << safe_bits) - 1
    n = int(value) & mask
    gray = (n ^ (n >> 1)) & mask
    out: list[int] = []
    for i in range(safe_bits - 1, -1, -1):
        out.append((gray >> i) & 1)
    return out


def _decode_grating_phase(roi_gray: np.ndarray, grating_cycles: int) -> Optional[tuple[float, int]]:
    h, w = roi_gray.shape[:2]
    if w < 8 or h < 8:
        return None
    cycles = int(grating_cycles)
    if cycles <= 0:
        cycles = 1

    # Crop lower region where the grating is rendered.
    y0 = int(0.40 * h)
    y1 = int(0.95 * h)
    x0 = int(0.08 * w)
    x1 = int(0.92 * w)
    crop = roi_gray[y0:y1, x0:x1]
    if crop.size == 0:
        return None

    signal = crop.mean(axis=0).astype(np.float64)
    signal -= float(signal.mean())

    # Detrend (remove lighting gradients) and window to reduce leakage.
    x = np.linspace(-1.0, 1.0, num=signal.shape[0], dtype=np.float64)
    a, b = np.polyfit(x, signal, 1)
    signal = signal - (a * x + b)
    signal = signal * np.hanning(signal.shape[0]).astype(np.float64)

    n = int(signal.shape[0])
    if n < 16:
        return None

    # Project onto the expected sinusoid at exactly `cycles` periods across the sampled width.
    omega = (TAU * float(cycles)) / float(n)
    xs = np.arange(n, dtype=np.float64)
    ref_sin = np.sin(omega * xs)
    ref_cos = np.cos(omega * xs)

    a_sin = float(np.dot(signal, ref_sin))
    b_cos = float(np.dot(signal, ref_cos))
    mag = math.hypot(a_sin, b_cos)
    if not np.isfinite(mag) or mag < 1e2:
        return None

    # Phase for signal ~ sin(ωx + φ): a_sin ∝ cosφ, b_cos ∝ sinφ.
    phi = float(math.atan2(b_cos, a_sin))
    if phi < 0:
        phi += TAU
    return phi, int(cycles)


def _fit_line(xs: np.ndarray, ys: np.ndarray) -> tuple[float, float, float]:
    """
    Fit y = m*x + c. Returns (m, c, rms_residual).
    """
    m, c = np.polyfit(xs, ys, 1)
    pred = m * xs + c
    residual = ys - pred
    rms = float(np.sqrt(np.mean(residual * residual))) if residual.size else 0.0
    return float(m), float(c), rms


def _unwrap_mod_counter(values: list[int], modulus: int) -> list[int]:
    """
    Turn a modulo counter (0..modulus-1) into an unwrapped integer sequence.
    Greedy unwrap using the most plausible step size.
    """
    if not values:
        return []
    mod = int(modulus)
    if mod <= 1:
        return [int(v) for v in values]

    # First pass: compute signed deltas under wrap, then estimate typical step via median.
    signed_deltas: list[int] = []
    for i in range(1, len(values)):
        d = (int(values[i]) - int(values[i - 1])) % mod
        if d > mod // 2:
            d -= mod
        signed_deltas.append(int(d))
    typical = int(np.median(signed_deltas)) if signed_deltas else 0

    unwrapped = [int(values[0])]
    prev = int(values[0])
    for i in range(1, len(values)):
        v = int(values[i])
        # Choose wrap adjustment that makes the step closest to the typical step.
        candidates = []
        for k in (-1, 0, 1, 2):
            vv = v + k * mod
            delta = vv - prev
            candidates.append((abs(delta - typical), abs(delta), vv))
        _, _, chosen = min(candidates, key=lambda t: (t[0], t[1]))
        unwrapped.append(int(chosen))
        prev = int(chosen)
    return unwrapped


def _filter_and_unwrap_counter(
    indices: list[int],
    values_mod: list[int],
    modulus: int,
    *,
    fallback_step: int,
) -> tuple[list[int], list[int]]:
    """
    Filter obvious Gray decode glitches by enforcing approximately-constant forward increments,
    then unwrap into a monotonically increasing integer counter.
    """
    if len(indices) != len(values_mod) or not indices:
        return [], []

    mod = int(modulus)
    if mod <= 1:
        return indices[:], [int(v) for v in values_mod]

    forward_deltas: list[int] = []
    for i in range(1, len(values_mod)):
        d = (int(values_mod[i]) - int(values_mod[i - 1])) % mod
        if 0 < d <= mod // 2:
            forward_deltas.append(int(d))

    typical = int(np.median(forward_deltas)) if forward_deltas else int(fallback_step)
    typical = max(1, typical)
    tol = max(8, int(0.8 * typical))

    # Find the longest contiguous run with plausible forward deltas.
    def is_good_delta(prev_val: int, cur_val: int) -> bool:
        d0 = (cur_val - prev_val) % mod
        if d0 == 0 or d0 > mod // 2:
            return False
        return abs(int(d0) - typical) <= tol

    best_start = 0
    best_len = 1
    run_start = 0
    run_len = 1
    for i in range(1, len(values_mod)):
        if is_good_delta(int(values_mod[i - 1]), int(values_mod[i])):
            run_len += 1
        else:
            if run_len > best_len:
                best_start = run_start
                best_len = run_len
            run_start = i
            run_len = 1
    if run_len > best_len:
        best_start = run_start
        best_len = run_len

    if best_len < 8:
        return [], []

    kept_idx = [int(v) for v in indices[best_start : best_start + best_len]]
    kept_mod = [int(v) for v in values_mod[best_start : best_start + best_len]]

    # Unwrap by accumulating forward deltas.
    unwrapped = [kept_mod[0]]
    for i in range(1, len(kept_mod)):
        d = (kept_mod[i] - kept_mod[i - 1]) % mod
        unwrapped.append(int(unwrapped[-1] + d))

    return kept_idx, unwrapped


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

    # Find a warp transform from the first few frames. If we can't locate the marker border,
    # it's safer to fail than to decode arbitrary pixels.
    H = None
    roi_w = roi_h = None
    for probe in frame_files[: min(10, len(frame_files))]:
        frame0 = cv2.imread(str(probe), cv2.IMREAD_COLOR)
        if frame0 is None:
            continue
        built = _build_warp(frame0, spec)
        if built is None:
            continue
        H, (roi_w, roi_h) = built
        break
    if H is None or roi_w is None or roi_h is None:
        return None

    stride = max(1, int(sample_stride))
    sampled_indices = list(range(0, len(frame_files), stride))
    xs: list[int] = []
    n_mods: list[int] = []
    phis: list[float] = []
    bins: list[int] = []
    obs_bits: list[list[int]] = []
    obs_conf: list[list[float]] = []

    for idx in sampled_indices:
        frame = cv2.imread(str(frame_files[idx]), cv2.IMREAD_COLOR)
        if frame is None:
            continue
        roi = cv2.warpPerspective(frame, H, (roi_w, roi_h), flags=cv2.INTER_LINEAR)
        roi_gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

        obs = _read_gray_observation(roi_gray, int(spec.gray_bits))
        n = obs[2] if obs is not None else None
        gr = _decode_grating_phase(roi_gray, int(spec.grating_cycles))
        if n is None or gr is None or obs is None:
            continue
        phi, k_best = gr
        # Unwrapped phase proxy: combine macro-time N and micro-time phase.
        if not np.isfinite(phi):
            continue
        xs.append(idx)
        n_mods.append(int(n))
        phis.append(float(phi))
        bins.append(int(k_best))
        obs_bits.append(obs[0])
        obs_conf.append(obs[1])

    if len(xs) < 8:
        return None

    mod = 1 << int(max(1, min(30, int(spec.gray_bits))))
    # Estimate typical forward increment in display frames between sampled camera frames.
    forward_deltas: list[int] = []
    for i in range(1, len(n_mods)):
        d = (n_mods[i] - n_mods[i - 1]) % mod
        if 0 < d <= mod // 2:
            forward_deltas.append(int(d))
    typical = int(np.median(forward_deltas)) if forward_deltas else int(round(float(display_hz) * float(stride) / 30.0))
    typical = max(1, typical)

    # Correct occasional Gray bit glitches by combining (a) bit agreement and (b) step consistency.
    corrected_mod: list[int] = []
    typical_step = int(typical)
    for _ in range(3):
        corrected_mod = [int(n_mods[0])]
        window = max(25, int(4.0 * typical_step))
        for i in range(1, len(n_mods)):
            prev = corrected_mod[-1]
            pred = (prev + typical_step) % mod
            obs_b = obs_bits[i]
            weights = obs_conf[i]
            sumw = float(sum(weights)) + 1e-6

            best_cost = float("inf")
            best = int(pred)
            for delta in range(-window, window + 1):
                cand = (pred + delta) % mod
                forward = (cand - prev) % mod
                if forward == 0 or forward > mod // 2:
                    continue

                cand_bits = _gray_encode_bits(cand, int(spec.gray_bits))
                mismatch = 0.0
                for b_obs, b_cand, w in zip(obs_b, cand_bits, weights):
                    if b_obs != b_cand:
                        mismatch += float(w)

                mismatch_norm = mismatch / sumw
                step_norm = abs(float(forward) - float(typical_step)) / max(1.0, float(typical_step))
                cost = mismatch_norm + 0.65 * step_norm
                if cost < best_cost:
                    best_cost = cost
                    best = int(cand)

            corrected_mod.append(best)

        deltas = [(corrected_mod[i] - corrected_mod[i - 1]) % mod for i in range(1, len(corrected_mod))]
        deltas = [int(d) for d in deltas if 0 < d <= mod // 2]
        if not deltas:
            break
        typical_step = max(1, int(np.median(deltas)))

    # Unwrap corrected modulo counter into an increasing display-frame counter.
    n_unwrapped: list[int] = [corrected_mod[0]]
    for i in range(1, len(corrected_mod)):
        d = (corrected_mod[i] - corrected_mod[i - 1]) % mod
        n_unwrapped.append(int(n_unwrapped[-1] + d))

    x_arr = np.array(xs, dtype=np.float64)
    Phi_unwrapped = np.array([TAU * float(nu) + float(phi) for nu, phi in zip(n_unwrapped, phis)], dtype=np.float64)

    m, c, rms_phi = _fit_line(x_arr, Phi_unwrapped)

    # Simple outlier rejection + refit (robust-ish).
    pred = m * x_arr + c
    residual = Phi_unwrapped - pred
    mad = float(np.median(np.abs(residual - np.median(residual)))) if residual.size else 0.0
    if mad > 0:
        keep = np.abs(residual) <= (6.0 * mad)
        if int(keep.sum()) >= 8:
            m, c, rms_phi = _fit_line(x_arr[keep], Phi_unwrapped[keep])

    phase_step = float(spec.phase_step_rad)
    delta_phi_per_display_frame = TAU + phase_step
    display_hz = float(display_hz)
    if not np.isfinite(display_hz) or display_hz <= 1.0:
        display_hz = 60.0

    dphi_dt = delta_phi_per_display_frame * display_hz
    true_fps = abs(dphi_dt / m) if m != 0 else 30.0

    rms_ms = abs(float(rms_phi) / dphi_dt) * 1000.0 if dphi_dt != 0 else float("inf")
    if not np.isfinite(true_fps) or true_fps < 5.0 or true_fps > 120.0:
        return None
    # Residual is in milliseconds of timestamp error equivalent. In practice this will depend on
    # video compression, marker ROI size, and exposure. Start permissive and tighten once capture is stable.
    if not np.isfinite(rms_ms) or rms_ms > 25.0:
        return None

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
        fit_residual_rms_phi=float(rms_phi),
        fit_residual_rms_ms=float(rms_ms),
        decoded_points=int(len(xs)),
        grating_bin=int(round(float(np.median(bins)))) if bins else 0,
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
            "fit_residual_rms_ms": res.fit_residual_rms_ms,
            "decoded_points": res.decoded_points,
            "grating_bin": res.grating_bin,
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
