from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

try:
    # When executed as a module: python -m sync._debug_fit
    from . import sync_marker as sm
except ImportError:  # pragma: no cover
    # When executed as a script: python packages/cv-service/sync/_debug_fit.py
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import sync_marker as sm  # type: ignore


def _resolve_experiment_dir(*, experiments_dir: Path | None, experiment_id: str | None, experiment_dir: Path | None) -> Path:
    if experiment_dir is not None:
        return experiment_dir
    if experiments_dir is None or experiment_id is None:
        raise SystemExit("Provide either --experiment-dir OR (--experiments-dir and --experiment-id).")
    return experiments_dir / experiment_id


def main() -> int:
    parser = argparse.ArgumentParser(description="Debug fit and FPS estimation details for the sync marker.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--experiment-dir", type=Path)
    group.add_argument("--experiment-id", type=str)
    parser.add_argument("--experiments-dir", type=Path, default=Path("packages/experiments"))
    parser.add_argument("--camera-id", type=int, default=0)
    parser.add_argument("--stride", type=int, default=5)
    parser.add_argument("--display-hz", type=float, default=60.0)
    parser.add_argument("--probe-frames", type=int, default=80, help="How many frames to probe to find the warp.")
    args = parser.parse_args()

    exp_dir = _resolve_experiment_dir(
        experiments_dir=args.experiments_dir if args.experiment_id is not None else None,
        experiment_id=args.experiment_id,
        experiment_dir=args.experiment_dir,
    )
    frames_dir = exp_dir / "frames" / f"cam{int(args.camera_id)}"
    frames = sm._sorted_frame_files(frames_dir)
    print("frames:", len(frames), "dir:", frames_dir)
    if not frames:
        return 1

    import cv2  # local import so this file can still be imported without OpenCV installed

    spec = sm.SyncMarkerSpec()

    built = None
    max_probes = min(int(args.probe_frames), len(frames))
    step = max(1, len(frames) // max_probes) if max_probes else 1
    probe_indices = list(
        dict.fromkeys(
            list(range(0, min(12, len(frames))))
            + list(range(0, len(frames), step))
            + list(range(max(0, len(frames) - 12), len(frames)))
        )
    )
    for idx in probe_indices[:max_probes]:
        img = cv2.imread(str(frames[idx]), cv2.IMREAD_COLOR)
        if img is None:
            continue
        built = sm._build_warp(img, spec)
        if built is not None:
            break
    if not built:
        print("warp: NOT FOUND")
        return 2
    H, (rw, rh) = built
    print("warp: OK", "roi:", rw, rh)

    stride = max(1, int(args.stride))
    xs: list[int] = []
    n_mods: list[int] = []
    phis: list[float] = []
    bits: list[list[int]] = []
    conf: list[list[float]] = []
    bins: list[int] = []

    for idx in range(0, len(frames), stride):
        img = cv2.imread(str(frames[idx]), cv2.IMREAD_COLOR)
        if img is None:
            continue
        roi = cv2.warpPerspective(img, H, (rw, rh), flags=cv2.INTER_LINEAR)
        g = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        obs = sm._read_gray_observation(g, spec.gray_bits)
        gr = sm._decode_grating_phase(g, spec.grating_cycles)
        if obs is None or gr is None:
            continue
        b, c, n = obs
        phi, k = gr
        xs.append(idx)
        n_mods.append(int(n))
        phis.append(float(phi))
        bits.append(b)
        conf.append(c)
        bins.append(int(k))

    if len(xs) < 8:
        print("points:", len(xs), "(too few)")
        return 3

    mod = 1 << spec.gray_bits
    forward: list[int] = []
    for i in range(1, len(n_mods)):
        d = (n_mods[i] - n_mods[i - 1]) % mod
        if 0 < d <= mod // 2:
            forward.append(int(d))

    typical = int(np.median(forward)) if forward else int(round(float(args.display_hz) * float(stride) / 30.0))
    typical = max(1, typical)
    window = max(25, int(3.5 * typical))

    # Simplified correction loop: pick Gray code candidate with minimum weighted mismatch (no step penalty).
    corr = [int(n_mods[0])]
    for i in range(1, len(n_mods)):
        pred = (corr[-1] + typical) % mod
        best_cost = float("inf")
        best = int(pred)
        for delta in range(-window, window + 1):
            cand = (pred + delta) % mod
            cand_bits = sm._gray_encode_bits(cand, spec.gray_bits)
            cost = 0.0
            for bo, bc, w in zip(bits[i], cand_bits, conf[i]):
                if bo != bc:
                    cost += float(w)
            if cost < best_cost:
                best_cost = cost
                best = int(cand)
        corr.append(best)

    un = [corr[0]]
    for i in range(1, len(corr)):
        un.append(int(un[-1] + ((corr[i] - corr[i - 1]) % mod)))

    Phi = np.array([sm.TAU * float(un_i) + float(phi) for un_i, phi in zip(un, phis)], dtype=np.float64)
    x = np.array(xs, dtype=np.float64)
    m, c, rms = sm._fit_line(x, Phi)

    dphi_dt = (sm.TAU + float(spec.phase_step_rad)) * float(args.display_hz)
    true_fps = abs(dphi_dt / m) if m != 0 else float("nan")
    rms_ms = abs(float(rms) / dphi_dt) * 1000.0 if dphi_dt != 0 else float("inf")

    print("points:", len(xs), "typ:", typical, "window:", window)
    print("m:", m, "c:", c)
    print("true_fps:", true_fps, "rms_phi:", rms, "rms_ms:", rms_ms)
    print("bin_med:", float(np.median(bins)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

