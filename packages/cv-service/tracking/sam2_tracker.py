# packages/cv-service/tracking/sam2_tracker.py
import logging
import os
import re
import tempfile
from contextlib import nullcontext
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
        enable_postprocessing = os.getenv("SAM2_ENABLE_POSTPROCESSING", "0").strip().lower() in {"1", "true", "yes", "on"}
        
        if not model_id:
            model_id = os.getenv("SAM2_MODEL_ID", "facebook/sam2-hiera-tiny").strip()

        enable_compile = os.getenv("SAM2_ENABLE_COMPILE", "0").strip().lower() in {"1", "true", "yes", "on"}

        try:
            if config_file:
                ckpt = checkpoint_path or None
                self.predictor = build_sam2_video_predictor(
                    config_file=config_file,
                    ckpt_path=ckpt,
                    device=str(self.device),
                    apply_postprocessing=enable_postprocessing,
                )
                
                # Optimized for modern GPUs (RTX 40 series)
                if enable_compile and hasattr(torch, "compile") and "cuda" in str(self.device):
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
                    device=str(self.device),
                    apply_postprocessing=enable_postprocessing,
                )
                
                # Boost for modern hardware
                if enable_compile and hasattr(torch, "compile") and "cuda" in str(self.device):
                    try:
                        logger.info("[SAM2] Compiling HF model for maximum hardware utility...")
                        self.predictor = torch.compile(self.predictor)
                    except Exception as e:
                        logger.warn(f"[SAM2] torch.compile fallback: {e}")
                
                logger.info(
                    "Initialized SAM2 from Hugging Face model_id=%s postprocessing=%s",
                    model_id,
                    enable_postprocessing,
                )
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

    def track(self, frames_dir: Path, seeds: List[dict], start_frame_idx: int = None, end_frame_idx: int = None):
        """
        frames_dir: Path to extracted PNG frames
        seeds: List of dicts with {ball_id, frame_idx, x, y}
        """
        frame_files = self._discover_frame_files(frames_dir)
        if not frame_files:
            raise FileNotFoundError(
                f"No image frames found in {frames_dir}. Expected .jpg, .jpeg, or .png files."
            )

        frame_pairs = list(enumerate(frame_files))
        if start_frame_idx is not None:
            frame_pairs = [(idx, path) for idx, path in frame_pairs if idx >= int(start_frame_idx)]
        if end_frame_idx is not None:
            frame_pairs = [(idx, path) for idx, path in frame_pairs if idx <= int(end_frame_idx)]
        if not frame_pairs:
            raise ValueError(
                f"No frames in requested range start={start_frame_idx} end={end_frame_idx} for {frames_dir}"
            )

        physical_indices = [idx for idx, _ in frame_pairs]
        selected_frame_files = [path for _, path in frame_pairs]
        index_to_local = {physical_idx: local_idx for local_idx, physical_idx in enumerate(physical_indices)}

        # Get image dimensions for coordinate normalization
        with Image.open(selected_frame_files[0]) as img:
            width, height = img.size

        logger.info(
            "[SAM2] track_start camera_dir=%s range=%s-%s selected_frames=%d resolution=%dx%d",
            frames_dir,
            start_frame_idx if start_frame_idx is not None else 0,
            end_frame_idx if end_frame_idx is not None else "end",
            len(selected_frame_files),
            width,
            height,
        )

        if self.predictor is None:
            return self._fallback_track(selected_frame_files, seeds, physical_indices)

        # Apply inference mode and autocast for massive hardware acceleration.
        autocast_ctx = (
            torch.autocast("cuda", dtype=torch.bfloat16)
            if "cuda" in str(self.device)
            else nullcontext()
        )
        with torch.inference_mode(), autocast_ctx:
            with self._prepare_sam2_frames(selected_frame_files) as sam2_frames_dir:
                inference_state = self.predictor.init_state(video_path=str(sam2_frames_dir))

                # Add initial seed points.
                for seed in seeds:
                    # Expecting normalized x, y (0-1) from frontend
                    x_px = float(seed["x"]) * width
                    y_px = float(seed["y"]) * height

                    physical_seed_idx = int(seed.get("frame_idx", 0))
                    frame_idx = index_to_local.get(physical_seed_idx)
                    if frame_idx is None:
                        continue
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
                total_frames = len(selected_frame_files)

                # Keep track of last valid positions to "hold" during occlusions/jumps
                last_valid = {} # obj_id -> {x, y}

                for local_frame_idx, obj_ids, masks in self.predictor.propagate_in_video(inference_state):
                    frame_results = []
                    for i, obj_id in enumerate(obj_ids):
                        # Keep mask on GPU for centroid calculation
                        centroid, area = self._get_centroid_and_area_gpu(masks[i])

                        obj_key = int(obj_id)

                        # If mask is present, update last valid and use high confidence
                        if area > 10: # Minimum pixel threshold
                            x_norm = centroid[0] / width
                            y_norm = centroid[1] / height
                            last_valid[obj_key] = {"x": x_norm, "y": y_norm}
                            confidence = 1.0
                        else:
                            # Mask lost! Use last known position if available
                            if obj_key in last_valid:
                                x_norm = last_valid[obj_key]["x"]
                                y_norm = last_valid[obj_key]["y"]
                                confidence = 0.0 # Flag as lost but hold position
                            else:
                                # Never found?
                                x_norm, y_norm = 0.0, 0.0
                                confidence = 0.0

                        frame_results.append(
                            {
                                "ball_id": obj_key - 1,
                                "x": x_norm,
                                "y": y_norm,
                                "confidence": confidence,
                            }
                        )
                    # Yield streaming item: (frame_int, points, progress_pct)
                    local_idx = int(local_frame_idx)
                    physical_idx = physical_indices[local_idx]
                    yield (physical_idx, frame_results, local_idx / max(1, total_frames - 1))

    def _fallback_track(self, frame_files: List[Path], seeds: List[dict], physical_indices: List[int]):
        """
        Deterministic fallback when SAM2 cannot initialize:
        repeats seed positions across all frames with low confidence.
        """
        logger.warning("Running fallback tracker for %d frames", len(frame_files))
        total_frames = len(frame_files)
        for local_idx, _ in enumerate(frame_files):
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
            yield (
                physical_indices[local_idx],
                frame_results,
                local_idx / max(1, total_frames - 1),
            )

    def _discover_frame_files(self, frames_dir: Path) -> List[Path]:
        frame_files = [
            path
            for path in frames_dir.iterdir()
            if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png"}
        ]
        return sorted(frame_files, key=self._frame_sort_key)

    @staticmethod
    def _frame_sort_key(path: Path):
        match = re.search(r"\d+", path.stem)
        return (int(match.group(0)) if match else 0, path.name.lower())

    def _prepare_sam2_frames(self, frame_files: List[Path]):
        """
        SAM2's video loader is happiest with a simple JPEG sequence. If the capture
        pipeline produced PNG frames, normalize them into a temporary JPEG folder
        before initializing the video state.
        """

        needs_conversion = any(path.suffix.lower() == ".png" for path in frame_files)
        if not needs_conversion:
            return _PassthroughFrameDir(frame_files[0].parent)

        temp_dir = tempfile.TemporaryDirectory(prefix="sam2_frames_")
        sam2_dir = Path(temp_dir.name)

        for src in frame_files:
            dst = sam2_dir / f"{src.stem}.jpg"
            with Image.open(src) as img:
                # Keep conversion memory pressure lower than optimize=True.
                img.convert("RGB").save(dst, format="JPEG", quality=92, optimize=False)

        return _TemporaryFrameDir(sam2_dir, temp_dir)

    def _get_centroid_and_area_gpu(self, mask: torch.Tensor) -> Tuple[Tuple[float, float], float]:
        """
        Calculate centroid and sum (area) on GPU.
        """
        if not isinstance(mask, torch.Tensor):
            return (0.0, 0.0), 0.0
            
        # Squeeze to 2D: (H, W)
        m = mask.detach().squeeze()
        if m.ndim > 2: m = m[0]
        
        m = torch.clamp(m, min=0.0)
        total_weight = m.sum()
        area = float(total_weight.cpu())
        
        if total_weight <= 1e-6:
            return (0.0, 0.0), 0.0
            
        height, width = m.shape
        cols = torch.arange(width, device=m.device, dtype=m.dtype)
        rows = torch.arange(height, device=m.device, dtype=m.dtype)
        
        cx = (m.sum(dim=0) * cols).sum() / total_weight
        cy = (m.sum(dim=1) * rows).sum() / total_weight
        
        return (float(cx.cpu()), float(cy.cpu())), area

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


class _PassthroughFrameDir:
    def __init__(self, path: Path):
        self.path = path

    def __enter__(self) -> Path:
        return self.path

    def __exit__(self, exc_type, exc, tb) -> None:
        return None


class _TemporaryFrameDir(_PassthroughFrameDir):
    def __init__(self, path: Path, temp_dir: tempfile.TemporaryDirectory):
        super().__init__(path)
        self._temp_dir = temp_dir

    def __exit__(self, exc_type, exc, tb) -> None:
        self._temp_dir.cleanup()
        return None
