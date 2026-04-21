import math

import numpy as np
import pytest


cv2 = pytest.importorskip("cv2")

from sync.sync_marker import (
    _decode_grating_phase,
    _find_candidate_quads,
    _order_quad_points,
    _gray_decode,
    _unwrap_mod_counter,
    _fit_line,
    _correct_gray_sequence,
)


def test_gray_decode():
    # 3-bit Gray code sequence:
    # Decoded (N): 0, 1, 2, 3, 4, 5, 6, 7
    # Gray (G):    0, 1, 3, 2, 6, 7, 5, 4
    # G (binary): 000, 001, 011, 010, 110, 111, 101, 100
    gray_sequence = [0, 1, 3, 2, 6, 7, 5, 4]
    for n, g in enumerate(gray_sequence):
        assert _gray_decode(g) == n


def test_unwrap_mod_counter():
    # Modulo 1024 counter with wraps
    values = [1022, 1023, 0, 1, 2]
    unwrapped = _unwrap_mod_counter(values, 1024)
    assert unwrapped == [1022, 1023, 1024, 1025, 1026]

    # Test with typical step estimation (greedy)
    # 0 -> 10 -> 20 -> 30 -> 40
    # Obscured by mod 100: 0, 10, 20, 30, 40
    values = [90, 0, 10, 20] # Wrapped sequence
    unwrapped = _unwrap_mod_counter(values, 100)
    assert unwrapped == [90, 100, 110, 120]


def test_fit_line():
    # Perfect linear sequence: y = 2x + 5
    xs = np.array([0, 1, 2, 3, 4], dtype=np.float64)
    ys = 2.0 * xs + 5.0
    m, c, rms = _fit_line(xs, ys)
    assert pytest.approx(m) == 2.0
    assert pytest.approx(c) == 5.0
    assert rms < 1e-10

    # With noise
    ys[2] += 0.5 # Single point deviation
    m, c, rms = _fit_line(xs, ys)
    assert rms > 0.0
    assert m > 1.9 # Should still be close


def test_correct_gray_sequence():
    # Simulates a sequence of Gray code observations with one bit-flip glitch.
    # True N: 10, 12, 14, 16 (typical step = 2)
    # obs_bits and obs_conf are MSB first. We'll use 10 bits.
    
    def to_bits(n):
        # Helper to generate gray bits for n
        from sync.sync_marker import _gray_encode_bits
        return _gray_encode_bits(n, 10)

    n_true = [10, 12, 14, 16]
    n_obs = [10, 12, 999, 16] # 999 is a massive glitch at index 2
    
    obs_bits = [to_bits(n) for n in n_obs]
    # For the glitch, we'll give it very low confidence, but let it stay 999
    obs_conf = [[10.0]*10 for _ in n_obs]
    obs_conf[2] = [0.1]*10 # Glitchy frame is very uncertain
    
    corrected = _correct_gray_sequence(
        n_mods=n_obs,
        obs_bits=obs_bits,
        obs_conf=obs_conf,
        gray_bits=10,
        typical_step=2
    )
    
    # The relaxation loop should have recovered the missing "14" based on the step consistency
    assert corrected == [10, 12, 14, 16]


def _aspect_ratio(quad: np.ndarray) -> float:
    pts = _order_quad_points(quad.astype(np.float32))
    w1 = float(np.linalg.norm(pts[1] - pts[0]))
    w2 = float(np.linalg.norm(pts[2] - pts[3]))
    h1 = float(np.linalg.norm(pts[3] - pts[0]))
    h2 = float(np.linalg.norm(pts[2] - pts[1]))
    w = 0.5 * (w1 + w2)
    h = 0.5 * (h1 + h2)
    return (w / h) if h > 1e-6 else 0.0


def test_find_candidate_quads_handles_rounded_rect_border():
    frame = np.zeros((480, 640, 3), dtype=np.uint8)

    # Draw a "rounded rectangle" border (simulates UI clipping / rounded containers).
    x, y, w, h = 120, 140, 360, 180  # aspect ratio 2.0
    t = 10
    r = 28
    white = (255, 255, 255)

    # Straight segments.
    cv2.rectangle(frame, (x + r, y), (x + w - r, y + h), white, t)
    cv2.rectangle(frame, (x, y + r), (x + w, y + h - r), white, t)
    # Rounded corners.
    cv2.ellipse(frame, (x + r, y + r), (r, r), 180, 0, 90, white, t)
    cv2.ellipse(frame, (x + w - r, y + r), (r, r), 270, 0, 90, white, t)
    cv2.ellipse(frame, (x + w - r, y + h - r), (r, r), 0, 0, 90, white, t)
    cv2.ellipse(frame, (x + r, y + h - r), (r, r), 90, 0, 90, white, t)

    quads = _find_candidate_quads(frame)
    assert len(quads) > 0
    assert any(abs(math.log(_aspect_ratio(q) / 2.0)) < math.log(1.35) for q in quads)


def test_decode_grating_phase_searches_nearby_cycles():
    # Build a synthetic ROI where the true grating is 5 cycles wide, but we ask the decoder for 4.
    roi_h, roi_w = 200, 400
    roi = np.zeros((roi_h, roi_w), dtype=np.uint8)

    y0 = int(0.40 * roi_h)
    y1 = int(0.95 * roi_h)
    x0 = int(0.08 * roi_w)
    x1 = int(0.92 * roi_w)
    w = x1 - x0

    cycles_true = 5
    phase_true = 1.1
    xs = np.arange(w, dtype=np.float64)
    signal = 127.5 + 90.0 * np.sin((math.tau * cycles_true * xs) / float(w) + phase_true)
    signal = np.clip(signal, 0, 255).astype(np.uint8)

    roi[y0:y1, x0:x1] = signal[None, :]

    out = _decode_grating_phase(roi, grating_cycles=4)
    assert out is not None
    phi, k_best = out
    assert k_best == cycles_true
    assert 0.0 <= phi < math.tau

