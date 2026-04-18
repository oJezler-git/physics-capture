# packages/cv-service/tracking/sam2_tracker.py
import logging
import os
from pathlib import Path
from typing import List, Tuple
from PIL import Image

import numpy as np
from sam2.build_sam import build_sam2_video_predictor, build_sam2_video_predictor_hf

try:
    import torch
except Exception:  # pragma: no cover - best-effort optional dependency
    torch = None

logger = logging.getLogger(__name__)


class SAM2Tracker:
    def __init__(self, model_id: str = None):
        self.device = (
            torch.device("cuda" if torch.cuda.is_available() else "cpu")
            if torch is not None
            else "cpu"
        )
        logger.info(f"[SAM2] Initializing on device: {self.device}")
        self.predictor = None

        # Resolve model selection: param > Env > hardcoded default
        config_file = os.getenv("SAM2_CONFIG_FILE", "").strip()
        checkpoint_path = os.getenv("SAM2_CHECKPOINT_PATH", "").strip()
        
        if not model_id:
            model_id = os.getenv("SAM2_MODEL_ID", "facebook/sam2-hiera-tiny").strip()

        try:
            if config_file:
                ckpt = checkpoint_path or None
                self.predictor = build_sam2_video_predictor(
                    config_file=config_file,
                    ckpt_path=ckpt,
                    device=str(self.device),
                )
                
                # Optimized for modern GPUs (RTX 40 series)
                if hasattr(torch, "compile") and "cuda" in str(self.device):
                    try:
                        logger.info("[SAM2] Found modern torch; compiling model for 40-series speedup...")
                        self.predictor = torch.compile(self.predictor)
                    except Exception as e:
                        logger.warn(f"[SAM2] torch.compile failed (normal on some Windows setups): {e}")
                logger.info(
                    "Initialized SAM2 from config=%s checkpoint=%s",
                    config_file,
                    checkpoint_path or "<none>",
                )
            else:
                self.predictor = build_sam2_video_predictor_hf(
                    model_id=model_id, 
                    device=str(self.device)
                )
                
                # Boost for modern hardware
                if hasattr(torch, "compile") and "cuda" in str(self.device):
                    try:
                        logger.info("[SAM2] Compiling HF model for maximum hardware utility...")
                        self.predictor = torch.compile(self.predictor)
                    except Exception as e:
                        logger.warn(f"[SAM2] torch.compile fallback: {e}")
                
                logger.info("Initialized SAM2 from Hugging Face model_id=%s", model_id)
        except ModuleNotFoundError as exc:
            # Common setup miss: optional HF dependency for checkpoint download.
            if exc.name == "huggingface_hub":
                logger.warning(
                    "SAM2 initialization skipped: missing dependency 'huggingface_hub'. "
                    "Install cv-service requirements and restart to enable SAM2."
                )
            else:
                logger.exception("SAM2 initialization failed; using fallback tracker: %s", exc)
            self.predictor = None
        except Exception as exc:
            # Keep the service alive and fall back to deterministic seed-only tracking.
            logger.exception("SAM2 initialization failed; using fallback tracker: %s", exc)
            self.predictor = None

    def track(self, frames_dir: Path, seeds: List[dict]):
        """
        frames_dir: Path to extracted PNG frames
        seeds: List of dicts with {ball_id, frame_idx, x, y}
        """
        frame_files = sorted(list(frames_dir.glob("*.png")) + list(frames_dir.glob("*.jpg")))
        # Get image dimensions for coordinate normalization
        with Image.open(frame_files[0]) as img:
            width, height = img.size

        if self.predictor is None:
            return self._fallback_track(frame_files, seeds)

        # Apply inference mode and autocast for massive hardware acceleration
        with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
            inference_state = self.predictor.init_state(video_path=str(frames_dir))

            # Add initial seed points.
            for seed in seeds:
                # Expecting normalized x, y (0-1) from frontend
                x_px = float(seed["x"]) * width
                y_px = float(seed["y"]) * height
                
                frame_idx = seed.get("frame_idx", 0)
                obj_id = seed["ball_id"] + 1 # 1-indexed for SAM2
                
                points = np.array([[x_px, y_px]], dtype=np.float32)
                labels = np.array([1], dtype=np.int32)
                self.predictor.add_new_points(
                    inference_state=inference_state,
                    frame_idx=frame_idx,
                    obj_id=obj_id,
                    points=points,
                    labels=labels,
                )

            # Propagate through video.
            total_frames = len(frame_files)
            for frame_idx, obj_ids, masks in self.predictor.propagate_in_video(inference_state):
                frame_results = []
                for i, obj_id in enumerate(obj_ids):
                    # Keep mask on GPU for centroid calculation
                    centroid = self._get_centroid_gpu(masks[i])
                    
                    frame_results.append(
                        {
                            "ball_id": int(obj_id) - 1,
                            "x": centroid[0] / width,
                            "y": centroid[1] / height,
                            "confidence": 1.0, # Confidence is implicit in mask presence
                        }
                    )
                # Yield streaming item: (frame_int, points, progress_pct)
                idx = int(frame_idx)
                yield (idx, frame_results, idx / max(1, total_frames - 1))

    def _fallback_track(self, frame_files: List[Path], seeds: List[dict]):
        """
        Deterministic fallback when SAM2 cannot initialize:
        repeats seed positions across all frames with low confidence.
        """
        logger.warning("Running fallback tracker for %d frames", len(frame_files))
        total_frames = len(frame_files)
        for frame_idx, _ in enumerate(frame_files):
            frame_results = []
            for seed in seeds:
                frame_results.append(
                    {
                        "ball_id": seed["ball_id"],
                        "x": float(seed["x"]), # Already normalized
                        "y": float(seed["y"]), # Already normalized
                        "confidence": 0.25,
                    }
                )
            yield (frame_idx, frame_results, frame_idx / max(1, total_frames - 1))

    def _get_centroid_gpu(self, mask: torch.Tensor) -> Tuple[float, float]:
        """
        Calculate centroid on GPU to avoid heavy CPU-GPU transfers.
        """
        if not isinstance(mask, torch.Tensor):
            return (0.0, 0.0)
            
        # Squeeze to 2D: (H, W)
        m = mask.detach().squeeze()
        if m.ndim > 2: m = m[0] # Take first if still multi-dimensional
        
        # Simple threshold/clip to get weights
        m = torch.clamp(m, min=0.0)
        total_weight = m.sum()
        
        if total_weight <= 1e-6:
            return (0.0, 0.0)
            
        # GPU-accelerated projection
        height, width = m.shape
        
        # Generate coordinate vectors on the SAME device as mask
        cols = torch.arange(width, device=m.device, dtype=m.dtype)
        rows = torch.arange(height, device=m.device, dtype=m.dtype)
        
        # Weighted averages
        cx = (m.sum(dim=0) * cols).sum() / total_weight
        cy = (m.sum(dim=1) * rows).sum() / total_weight
        
        return (float(cx.cpu()), float(cy.cpu()))

    def _get_centroid(self, mask: np.ndarray) -> Tuple[float, float]:
        """Fallback for non-torch masks"""
        total_weight = mask.sum()
        if total_weight <= 0: return (0.0, 0.0)
        sum_x = np.sum(mask, axis=0)
        sum_y = np.sum(mask, axis=1)
        cx = np.sum(sum_x * np.arange(mask.shape[1])) / total_weight
        cy = np.sum(sum_y * np.arange(mask.shape[0])) / total_weight
        return (float(cx), float(cy))
        
    def _to_numpy_mask(self, mask) -> np.ndarray:
        if hasattr(mask, "detach"):
            mask = mask.detach().float().cpu().numpy()
        mask = np.asarray(mask, dtype=np.float32)
        if mask.ndim >= 3:
            mask = np.squeeze(mask)
        if mask.ndim != 2:
            return np.zeros((1, 1), dtype=np.float32)
        return np.clip(mask, a_min=0.0, a_max=None)
