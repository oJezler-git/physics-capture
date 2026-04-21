from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

try:
    # When executed as a module: python -m sync._debug_run
    from . import sync_marker as sm
except ImportError:  # pragma: no cover
    # When executed as a script: python packages/cv-service/sync/_debug_run.py
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
    parser = argparse.ArgumentParser(description="Quick decode sanity check (warp + sampled Gray+grating values).")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--experiment-dir", type=Path)
    group.add_argument("--experiment-id", type=str)
    parser.add_argument("--experiments-dir", type=Path, default=Path("packages/experiments"))
    parser.add_argument("--camera-id", type=int, default=0)
    parser.add_argument("--stride", type=int, default=5)
    parser.add_argument("--probe-frames", type=int, default=80, help="How many frames to probe to find the warp.")
    parser.add_argument("--show", type=int, default=10, help="How many decoded samples to print.")
    args = parser.parse_args()

    exp_dir = _resolve_experiment_dir(
        experiments_dir=args.experiments_dir if args.experiment_id is not None else None,
        experiment_id=args.experiment_id,
        experiment_dir=args.experiment_dir,
    )
    frames_dir = exp_dir / "frames" / f"cam{int(args.camera_id)}"
    files = sm._sorted_frame_files(frames_dir)
    print("frames:", len(files), "dir:", frames_dir)
    if not files:
        return 1

    import cv2  # local import so this file can still be imported without OpenCV installed

    spec = sm.SyncMarkerSpec()

    # Find warp using the same probing strategy as the decoder.
    built = None
    H = None
    roi_w = roi_h = None
    max_probes = min(int(args.probe_frames), len(files))
    step = max(1, len(files) // max_probes) if max_probes else 1
    probe_indices = list(
        dict.fromkeys(
            list(range(0, min(12, len(files))))
            + list(range(0, len(files), step))
            + list(range(max(0, len(files) - 12), len(files)))
        )
    )
    for idx in probe_indices[:max_probes]:
        img0 = cv2.imread(str(files[idx]), cv2.IMREAD_COLOR)
        if img0 is None:
            continue
        built = sm._build_warp(img0, spec)
        if built is None:
            continue
        H, (roi_w, roi_h) = built
        break

    print("warp:", H is not None, "roi:", roi_w, roi_h)
    if H is None or roi_w is None or roi_h is None:
        return 2

    stride = max(1, int(args.stride))
    xs: list[int] = []
    ns: list[int] = []
    phis: list[float] = []
    bins: list[int] = []

    for idx in range(0, len(files), stride):
        img = cv2.imread(str(files[idx]), cv2.IMREAD_COLOR)
        if img is None:
            continue
        roi = cv2.warpPerspective(img, H, (roi_w, roi_h), flags=cv2.INTER_LINEAR)
        g = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        n = sm._decode_gray_bits(g, spec.gray_bits)
        gr = sm._decode_grating_phase(g, spec.grating_cycles)
        if n is None or gr is None:
            continue
        phi, k = gr
        xs.append(idx)
        ns.append(int(n))
        phis.append(float(phi))
        bins.append(int(k))

    print("decoded_points:", len(xs), "of", (len(files) + stride - 1) // stride)
    print("first samples (idx, n, phi, k):", list(zip(xs, ns, [round(p, 3) for p in phis], bins))[: int(args.show)])

    if len(xs) >= 2:
        mod = 1 << spec.gray_bits
        un = sm._unwrap_mod_counter(ns, mod)
        deltas = [un[i] - un[i - 1] for i in range(1, len(un))]
        print("delta_n median:", float(np.median(deltas)))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

