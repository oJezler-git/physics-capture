# packages/cv-service/tracking/sam2_tracker.py
import torch
from sam2.build_sam import build_sam2_video_predictor
import numpy as np
from pathlib import Path
from typing import List, Tuple

class SAM2Tracker:
    def __init__(self, model_cfg: str = "sam2_hiera_large.pt"):
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.predictor = build_sam2_video_predictor(model_cfg)
        self.predictor.to(self.device)

    def track(self, frames_dir: Path, seeds: List[Tuple[int, int]]):
        """
        frames_dir: Path to extracted PNG frames
        seeds: List of (x, y) coordinates for initial clicks
        """
        inference_state = self.predictor.init_state(video_path=str(frames_dir))
        
        # Add initial seed points
        for i, (x, y) in enumerate(seeds):
            self.predictor.add_new_points(
                inference_state,
                frame_idx=0,
                obj_id=i + 1,
                points=[[x, y]],
                labels=[1]
            )

        # Propagate through video
        results = {}
        for frame_idx, obj_ids, masks in self.predictor.propagate_in_video(inference_state):
            frame_results = []
            for i, obj_id in enumerate(obj_ids):
                mask = masks[i]
                centroid = self._get_centroid(mask)
                frame_results.append({
                    "ball_id": obj_id - 1,
                    "x": centroid[0],
                    "y": centroid[1],
                    "confidence": float(mask.max())
                })
            results[frame_idx] = frame_results
            
        return results

    def _get_centroid(self, mask: np.ndarray) -> Tuple[float, float]:
        ys, xs = np.mgrid[0:mask.shape[0], 0:mask.shape[1]]
        total_weight = mask.sum()
        if total_weight == 0: return (0.0, 0.0)
        cx = (xs * mask).sum() / total_weight
        cy = (ys * mask).sum() / total_weight
        return (float(cx), float(cy))
