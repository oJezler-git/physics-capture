from __future__ import annotations

import argparse
import dataclasses
import json
import math
from pathlib import Path
from typing import Optional, Iterable

import numpy as np
import cv2

try:
    from . import sync_marker as sm
except ImportError:
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import sync_marker as sm # type: ignore

def _resolve_experiment_dir(*, experiments_dir: Path | None, experiment_id: str | None, experiment_dir: Path | None) -> Path:
    if experiment_dir is not None:
        return experiment_dir
    if experiments_dir is None or experiment_id is None:
        raise SystemExit("Provide either --experiment-dir OR (--experiments-dir and --experiment-id).")
    return experiments_dir / experiment_id

def main() -> int:
    parser = argparse.ArgumentParser(description="Render a video of the rectified ROI for the entire clip.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--experiment-dir", type=Path)
    group.add_argument("--experiment-id", type=str)
    parser.add_argument("--experiments-dir", type=Path, default=Path("packages/experiments"))
    parser.add_argument("--camera-id", type=int, default=0)
    parser.add_argument("--fps", type=float, default=30.0, help="Output video FPS.")
    parser.add_argument("--out", type=Path, help="Output video file path (defaults to results/_debug_roi_camN.mp4).")
    args = parser.parse_args()

    exp_dir = _resolve_experiment_dir(
        experiments_dir=args.experiments_dir if args.experiment_id is not None else None,
        experiment_id=args.experiment_id,
        experiment_dir=args.experiment_dir,
    )
    cam_id = int(args.camera_id)
    frames_dir = exp_dir / "frames" / f"cam{cam_id}"
    files = sm._sorted_frame_files(frames_dir)
    if not files:
        raise SystemExit(f"No image frames found in {frames_dir}")

    spec = sm.SyncMarkerSpec()
    
    # Discover the "best" warp from probe frames
    print(f"Discovering warp for cam{cam_id}...")
    
    # Probe indices across the whole clip
    max_probes = min(60, len(files))
    step = max(1, len(files) // max_probes)
    probe_indices = list(range(0, len(files), step))[:max_probes]
    
    best_H: Optional[np.ndarray] = None
    best_roi_size = (0, 0)
    best_score = -1.0
    
    for idx in probe_indices:
        img = cv2.imread(str(files[idx]))
        if img is None: continue
        built = sm._build_warp(img, spec)
        if not built: continue
        
        Hcand, (rw, rh) = built
        
        # Quick quality check on 3 more frames
        ok_count = 0
        score_sum = 0.0
        check_indices = [idx, (idx + 10) % len(files), (idx + 20) % len(files)]
        for cidx in check_indices:
            cimg = cv2.imread(str(files[cidx]))
            if cimg is None: continue
            croi = cv2.warpPerspective(cimg, Hcand, (rw, rh))
            cg = cv2.cvtColor(croi, cv2.COLOR_BGR2GRAY)
            scored = sm._score_rectified_roi(cg, spec)
            if scored:
                ok_count += 1
                score_sum += scored[0]
        
        if ok_count > 0:
            final_score = score_sum / ok_count * (ok_count / 3.0)
            if final_score > best_score:
                best_score = final_score
                best_H = Hcand
                best_roi_size = (rw, rh)
        
        if ok_count == 3: break # Good enough

    if best_H is None:
        raise SystemExit(f"Could not discover a stable sync marker warp in {frames_dir}")
    
    H, (rw, rh) = best_H, best_roi_size
    
    out_path = args.out
    if out_path is None:
        out_path = exp_dir / "results" / f"_debug_roi_cam{cam_id}.mp4"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    writer = cv2.VideoWriter(str(out_path), fourcc, args.fps, (rw, rh))
    
    print(f"Rendering {len(files)} frames to {out_path}...")
    
    for i, frame_path in enumerate(files):
        img = cv2.imread(str(frame_path))
        if img is None:
            continue
            
        roi = cv2.warpPerspective(img, H, (rw, rh), flags=cv2.INTER_LINEAR)
        
        # Decode for overlay
        g = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        gray = sm._decode_gray_bits(g, spec.gray_bits)
        gr = sm._decode_grating_phase_mag(g, spec.grating_cycles)
        
        # Draw status overlay
        status_bg = np.zeros((30, rw, 3), dtype=np.uint8)
        roi[0:30, 0:rw] = cv2.addWeighted(roi[0:30, 0:rw], 0.4, status_bg, 0.6, 0)
        
        txt = f"F:{i:04d} "
        if gray is not None:
            txt += f"G:{gray:03d} "
        else:
            txt += "G:ERR "
            
        if gr is not None:
            phi, k, mag = gr
            txt += f"P:{phi:.2f} M:{int(mag)} "
        else:
            txt += "P:ERR "
            
        cv2.putText(roi, txt, (10, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1, cv2.LINE_AA)
        
        writer.write(roi)
        if i % 50 == 0:
            print(f"  Frame {i}/{len(files)}...")
            
    writer.release()
    print(f"Done! Video saved to {out_path}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
