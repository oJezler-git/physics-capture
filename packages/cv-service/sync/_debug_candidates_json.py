from __future__ import annotations

import argparse
import base64
from pathlib import Path

import cv2
import numpy as np

try:
    from . import sync_marker as sm
except ImportError:
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import sync_marker as sm # type: ignore

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--experiment-dir", type=Path, required=True)
    parser.add_argument("--camera-id", type=int, default=0)
    parser.add_argument("--frame-index", type=int, default=0)
    args = parser.parse_args()

    frames_dir = args.experiment_dir / "frames" / f"cam{int(args.camera_id)}"
    files = sm._sorted_frame_files(frames_dir)
    if not files or args.frame_index >= len(files):
        print("{}")
        return 1
        
    img = cv2.imread(str(files[args.frame_index]))
    if img is None:
        print("{}")
        return 1

    spec = sm.SyncMarkerSpec()
    dst_w, dst_h = spec.roi_width_px, spec.roi_height_px
    dst = np.array([[0, 0], [dst_w - 1, 0], [dst_w - 1, dst_h - 1], [0, dst_h - 1]], dtype=np.float32)

    cands = sm._find_candidate_quads(img)
    
    # Also load the overall fit if results/sync.json exists to get RMS/FPS
    sync_json_path = args.experiment_dir / "results" / "sync.json"
    rms_ms = None
    true_fps = None
    if sync_json_path.exists():
        try:
            import json
            with open(sync_json_path, "r") as f:
                sync_data = json.load(f)
                cam_key = f"cam{int(args.camera_id)}"
                if cam_key in sync_data.get("cameras", {}):
                    cam_data = sync_data["cameras"][cam_key]
                    rms_ms = cam_data.get("fit_residual_rms_ms")
                    true_fps = cam_data.get("true_fps")
        except:
            pass

    results = {
        "status": "error",
        "rms_ms": rms_ms,
        "true_fps": true_fps
    }

    scored = []
    for cand_idx, q in enumerate(cands):
        H = cv2.getPerspectiveTransform(sm._order_quad_points(q), dst)
        roi = cv2.warpPerspective(img, H, (dst_w, dst_h), flags=cv2.INTER_LINEAR)
        g = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        
        roi_score = sm._score_rectified_roi(g, spec)
        score = float(roi_score[0]) if roi_score is not None else -1.0
        
        # Only keep top scoring one for detail
        scored.append((score, g, roi_score))

    scored.sort(key=lambda t: t[0], reverse=True)
    
    if scored:
        best_score, best_g, best_info = scored[0]
        _, roi_png = cv2.imencode(".png", cv2.cvtColor(best_g, cv2.COLOR_GRAY2BGR))
        roi_b64 = base64.b64encode(roi_png).decode("utf-8")
        
        obs = sm._read_gray_observation(best_g, spec.gray_bits)
        gr = sm._decode_grating_phase_mag(best_g, spec.grating_cycles)
        
        results.update({
            "status": "ready",
            "score": best_score,
            "gray": obs[2] if obs else None,
            "phase": gr[0] if gr else None,
            "magnitude": gr[2] if gr else None,
            "border": sm._border_contrast_score(best_g),
            "roi_base64": roi_b64
        })

    import json
    print(json.dumps(results))
    return 0

if __name__ == "__main__":
    main()
