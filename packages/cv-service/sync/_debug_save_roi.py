from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

try:
    # When executed as a module: python -m sync._debug_save_roi
    from . import sync_marker as sm
except ImportError:  # pragma: no cover
    # When executed as a script: python packages/cv-service/sync/_debug_save_roi.py
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
    parser = argparse.ArgumentParser(description="Save rectified marker ROI PNGs for the top-N candidates.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--experiment-dir", type=Path)
    group.add_argument("--experiment-id", type=str)
    parser.add_argument("--experiments-dir", type=Path, default=Path("packages/experiments"))
    parser.add_argument("--camera-id", type=int, default=0)
    parser.add_argument("--frame-index", type=int, default=0, help="Index into sorted extracted frames.")
    parser.add_argument("--count", type=int, default=5, help="How many candidate ROIs to export.")
    parser.add_argument("--out-dir", type=Path, default=None, help="Defaults to <experiment>/results.")
    args = parser.parse_args()

    exp_dir = _resolve_experiment_dir(
        experiments_dir=args.experiments_dir if args.experiment_id is not None else None,
        experiment_id=args.experiment_id,
        experiment_dir=args.experiment_dir,
    )
    frames_dir = exp_dir / "frames" / f"cam{int(args.camera_id)}"
    files = sm._sorted_frame_files(frames_dir)
    if not files:
        raise SystemExit(f"No image frames found in {frames_dir}")
    idx = int(args.frame_index)
    if idx < 0 or idx >= len(files):
        raise SystemExit(f"--frame-index {idx} out of range (0..{len(files)-1})")
    frame_path = files[idx]

    import cv2  # local import so this file can still be imported without OpenCV installed

    img = cv2.imread(str(frame_path), cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"Failed to read image: {frame_path}")

    spec = sm.SyncMarkerSpec()
    dst_w, dst_h = spec.roi_width_px, spec.roi_height_px
    dst = np.array([[0, 0], [dst_w - 1, 0], [dst_w - 1, dst_h - 1], [0, dst_h - 1]], dtype=np.float32)

    out_dir = Path(args.out_dir) if args.out_dir is not None else (exp_dir / "results")
    out_dir.mkdir(parents=True, exist_ok=True)

    cands = sm._find_candidate_quads(img)
    print("frame:", frame_path)
    print("cands:", len(cands))

    scored = []
    for cand_idx, q in enumerate(cands):
        H = cv2.getPerspectiveTransform(sm._order_quad_points(q), dst)
        roi = cv2.warpPerspective(img, H, (dst_w, dst_h), flags=cv2.INTER_LINEAR)
        g = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

        gray = sm._decode_gray_bits(g, spec.gray_bits)
        gr = sm._decode_grating_phase(g, spec.grating_cycles)
        gr_s = None if gr is None else (round(float(gr[0]), 3), int(gr[1]))

        roi_score = sm._score_rectified_roi(g, spec)  # type: ignore[attr-defined]
        score = float(roi_score[0]) if roi_score is not None else float("-inf")
        border = float(sm._border_contrast_score(g))  # type: ignore[attr-defined]
        mag = float(roi_score[2]) if roi_score is not None else float("nan")

        scored.append((score, cand_idx, q, roi, gray, gr_s, border, mag))

    scored.sort(key=lambda t: t[0], reverse=True)

    for rank, (score, cand_idx, q, roi, gray, gr_s, border, mag) in enumerate(scored[: int(args.count)]):
        out_path = out_dir / f"_debug_roi_cam{int(args.camera_id)}_f{idx:06d}_rank{rank:02d}_cand{cand_idx:02d}.png"
        cv2.imwrite(str(out_path), roi)
        print(
            f"{rank} cand={cand_idx} score={score:.3f} border={border:.3f} mag={mag:.1f} gray={gray} gr={gr_s} -> {out_path}"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
