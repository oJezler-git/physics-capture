from __future__ import annotations

import dataclasses
import json
import logging
import math
from pathlib import Path
from typing import Iterable, Optional

import cv2
import numpy as np


logger = logging.getLogger(__name__)

TAU = math.tau

# --- TYPE ALIASES ---

# (H_matrix, (width, height))
WarpResult = tuple[np.ndarray, tuple[int, int]]
# (observed_bits, confidence_scores, decoded_counter)
GrayObservation = tuple[list[int], list[float], int]
# (phase_rad, best_cycles_bin, magnitude)
GratingResult = tuple[float, int, float]
# (phase_rad, best_cycles_bin)
GratingPhase = tuple[float, int]
# (slope_m, intercept_c, rms_residual_rad)
LineFitResult = tuple[float, float, float]
# (total_score, n_mod, magnitude, k_best)
ScoredROI = tuple[float, int, float, int]

# --- THRESHOLDS & HEURISTICS ---

# Minimum signal strength for the sine-wave grating (Magnitude).
# < 80 usually means the image is too blurry/dark for sub-millisecond precision.
MIN_GRATING_MAGNITUDE = 80.0

# Minimum relative contrast for the outer marker border.
# Higher = stricter rejection of low-contrast rectangles (like posters or shadows).
# Relaxed to 0.0 to handle legacy/low-light footage where area-based scoring provides safety.
MIN_BORDER_CONTRAST = 0.0

# Maximum allowed timing jitter (RMS) in milliseconds.
# > 25ms usually means dropped frames or severe motion blur that compromises the sync.
MAX_FIT_RMS_MS = 25.0

# Multiplier for Outlier Rejection (Median Absolute Deviation).
# 6.0 is conservative; it rejects points more than 6 MADs from the linear fit.
OUTLIER_MAD_THRESHOLD = 6.0

# Weight for step-size consistency in Gray code error correction.
# Higher = prioritize "constant forward speed" over individual (potentially glitched) bit reads.
GRAY_STEP_CONSISTENCY_WEIGHT = 0.65

# Minimum frame area percentage for a marker candidate.
# 0.2% helps ignore tiny background artifacts or miniaturized live-preview tiles.
MIN_MARKER_AREA_FRAC = 0.002


def _dbg(enabled: bool, message: str) -> None:
    if enabled:
        print(f"[sync_marker] {message}", flush=True)


def _border_contrast_score(roi_gray: np.ndarray) -> float:
    """
    Heuristic score in [0,1] for "white border around darker interior".
    This helps reject candidates like a live-preview window (a rectangle that may *contain* a
    small sync marker) vs the sync marker itself.
    """
    h, w = roi_gray.shape[:2]
    if h < 8 or w < 8:
        return 0.0
    bw = max(2, int(0.04 * float(min(h, w))))
    bw = min(bw, (min(h, w) // 3))
    if bw <= 0:
        return 0.0

    outer_parts = [
        roi_gray[:bw, :],
        roi_gray[h - bw :, :],
        roi_gray[:, :bw],
        roi_gray[:, w - bw :],
    ]
    inner_parts = [
        roi_gray[bw : 2 * bw, :],
        roi_gray[h - 2 * bw : h - bw, :],
        roi_gray[:, bw : 2 * bw],
        roi_gray[:, w - 2 * bw : w - bw],
    ]
    outer = float(np.mean([float(p.mean()) for p in outer_parts if p.size]))
    inner = float(np.mean([float(p.mean()) for p in inner_parts if p.size]))
    if not np.isfinite(outer) or not np.isfinite(inner):
        return 0.0

    contrast = (outer - inner) / 255.0
    return float(max(0.0, min(1.0, contrast / 0.35)))


def _decode_grating_phase_mag(roi_gray: np.ndarray, grating_cycles: int) -> Optional[GratingResult]:
    h, w = roi_gray.shape[:2]
    if w < 8 or h < 8:
        logger.debug(f"Grating ROI too small: {w}x{h}")
        return None
    cycles = int(grating_cycles)
    if cycles <= 0:
        cycles = 1

    # Crop lower region where the grating is rendered.
    y0 = int(0.45 * h)
    y1 = int(0.92 * h)
    x0 = int(0.10 * w)
    x1 = int(0.90 * w)
    crop = roi_gray[y0:y1, x0:x1]
    if crop.size == 0:
        logger.debug("Grating crop is empty")
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
        logger.debug(f"Grating signal too short: {n}")
        return None

    xs = np.arange(n, dtype=np.float64)

    # Compression / lens blur can slightly shift the effective spatial frequency. Search a small
    # neighborhood around the configured cycles and pick the strongest response.
    cycle_candidates = sorted({k for k in (cycles - 1, cycles, cycles + 1) if 1 <= k <= 12})
    best_mag = float("-inf")
    a_sin = 0.0
    b_cos = 0.0
    k_best = int(cycles)
    for k in cycle_candidates:
        omega = (TAU * float(k)) / float(n)
        ref_sin = np.sin(omega * xs)
        ref_cos = np.cos(omega * xs)
        aa = float(np.dot(signal, ref_sin))
        bb = float(np.dot(signal, ref_cos))
        mag = float(math.hypot(aa, bb))
        if mag > best_mag:
            best_mag = mag
            a_sin = aa
            b_cos = bb
            k_best = int(k)

    if not np.isfinite(best_mag) or best_mag < MIN_GRATING_MAGNITUDE:
        logger.debug(f"Grating magnitude too low: {best_mag:.2f} (min {MIN_GRATING_MAGNITUDE})")
        return None

    phi = float(math.atan2(b_cos, a_sin))
    if phi < 0:
        phi += TAU
    return float(phi), int(k_best), float(best_mag)


def _score_rectified_roi(roi_gray: np.ndarray, spec: SyncMarkerSpec) -> Optional[ScoredROI]:
    """
    Returns (score, decoded_counter_mod, grating_mag, grating_cycles_best) or None.
    """
    obs = _read_gray_observation(roi_gray, int(spec.gray_bits))
    gr = _decode_grating_phase_mag(roi_gray, int(spec.grating_cycles))
    if obs is None or gr is None:
        if obs is None: logger.debug("ROI Score: Gray observation failed")
        if gr is None: logger.debug("ROI Score: Grating decode failed")
        return None
    _, conf, n_mod = obs
    _phi, k_best, mag = gr

    border = _border_contrast_score(roi_gray)
    gray_conf = float(np.mean(np.array(conf, dtype=np.float64))) / 255.0 if conf else 0.0
    mag_per = float(mag) / float(max(1, roi_gray.shape[1]))
    score = 3.0 * border + 1.0 * gray_conf + 0.8 * math.log1p(max(0.0, mag_per))
    return float(score), int(n_mod), float(mag), int(k_best)


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
        # Prefer larger markers to avoid locking onto tiny previews.
        if area < MIN_MARKER_AREA_FRAC * frame_area:
            continue

        peri = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
        
        quad = None
        if len(approx) == 4:
            quad = approx.reshape(4, 2).astype(np.float32)
        else:
            # Fallback for rounded rectangles: use the minAreaRect box points.
            rect = cv2.minAreaRect(contour)
            (rw, rh) = rect[1]
            rect_area = rw * rh
            if not np.isfinite(rect_area) or rect_area <= 1.0:
                continue
            rectangularity = area / rect_area
            if 0.70 < rectangularity < 1.15:
                quad = cv2.boxPoints(rect).astype(np.float32)
        
        if quad is None:
            continue
            
        if not cv2.isContourConvex(quad.astype(np.int32)):
            continue

        candidates.append((float(area), quad))

    candidates.sort(key=lambda t: t[0], reverse=True)
    # Scenes often contain many rectangles (screens, windows, posters). Keep more candidates and
    # let the decoder validate them.
    return [quad for _, quad in candidates[:60]]


def _order_quad_points(pts: np.ndarray) -> np.ndarray:
    # Order points: top-left, top-right, bottom-right, bottom-left.
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1).reshape(-1)
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(diff)]
    bl = pts[np.argmax(diff)]
    return np.array([tl, tr, br, bl], dtype=np.float32)


def _build_warp(frame_bgr: np.ndarray, spec: SyncMarkerSpec) -> Optional[WarpResult]:
    """
    Analyzes a raw camera frame to locate the sync marker border and compute
    the perspective transform (H) required to rectify it into a standard ROI.

    Returns:
        (H, (roi_width, roi_height)) or None if no valid marker is found.
        H is a 3x3 float32 matrix for cv2.warpPerspective.
    """
    candidates = _find_candidate_quads(frame_bgr)
    if not candidates:
        logger.debug("Warp: No candidate quads found in frame")
        return None

    dst_w = int(spec.roi_width_px)
    dst_h = int(spec.roi_height_px)
    dst = np.array([[0, 0], [dst_w - 1, 0], [dst_w - 1, dst_h - 1], [0, dst_h - 1]], dtype=np.float32)

    expected_ar = float(dst_w) / float(dst_h) if dst_h else 2.0

    # Score candidates and pick the best match (prevents locking onto the live preview window).
    best_score = float("-inf")
    best_H: Optional[np.ndarray] = None
    for i, quad in enumerate(candidates):
        src = _order_quad_points(quad)

        # Aspect ratio sanity (use edge lengths; axis-aligned bounding boxes break under rotation).
        w1 = float(np.linalg.norm(src[1] - src[0]))
        w2 = float(np.linalg.norm(src[2] - src[3]))
        h1 = float(np.linalg.norm(src[3] - src[0]))
        h2 = float(np.linalg.norm(src[2] - src[1]))
        w_est = 0.5 * (w1 + w2)
        h_est = 0.5 * (h1 + h2)
        area_abs = w_est * h_est
        frame_area = float(frame_bgr.shape[0] * frame_bgr.shape[1])
        rel_area = area_abs / frame_area

        ar = (w_est / h_est) if h_est > 1e-6 else 0.0
        if ar <= 0 or abs(math.log(ar / expected_ar)) > math.log(3.0):
            continue

        H = cv2.getPerspectiveTransform(src, dst)
        roi = cv2.warpPerspective(frame_bgr, H, (dst_w, dst_h), flags=cv2.INTER_LINEAR)
        roi_gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

        scored = _score_rectified_roi(roi_gray, spec)
        if scored is None:
            logger.debug(f"Candidate {i}: ROI scoring failed")
            continue
        score, _n_mod, mag, _k = scored
        # Require some border contrast; this tends to reject the live preview rectangle.
        # However, we relax this to 0.0 and rely on final_score and mag to protect against noise.
        if _border_contrast_score(roi_gray) < MIN_BORDER_CONTRAST:
            logger.debug(f"Candidate {i}: Border contrast too low ({_border_contrast_score(roi_gray):.2f})")
            continue
        # Keep the warp gate aligned with the decoder's own signal floor.
        # The extra margin here was rejecting otherwise-valid captures on blurrier/JPEG-compressed footage.
        if not np.isfinite(mag) or float(mag) < MIN_GRATING_MAGNITUDE:
            logger.debug(f"Candidate {i}: Grating magnitude too low ({mag:.1f})")
            continue

        # Adjust score by relative area: we strongly prefer larger markers.
        # A 0.05 (5%) frame area marker gets its score boosted, while tiny 0.005 (0.5%) markers are penalized.
        final_score = float(score) + 4.0 * math.log1p(rel_area * 10.0)

        if final_score > best_score:
            best_score = final_score
            best_H = H

    if best_H is None:
        logger.debug(f"Warp: None of {len(candidates)} candidates passed validation")
        return None
    return best_H, (dst_w, dst_h)

    return None


def _decode_gray_bits(roi_gray: np.ndarray, gray_bits: int) -> Optional[int]:
    h, w = roi_gray.shape[:2]
    if gray_bits <= 0 or w < gray_bits:
        return None

    # Use stable proportions matching the renderer.
    # We want to be inside the white-black-white border system.
    y0 = int(0.08 * h)
    y1 = int(0.38 * h)
    if y1 <= y0 + 8:
        return None

    x0 = int(0.10 * w)
    x1 = int(0.90 * w)
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
) -> Optional[GrayObservation]:
    """
    Returns (observed_bits_msb_first, per_bit_confidence, decoded_counter_mod).
    Confidence is proportional to distance from the adaptive threshold.
    """
    h, w = roi_gray.shape[:2]
    if gray_bits <= 0 or w < gray_bits:
        logger.debug(f"Gray Obs: ROI too small ({w}x{h}) or invalid bits ({gray_bits})")
        return None

    y0 = int(0.05 * h)
    y1 = int(0.35 * h)
    if y1 <= y0 + 8:
        logger.debug("Gray Obs: Vertical crop too small")
        return None

    x0 = int(0.08 * w)
    x1 = int(0.92 * w)
    if x1 <= x0 + gray_bits:
        logger.debug("Gray Obs: Horizontal crop too small")
        return None

    strip = roi_gray[y0:y1, x0:x1]
    if strip.size == 0:
        logger.debug("Gray Obs: Strip is empty")
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
            logger.debug(f"Gray Obs: Cell {i} is empty")
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


def _decode_grating_phase(roi_gray: np.ndarray, grating_cycles: int) -> Optional[GratingPhase]:
    h, w = roi_gray.shape[:2]
    if w < 8 or h < 8:
        logger.debug(f"Grating ROI too small: {w}x{h}")
        return None
    cycles = int(grating_cycles)
    if cycles <= 0:
        cycles = 1

    # Crop lower region where the grating is rendered.
    y0 = int(0.45 * h)
    y1 = int(0.92 * h)
    x0 = int(0.10 * w)
    x1 = int(0.90 * w)
    crop = roi_gray[y0:y1, x0:x1]
    if crop.size == 0:
        logger.debug("Grating crop is empty")
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
        logger.debug(f"Grating signal too short: {n}")
        return None

    xs = np.arange(n, dtype=np.float64)

    # Compression / lens blur can slightly shift the effective spatial frequency. Search a small
    # neighborhood around the configured cycles and pick the strongest response.
    cycle_candidates = sorted({k for k in (cycles - 1, cycles, cycles + 1) if 1 <= k <= 12})
    best_mag = float("-inf")
    a_sin = 0.0
    b_cos = 0.0
    k_best = int(cycles)
    for k in cycle_candidates:
        omega = (TAU * float(k)) / float(n)
        ref_sin = np.sin(omega * xs)
        ref_cos = np.cos(omega * xs)
        a = float(np.dot(signal, ref_sin))
        b = float(np.dot(signal, ref_cos))
        mag = float(math.hypot(a, b))
        if mag > best_mag:
            best_mag = mag
            a_sin = a
            b_cos = b
            k_best = int(k)

    if not np.isfinite(best_mag) or best_mag < MIN_GRATING_MAGNITUDE:
        logger.debug(f"Grating magnitude too low: {best_mag:.2f} (min {MIN_GRATING_MAGNITUDE})")
        return None

    # Phase for signal ~ sin(ωx + φ): a_sin ∝ cosφ, b_cos ∝ sinφ.
    phi = float(math.atan2(b_cos, a_sin))
    if phi < 0:
        phi += TAU
    return phi, int(k_best)


def _fit_line(xs: np.ndarray, ys: np.ndarray) -> LineFitResult:
    """
    Performs a linear regression (y = mx + c) on timing points.

    Returns:
        (m, c, rms_residual)
        m: slope (radians per camera frame)
        c: intercept (phase at frame 0)
        rms_residual: Root Mean Square error of the fit in radians.
    """
    m, c = np.polyfit(xs, ys, 1)
    pred = m * xs + c
    residual = ys - pred
    rms = float(np.sqrt(np.mean(residual * residual))) if residual.size else 0.0
    return float(m), float(c), rms


def _unwrap_mod_counter(values: list[int], modulus: int) -> list[int]:
    """
    Converts a sequence of modulo values (e.g. 1022, 1023, 0, 1) into a 
    monotonically increasing sequence (e.g. 1022, 1023, 1024, 1025).

    Uses a greedy approach based on the median step size to handle wraps
    and potential single-frame glitches.

    Returns:
        A list of unwrapped integer values.
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


def _evaluate_warp_quality(
    *,
    frame_files: list[Path],
    H: np.ndarray,
    roi_size: tuple[int, int],
    spec: SyncMarkerSpec,
    eval_indices: list[int],
) -> tuple[int, float]:
    """
    Returns (ok_count, score_sum) over `eval_indices`.
    """
    roi_w, roi_h = int(roi_size[0]), int(roi_size[1])
    ok = 0
    score_sum = 0.0
    for idx in eval_indices:
        if idx < 0 or idx >= len(frame_files):
            continue
        frame = cv2.imread(str(frame_files[idx]), cv2.IMREAD_COLOR)
        if frame is None:
            continue
        roi = cv2.warpPerspective(frame, H, (roi_w, roi_h), flags=cv2.INTER_LINEAR)
        roi_gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        scored = _score_rectified_roi(roi_gray, spec)
        if scored is None:
            continue
        score, _n_mod, _mag, _k = scored
        ok += 1
        score_sum += float(score)
    return int(ok), float(score_sum)


def _correct_gray_sequence(
    *,
    n_mods: list[int],
    obs_bits: list[list[int]],
    obs_conf: list[list[float]],
    gray_bits: int,
    typical_step: int,
) -> list[int]:
    """
    Corrects occasional Gray bit glitches in a sequence by combining bit-level
    confidence with step-size consistency.

    Uses an iterative relaxation approach:
    1. For each point, find the Gray counter value that minimizes a cost function
       combining (a) bit agreement with raw observation and (b) proximity to the
       predicted value based on the typical step size.
    2. Update the "typical step size" estimate based on the corrected sequence.
    3. Repeat to converge on a globally consistent monotonic sequence.

    Returns:
        A list of corrected modulo counter values.
    """
    mod = 1 << int(max(1, min(30, int(gray_bits))))
    corrected_mod: list[int] = []
    current_typical = int(typical_step)

    for _ in range(3):
        corrected_mod = [int(n_mods[0])]
        window = max(25, int(4.0 * current_typical))
        for i in range(1, len(n_mods)):
            prev = corrected_mod[-1]
            pred = (prev + current_typical) % mod
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

                cand_bits = _gray_encode_bits(cand, int(gray_bits))
                mismatch = 0.0
                for b_obs, b_cand, w in zip(obs_b, cand_bits, weights):
                    if b_obs != b_cand:
                        mismatch += float(w)

                mismatch_norm = mismatch / sumw
                step_norm = abs(float(forward) - float(current_typical)) / max(1.0, float(current_typical))
                cost = mismatch_norm + GRAY_STEP_CONSISTENCY_WEIGHT * step_norm
                if cost < best_cost:
                    best_cost = cost
                    best = int(cand)

            corrected_mod.append(best)

        deltas = [(corrected_mod[i] - corrected_mod[i - 1]) % mod for i in range(1, len(corrected_mod))]
        deltas = [int(d) for d in deltas if 0 < d <= mod // 2]
        if not deltas:
            break
        current_typical = max(1, int(np.median(deltas)))

    return corrected_mod


def _fit_timing_candidate(
    *,
    xs: list[int],
    n_mods: list[int],
    phis: list[float],
    obs_bits: list[list[int]],
    obs_conf: list[list[float]],
    bins: list[int],
    gray_bits: int,
    phase_step_rad: float,
    display_hz: float,
    sample_stride: int,
    use_gray_correction: bool,
) -> Optional[tuple[str, float, float, float, float, float, float]]:
    """
    Returns (strategy, m, c, rms_phi, rms_ms, true_fps, dphi_dt) for a single fit attempt.
    """
    if not xs or not n_mods or not phis:
        return None

    mod = 1 << int(max(1, min(30, int(gray_bits))))
    if use_gray_correction:
        forward_deltas: list[int] = []
        for i in range(1, len(n_mods)):
            d = (n_mods[i] - n_mods[i - 1]) % mod
            if 0 < d <= mod // 2:
                forward_deltas.append(int(d))
        observed_step = int(np.median(forward_deltas)) if forward_deltas else 0
        expected_step = max(1, int(round(float(display_hz) * float(sample_stride) / 30.0)))
        if observed_step <= 0:
            typical_step = expected_step
        elif observed_step < expected_step * 0.67 or observed_step > expected_step * 1.5:
            typical_step = expected_step
        else:
            typical_step = observed_step
        n_values = _correct_gray_sequence(
            n_mods=n_mods,
            obs_bits=obs_bits,
            obs_conf=obs_conf,
            gray_bits=int(gray_bits),
            typical_step=typical_step,
        )
        strategy = "gray-corrected"
    else:
        n_values = _unwrap_mod_counter(n_mods, mod)
        strategy = "simple-unwrap"

    n_unwrapped: list[int] = [int(n_values[0])]
    for i in range(1, len(n_values)):
        d = (int(n_values[i]) - int(n_values[i - 1])) % mod
        n_unwrapped.append(int(n_unwrapped[-1] + d))

    x_arr = np.array(xs, dtype=np.float64)
    phi_unwrapped = np.array(
        [TAU * float(nu) + float(phi) for nu, phi in zip(n_unwrapped, phis)],
        dtype=np.float64,
    )

    fit_x = x_arr
    fit_y = phi_unwrapped
    m = c = rms_phi = 0.0
    for _ in range(3):
        m, c, rms_phi = _fit_line(fit_x, fit_y)
        pred = m * fit_x + c
        residual = fit_y - pred
        mad = float(np.median(np.abs(residual - np.median(residual)))) if residual.size else 0.0
        if mad <= 0:
            break
        keep = np.abs(residual) <= (OUTLIER_MAD_THRESHOLD * mad)
        if int(keep.sum()) < 8 or int(keep.sum()) == len(fit_x):
            break
        fit_x = fit_x[keep]
        fit_y = fit_y[keep]

    phase_step = float(phase_step_rad)
    delta_phi_per_display_frame = TAU + phase_step
    display_hz = float(display_hz)
    if not np.isfinite(display_hz) or display_hz <= 1.0:
        display_hz = 60.0
    dphi_dt = delta_phi_per_display_frame * display_hz
    true_fps = abs(dphi_dt / m) if m != 0 else float("inf")
    rms_ms = abs(float(rms_phi) / dphi_dt) * 1000.0 if dphi_dt != 0 else float("inf")

    return strategy, float(m), float(c), float(rms_phi), float(rms_ms), float(true_fps), float(dphi_dt)


def decode_camera_sync(
    *,
    experiment_dir: Path,
    camera_id: int,
    spec: SyncMarkerSpec,
    display_hz: float = 60.0,
    sample_stride: int = 5,
    debug: bool = False,
) -> Optional[tuple[CameraSyncResult, tuple[float, float]]]:
    frames_dir = experiment_dir / "frames" / f"cam{camera_id}"
    frame_files = _sorted_frame_files(frames_dir)
    if not frame_files:
        _dbg(debug, f"cam{camera_id}: no frames found in {frames_dir}")
        return None

    # Find a warp transform from the first few frames. If we can't locate the marker border,
    # it's safer to fail than to decode arbitrary pixels.
    H = None
    roi_w = roi_h = None
    # Probe across the whole clip (recording may start before the sync marker is visible / stable).
    max_probes = min(80, len(frame_files))
    step = max(1, len(frame_files) // max_probes)
    probe_indices = list(
        dict.fromkeys(
            list(range(0, min(12, len(frame_files))))
            + list(range(0, len(frame_files), step))
            + list(range(max(0, len(frame_files) - 12), len(frame_files)))
        )
    )
    eval_n = min(24, len(frame_files))
    eval_indices = sorted({int(round(v)) for v in np.linspace(0, len(frame_files) - 1, num=eval_n)})

    best_ok = -1
    best_score_sum = float("-inf")
    best: Optional[tuple[np.ndarray, int, int]] = None

    for idx in probe_indices[:max_probes]:
        frame0 = cv2.imread(str(frame_files[idx]), cv2.IMREAD_COLOR)
        if frame0 is None:
            continue
        built = _build_warp(frame0, spec)
        if built is None:
            continue
        Hcand, (rw, rh) = built

        ok_count, score_sum = _evaluate_warp_quality(
            frame_files=frame_files,
            H=Hcand,
            roi_size=(int(rw), int(rh)),
            spec=spec,
            eval_indices=eval_indices,
        )

        if ok_count > best_ok or (ok_count == best_ok and score_sum > best_score_sum):
            best_ok = int(ok_count)
            best_score_sum = float(score_sum)
            best = (Hcand, int(rw), int(rh))

        # Early-exit if this warp decodes almost everywhere.
        if ok_count >= max(10, int(0.8 * len(eval_indices))):
            break

    if best is not None:
        H, roi_w, roi_h = best
    if H is None or roi_w is None or roi_h is None:
        logger.warning(
            f"cam{camera_id}: could not locate marker border (frames={len(frame_files)}, probes={min(max_probes, len(probe_indices))})",
        )
        _dbg(
            debug,
            f"cam{camera_id}: could not locate marker border (frames={len(frame_files)}, probes={min(max_probes, len(probe_indices))})",
        )
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
        logger.warning(
            f"cam{camera_id}: insufficient decoded samples ({len(xs)}/{len(sampled_indices)})",
        )
        _dbg(
            debug,
            f"cam{camera_id}: insufficient decoded samples ({len(xs)}/{len(sampled_indices)})",
        )
        return None

    attempts: list[tuple[str, float, float, float, float, float, float]] = []
    for use_gray_correction in (True, False):
        candidate = _fit_timing_candidate(
            xs=xs,
            n_mods=n_mods,
            phis=phis,
            obs_bits=obs_bits,
            obs_conf=obs_conf,
            bins=bins,
            gray_bits=int(spec.gray_bits),
            phase_step_rad=float(spec.phase_step_rad),
            display_hz=float(display_hz),
            sample_stride=int(stride),
            use_gray_correction=use_gray_correction,
        )
        if candidate is not None:
            attempts.append(candidate)

    if not attempts:
        _dbg(debug, f"cam{camera_id}: rejected fit (no valid timing candidate, points={len(xs)})")
        logger.warning(f"cam{camera_id}: rejected fit (no valid timing candidate, points={len(xs)})")
        return None

    # Prefer the lowest RMS candidate that still looks like a plausible camera FPS.
    valid = [cand for cand in attempts if 5.0 <= cand[5] <= 120.0]
    chosen = min(valid or attempts, key=lambda cand: cand[4])
    strategy, m, c, rms_phi, rms_ms, true_fps, dphi_dt = chosen

    if debug and len(attempts) > 1:
        details = ", ".join(
            f"{name}: fps={fps:.3f} rms_ms={rms_ms:.3f}"
            for name, _m, _c, _rphi, rms_ms, fps, _dphi_dt in attempts
        )
        _dbg(debug, f"cam{camera_id}: fit candidates {details}")

    if not np.isfinite(true_fps) or true_fps < 5.0 or true_fps > 120.0:
        _dbg(debug, f"cam{camera_id}: rejected fit ({strategy}, true_fps={true_fps:.3f})")
        logger.warning(f"cam{camera_id}: rejected fit ({strategy}, unrealistic true_fps={true_fps:.3f})")
        return None
    # Residual is in milliseconds of timestamp error equivalent. In practice this will depend on
    # video compression, marker ROI size, and exposure. Start permissive and tighten once capture is stable.
    if not np.isfinite(rms_ms) or rms_ms > MAX_FIT_RMS_MS:
        _dbg(debug, f"cam{camera_id}: rejected fit ({strategy}, rms_ms={rms_ms:.3f}, points={len(xs)})")
        logger.warning(
            f"cam{camera_id}: rejected fit ({strategy}, rms_ms={rms_ms:.3f} exceeds {MAX_FIT_RMS_MS}, points={len(xs)})",
        )
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
    debug: bool = False,
) -> list[CameraSyncResult]:
    decoded: list[tuple[CameraSyncResult, tuple[float, float]]] = []
    for camera_id in camera_ids:
        out = decode_camera_sync(
            experiment_dir=experiment_dir,
            camera_id=camera_id,
            spec=spec,
            display_hz=display_hz,
            sample_stride=sample_stride,
            debug=debug,
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
