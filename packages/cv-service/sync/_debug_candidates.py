from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

try:
    # When executed as a module: python -m sync._debug_candidates
    from . import sync_marker as sm
except ImportError:  # pragma: no cover
    # When executed as a script: python packages/cv-service/sync/_debug_candidates.py
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import sync_marker as sm  # type: ignore


def _resolve_experiment_dir(*, experiments_dir: Path | None, experiment_id: str | None, experiment_dir: Path | None) -> Path:
    if experiment_dir is not None:
        return experiment_dir
    if experiments_dir is None or experiment_id is None:
        raise SystemExit("Provide either --experiment-dir OR (--experiments-dir and --experiment-id).")
    return experiments_dir / experiment_id


def _first_frame(frames_dir: Path, frame_index: int) -> Path:
    files = sm._sorted_frame_files(frames_dir)
    if not files:
        raise SystemExit(f"No image frames found in {frames_dir}")
    idx = int(frame_index)
    if idx < 0 or idx >= len(files):
        raise SystemExit(f"--frame-index {idx} out of range (0..{len(files)-1})")
    return files[idx]


def main() -> int:
    parser = argparse.ArgumentParser(description="Debug sync marker quad candidates on a single frame.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--experiment-dir", type=Path)
    group.add_argument("--experiment-id", type=str)
    parser.add_argument("--experiments-dir", type=Path, default=Path("packages/experiments"))
    parser.add_argument("--camera-id", type=int, default=0)
    parser.add_argument("--frame-index", type=int, default=0, help="Index into sorted extracted frames.")
    parser.add_argument("--max-candidates", type=int, default=20)
    args = parser.parse_args()

    exp_dir = _resolve_experiment_dir(
        experiments_dir=args.experiments_dir if args.experiment_id is not None else None,
        experiment_id=args.experiment_id,
        experiment_dir=args.experiment_dir,
    )
    frames_dir = exp_dir / "frames" / f"cam{int(args.camera_id)}"
    frame_path = _first_frame(frames_dir, int(args.frame_index))

    import cv2  # local import so this file can still be imported without OpenCV installed

    img = cv2.imread(str(frame_path), cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"Failed to read image: {frame_path}")

    spec = sm.SyncMarkerSpec()
    dst_w, dst_h = spec.roi_width_px, spec.roi_height_px
    dst = np.array([[0, 0], [dst_w - 1, 0], [dst_w - 1, dst_h - 1], [0, dst_h - 1]], dtype=np.float32)

    cands = sm._find_candidate_quads(img)
    print(f"frame: {frame_path}")
    print(f"image: {None if img is None else img.shape}")
    print(f"cands: {len(cands)}")

    ok = 0
    for i, q in enumerate(cands[: int(args.max_candidates)]):
        H = cv2.getPerspectiveTransform(sm._order_quad_points(q), dst)
        roi = cv2.warpPerspective(img, H, (dst_w, dst_h), flags=cv2.INTER_LINEAR)
        g = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        n = sm._decode_gray_bits(g, spec.gray_bits)
        gr = sm._decode_grating_phase(g, spec.grating_cycles)
        area = float(cv2.contourArea(q.astype(np.float32)))
        x, y, w, h = cv2.boundingRect(q.astype(np.int32))
        ar = (float(w) / float(h)) if h else 0.0
        gr_s = None if gr is None else (round(float(gr[0]), 3), int(gr[1]))

        roi_score = sm._score_rectified_roi(g, spec)  # type: ignore[attr-defined]
        score = float(roi_score[0]) if roi_score is not None else float("-inf")
        border = float(sm._border_contrast_score(g))  # type: ignore[attr-defined]
        mag = float(roi_score[2]) if roi_score is not None else float("nan")

        print(
            i,
            "area",
            round(area, 1),
            "bbox_ar",
            round(ar, 3),
            "score",
            round(score, 3) if np.isfinite(score) else score,
            "border",
            round(border, 3),
            "mag",
            round(mag, 1) if np.isfinite(mag) else mag,
            "gray",
            n,
            "gr",
            gr_s,
        )
        if n is not None and gr is not None:
            ok += 1
    print("ok:", ok)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
