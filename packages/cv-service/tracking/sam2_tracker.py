# packages/cv-service/tracking/sam2_tracker.py
import logging
import os
import re
import shutil
import tempfile
from contextlib import nullcontext
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from PIL import Image

import numpy as np
from sam2.build_sam import build_sam2_video_predictor, build_sam2_video_predictor_hf

try:
    import torch
except Exception:  # pragma: no cover - best-effort optional dependency
    torch = None

logger = logging.getLogger(__name__)


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int, min_value: int = 0) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        logger.warning("Invalid integer for %s=%r. Using default=%d", name, raw, default)
        return default
    if value < min_value:
        logger.warning(
            "Value for %s=%d is below minimum %d. Clamping.",
            name,
            value,
            min_value,
        )
        return min_value
    return value


def _env_choice(name: str, default: str, allowed: set[str]) -> str:
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return default
    if raw in allowed:
        return raw
    logger.warning("Invalid value for %s=%r. Allowed=%s. Using default=%s.", name, raw, sorted(allowed), default)
    return default


def _profile_defaults(profile: str, use_cuda: bool) -> Dict[str, object]:
    base = {
        "chunk_size": 128 if use_cuda else 0,
        "chunk_overlap": 4 if use_cuda else 0,
        "gpu_frame_chunk_threshold": 160,
        "offload_video_to_cpu_default": None,
        "offload_state_to_cpu_default": False,
        "async_loading_frames_default": False,
        "prefer_vos_optimized_default": use_cuda,
        "enable_compile_default": False,
    }

    if profile == "safe":
        base.update(
            {
                "chunk_size": 96 if use_cuda else 64,
                "chunk_overlap": 8 if use_cuda else 4,
                "gpu_frame_chunk_threshold": 96,
                "offload_video_to_cpu_default": True if use_cuda else False,
                "prefer_vos_optimized_default": False,
                "enable_compile_default": False,
            }
        )
    elif profile == "fast":
        base.update(
            {
                "chunk_size": 192 if use_cuda else 0,
                "chunk_overlap": 2 if use_cuda else 0,
                "gpu_frame_chunk_threshold": 512,
                "offload_video_to_cpu_default": False if use_cuda else False,
                "async_loading_frames_default": use_cuda,
                "prefer_vos_optimized_default": use_cuda,
                "enable_compile_default": use_cuda,
            }
        )
    elif profile == "accurate":
        base.update(
            {
                "chunk_size": 160 if use_cuda else 0,
                "chunk_overlap": 12 if use_cuda else 0,
                "gpu_frame_chunk_threshold": 128,
                "offload_video_to_cpu_default": None,
                "prefer_vos_optimized_default": use_cuda,
                "enable_compile_default": False,
            }
        )
    # "balanced" uses base defaults.
    return base


class SAM2Tracker:
    def __init__(self, model_id: str = None, force_device: str = None):
        if force_device:
            self.device = torch.device(force_device) if torch is not None else force_device
        else:
            self.device = (
                torch.device("cuda" if torch.cuda.is_available() else "cpu")
                if torch is not None
                else "cpu"
            )
        logger.info(f"[SAM2] Initializing on device: {self.device}")
        self.predictor = None
        self._coord_cache: Dict[Tuple[int, int, str, str], Tuple[torch.Tensor, torch.Tensor]] = {}

        # Resolve model selection: param > Env > hardcoded default
        config_file = os.getenv("SAM2_CONFIG_FILE", "").strip() or None
        checkpoint_path = os.getenv("SAM2_CHECKPOINT_PATH", "").strip() or None
        enable_postprocessing = _env_flag("SAM2_ENABLE_POSTPROCESSING", default=False)
        use_cuda = "cuda" in str(self.device)
        perf_profile = _env_choice(
            "SAM2_PERF_PROFILE",
            default="balanced",
            allowed={"safe", "balanced", "fast", "accurate"},
        )
        profile_defaults = _profile_defaults(perf_profile, use_cuda)
        logger.info("[SAM2] Performance profile=%s", perf_profile)

        if not model_id:
            model_id = os.getenv("SAM2_MODEL_ID", "facebook/sam2-hiera-tiny").strip()

        enable_compile = _env_flag(
            "SAM2_ENABLE_COMPILE",
            default=bool(profile_defaults["enable_compile_default"]),
        )
        prefer_vos_optimized = _env_flag(
            "SAM2_VOS_OPTIMIZED",
            default=bool(profile_defaults["prefer_vos_optimized_default"]),
        )

        # Persist init options for runtime fallback/rebuilds.
        self._model_id = model_id
        self._config_file = config_file
        self._checkpoint_path = checkpoint_path
        self._enable_postprocessing = enable_postprocessing
        self._enable_compile = enable_compile
        self._prefer_vos_optimized = prefer_vos_optimized
        self._applied_vos_optimized = False
        self._perf_profile = perf_profile
        self._profile_defaults = profile_defaults

        try:
            self._rebuild_predictor(disable_vos=not prefer_vos_optimized)
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
            yield from self._fallback_track(selected_frame_files, seeds, physical_indices)
            return

        # Apply inference mode and autocast for massive hardware acceleration.
        autocast_ctx = (
            torch.autocast("cuda", dtype=torch.bfloat16)
            if "cuda" in str(self.device)
            else nullcontext()
        )
        with torch.inference_mode(), autocast_ctx:
            total_frames = len(selected_frame_files)
            default_chunk = int(self._profile_defaults["chunk_size"])
            max_frames_per_chunk = _env_int(
                "SAM2_MAX_FRAMES_PER_CHUNK",
                default=default_chunk,
                min_value=0,
            )
            use_chunking = max_frames_per_chunk > 0 and total_frames > max_frames_per_chunk
            chunk_overlap = _env_int(
                "SAM2_CHUNK_OVERLAP_FRAMES",
                default=(int(self._profile_defaults["chunk_overlap"]) if use_chunking else 0),
                min_value=0,
            )
            if use_chunking and chunk_overlap >= max_frames_per_chunk:
                chunk_overlap = max(0, max_frames_per_chunk - 1)
            if use_chunking:
                logger.info(
                    "[SAM2] Using chunked tracking: total_frames=%d chunk_size=%d overlap=%d",
                    total_frames,
                    max_frames_per_chunk,
                    chunk_overlap,
                )

            chunk_last_valid: Dict[int, Dict[str, float]] = {}
            chunk_size = max_frames_per_chunk if use_chunking else total_frames
            chunk_step = max(1, chunk_size - chunk_overlap)
            for chunk_start in range(0, total_frames, chunk_step):
                chunk_end = min(chunk_start + chunk_size, total_frames)
                chunk_files = selected_frame_files[chunk_start:chunk_end]
                chunk_physical_indices = physical_indices[chunk_start:chunk_end]
                emit_from_local_idx = 0 if chunk_start == 0 else min(chunk_overlap, len(chunk_files))
                chunk_index_to_local = {
                    physical_idx: local_idx
                    for local_idx, physical_idx in enumerate(chunk_physical_indices)
                }
                range_requested = start_frame_idx is not None or end_frame_idx is not None
                use_isolated_dir = use_chunking or range_requested or len(selected_frame_files) != len(frame_files)
                with self._prepare_sam2_frames(chunk_files, isolate=use_isolated_dir) as sam2_frames_dir:
                    logger.info(
                        "[SAM2] chunk frames=%d isolate=%s video_dir=%s",
                        len(chunk_files),
                        use_isolated_dir,
                        sam2_frames_dir,
                    )
                    inference_state = self._init_inference_state(
                        str(sam2_frames_dir),
                        chunk_frame_count=len(chunk_files),
                    )
                    has_prompts = self._add_seed_prompts(
                        inference_state=inference_state,
                        seeds=seeds,
                        index_to_local=chunk_index_to_local,
                        width=width,
                        height=height,
                        carry_positions=chunk_last_valid if chunk_start > 0 else None,
                    )
                    if not has_prompts:
                        raise RuntimeError(
                            "No valid SAM2 seed prompts available for the selected frame range/chunk."
                        )

                    local_last_valid = dict(chunk_last_valid)
                    for local_frame_idx, obj_ids, masks in self.predictor.propagate_in_video(
                        inference_state
                    ):
                        local_idx = int(local_frame_idx)
                        if local_idx < emit_from_local_idx:
                            continue
                        frame_results = []
                        for i, obj_id in enumerate(obj_ids):
                            m_h, m_w = masks[i].shape[-2:]
                            centroid, area = self._get_centroid_and_area_gpu(masks[i])
                            obj_key = int(obj_id)

                            if area > 10:
                                x_norm = centroid[0] / m_w
                                y_norm = centroid[1] / m_h
                                local_last_valid[obj_key] = {"x": x_norm, "y": y_norm}
                                confidence = 1.0
                            elif obj_key in local_last_valid:
                                x_norm = local_last_valid[obj_key]["x"]
                                y_norm = local_last_valid[obj_key]["y"]
                                confidence = 0.0
                            else:
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

                        physical_idx = chunk_physical_indices[local_idx]
                        global_idx = chunk_start + local_idx
                        progress = global_idx / max(1, total_frames - 1)
                        yield (physical_idx, frame_results, progress)
                    chunk_last_valid = local_last_valid

    def _rebuild_predictor(self, disable_vos: bool = False, disable_compile: bool = False) -> None:
        use_cuda = "cuda" in str(self.device)
        vos_requested = self._prefer_vos_optimized and not disable_vos and use_cuda
        # Triton on Windows is commonly unavailable; avoid VOS compile path unless explicitly forced.
        if os.name == "nt" and "SAM2_VOS_OPTIMIZED" not in os.environ:
            vos_requested = False

        applied_vos = vos_requested
        if self._config_file:
            try:
                self.predictor = build_sam2_video_predictor(
                    config_file=self._config_file,
                    ckpt_path=self._checkpoint_path,
                    device=str(self.device),
                    apply_postprocessing=self._enable_postprocessing,
                    vos_optimized=vos_requested,
                )
            except Exception as exc:
                if not vos_requested:
                    raise
                logger.warning("[SAM2] VOS optimized build failed; retrying without it: %s", exc)
                applied_vos = False
                self.predictor = build_sam2_video_predictor(
                    config_file=self._config_file,
                    ckpt_path=self._checkpoint_path,
                    device=str(self.device),
                    apply_postprocessing=self._enable_postprocessing,
                    vos_optimized=False,
                )
            logger.info(
                "Initialized SAM2 from config=%s checkpoint=%s postprocessing=%s vos_optimized=%s",
                self._config_file,
                self._checkpoint_path or "<none>",
                self._enable_postprocessing,
                applied_vos,
            )
        else:
            try:
                self.predictor = build_sam2_video_predictor_hf(
                    model_id=self._model_id,
                    device=str(self.device),
                    apply_postprocessing=self._enable_postprocessing,
                    vos_optimized=vos_requested,
                )
            except Exception as exc:
                if not vos_requested:
                    raise
                logger.warning("[SAM2] VOS optimized HF build failed; retrying without it: %s", exc)
                applied_vos = False
                self.predictor = build_sam2_video_predictor_hf(
                    model_id=self._model_id,
                    device=str(self.device),
                    apply_postprocessing=self._enable_postprocessing,
                    vos_optimized=False,
                )
            logger.info(
                "Initialized SAM2 from Hugging Face model_id=%s postprocessing=%s vos_optimized=%s",
                self._model_id,
                self._enable_postprocessing,
                applied_vos,
            )

        # Optional generic compile path for non-VOS predictor builds.
        if (
            self._enable_compile
            and not disable_compile
            and hasattr(torch, "compile")
            and use_cuda
            and not applied_vos
        ):
            try:
                logger.info("[SAM2] Compiling predictor with torch.compile...")
                self.predictor = torch.compile(self.predictor)
            except Exception as exc:
                logger.warning("[SAM2] torch.compile failed; continuing eagerly: %s", exc)
        self._applied_vos_optimized = applied_vos

    def _add_seed_prompts(
        self,
        inference_state,
        seeds: List[dict],
        index_to_local: Dict[int, int],
        width: int,
        height: int,
        carry_positions: Optional[Dict[int, Dict[str, float]]] = None,
    ) -> bool:
        grouped_seed_points: Dict[Tuple[int, int], List[Tuple[float, float]]] = {}

        # Original user-provided seeds.
        for seed in seeds:
            x_px = float(seed["x"]) * width
            y_px = float(seed["y"]) * height

            physical_seed_idx = int(seed.get("frame_idx", 0))
            frame_idx = index_to_local.get(physical_seed_idx)
            if frame_idx is None:
                continue

            obj_id = int(seed["ball_id"]) + 1  # 1-indexed for SAM2
            grouped_seed_points.setdefault((obj_id, frame_idx), []).append((x_px, y_px))

        # Carry prompts into new chunks so each object has context at local frame 0.
        if carry_positions:
            for obj_id, pos in carry_positions.items():
                key = (int(obj_id), 0)
                if key in grouped_seed_points:
                    continue
                grouped_seed_points[key] = [
                    (float(pos["x"]) * width, float(pos["y"]) * height)
                ]

        for (obj_id, frame_idx), points_list in sorted(
            grouped_seed_points.items(),
            key=lambda item: (item[0][1], item[0][0]),
        ):
            points = np.asarray(points_list, dtype=np.float32)
            labels = np.ones((len(points_list),), dtype=np.int32)
            self.predictor.add_new_points(
                inference_state=inference_state,
                frame_idx=frame_idx,
                obj_id=obj_id,
                points=points,
                labels=labels,
            )
        return len(grouped_seed_points) > 0

    def _init_inference_state(self, video_path: str, chunk_frame_count: Optional[int] = None):
        use_cuda = "cuda" in str(self.device)
        # CPU-offloaded video frames avoid allocating full sequence on GPU at init_state.
        default_offload_threshold = int(self._profile_defaults["gpu_frame_chunk_threshold"])
        offload_threshold = _env_int(
            "SAM2_GPU_FRAME_CHUNK_THRESHOLD",
            default=default_offload_threshold,
            min_value=1,
        )
        default_offload_video_to_cpu = use_cuda and (
            chunk_frame_count is None or chunk_frame_count > offload_threshold
        )
        profile_offload_default = self._profile_defaults["offload_video_to_cpu_default"]
        if profile_offload_default is not None:
            default_offload_video_to_cpu = bool(profile_offload_default)
        offload_video_to_cpu = _env_flag(
            "SAM2_OFFLOAD_VIDEO_TO_CPU",
            default=default_offload_video_to_cpu,
        )
        offload_state_to_cpu = _env_flag(
            "SAM2_OFFLOAD_STATE_TO_CPU",
            default=bool(self._profile_defaults["offload_state_to_cpu_default"]),
        )
        async_loading_frames = _env_flag(
            "SAM2_ASYNC_LOADING_FRAMES",
            default=bool(self._profile_defaults["async_loading_frames_default"]),
        )

        try:
            return self.predictor.init_state(
                video_path=video_path,
                offload_video_to_cpu=offload_video_to_cpu,
                offload_state_to_cpu=offload_state_to_cpu,
                async_loading_frames=async_loading_frames,
            )
        except Exception as exc:
            err_text = str(exc).lower()
            is_inductor_failure = (
                "backend='inductor'" in err_text
                or "backendcompilerfailed" in err_text
                or "triton" in err_text
                or "torch._dynamo" in err_text
            )
            if is_inductor_failure and (self._applied_vos_optimized or self._enable_compile):
                logger.warning(
                    "[SAM2] Compile backend failure detected; rebuilding in eager mode."
                )
                self._rebuild_predictor(disable_vos=True, disable_compile=True)
                return self.predictor.init_state(
                    video_path=video_path,
                    offload_video_to_cpu=offload_video_to_cpu,
                    offload_state_to_cpu=offload_state_to_cpu,
                    async_loading_frames=async_loading_frames,
                )

            is_cuda_oom = (
                use_cuda
                and torch is not None
                and (
                    isinstance(exc, torch.OutOfMemoryError)
                    or "cuda out of memory" in err_text
                )
            )
            if not is_cuda_oom or offload_video_to_cpu:
                raise

            logger.warning(
                "[SAM2] CUDA OOM during init_state; retrying with offload_video_to_cpu=True."
            )
            if torch is not None and torch.cuda.is_available():
                torch.cuda.empty_cache()
            return self.predictor.init_state(
                video_path=video_path,
                offload_video_to_cpu=True,
                offload_state_to_cpu=offload_state_to_cpu,
                async_loading_frames=async_loading_frames,
            )

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

    def _prepare_sam2_frames(self, frame_files: List[Path], isolate: bool = False):
        """
        SAM2's video loader is happiest with a simple JPEG sequence. If the capture
        pipeline produced PNG frames, normalize them into a temporary JPEG folder
        before initializing the video state.
        """

        needs_conversion = any(path.suffix.lower() == ".png" for path in frame_files)
        if not needs_conversion and not isolate:
            return _PassthroughFrameDir(frame_files[0].parent)

        source_dir = frame_files[0].parent
        if needs_conversion:
            cache_dir = source_dir / ".sam2_jpg_cache"
            cache_dir.mkdir(parents=True, exist_ok=True)
            cached_frame_files = [self._get_or_create_cached_jpg(src, cache_dir) for src in frame_files]
            if not isolate:
                self._prune_png_cache(cache_dir, cached_frame_files)
                return _PassthroughFrameDir(cache_dir)
            frame_files = cached_frame_files

        temp_dir = tempfile.TemporaryDirectory(prefix="sam2_frames_")
        sam2_dir = Path(temp_dir.name)

        for local_idx, src in enumerate(frame_files):
            # SAM2's video loader is strict about frame names on some platforms.
            # Isolated ranges should look like a fresh, contiguous video.
            dst = sam2_dir / f"{local_idx:06d}.jpg"
            shutil.copy2(src, dst)

        return _TemporaryFrameDir(sam2_dir, temp_dir)

    def _get_or_create_cached_jpg(self, src: Path, cache_dir: Path) -> Path:
        is_jpeg = src.suffix.lower() in {".jpg", ".jpeg"}
        dst_name = src.name if is_jpeg else f"{src.stem}.jpg"
        dst = cache_dir / dst_name
        src_stat = src.stat()
        if dst.exists():
            dst_stat = dst.stat()
            if dst_stat.st_mtime_ns >= src_stat.st_mtime_ns and dst_stat.st_size > 0:
                return dst

        if is_jpeg:
            if dst.exists():
                dst.unlink()
            self._link_or_copy(src, dst)
            return dst

        tmp_dst = dst.with_suffix(".jpg.tmp")
        with Image.open(src) as img:
            # Keep conversion memory pressure lower than optimize=True.
            img.convert("RGB").save(tmp_dst, format="JPEG", quality=92, optimize=False)
        tmp_dst.replace(dst)
        os.utime(dst, ns=(src_stat.st_atime_ns, src_stat.st_mtime_ns))
        return dst

    @staticmethod
    def _prune_png_cache(cache_dir: Path, expected_files: List[Path]) -> None:
        expected_names = {path.name for path in expected_files}
        for candidate in cache_dir.iterdir():
            if not candidate.is_file():
                continue
            if candidate.suffix.lower() not in {".jpg", ".jpeg"}:
                continue
            if candidate.name not in expected_names:
                try:
                    candidate.unlink()
                except OSError:
                    logger.debug("[SAM2] Could not prune stale cache file: %s", candidate)

    @staticmethod
    def _link_or_copy(src: Path, dst: Path) -> None:
        try:
            os.link(src, dst)
        except Exception:
            shutil.copy2(src, dst)

    def _get_axis_cache(
        self,
        height: int,
        width: int,
        device: torch.device,
        dtype: torch.dtype,
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        key = (height, width, str(device), str(dtype))
        cached = self._coord_cache.get(key)
        if cached is None:
            cols = torch.arange(width, device=device, dtype=dtype)
            rows = torch.arange(height, device=device, dtype=dtype)
            cached = (rows, cols)
            self._coord_cache[key] = cached
        return cached

    def _get_centroid_and_area_gpu(self, mask: torch.Tensor) -> Tuple[Tuple[float, float], float]:
        """
        Calculate centroid and sum (area) on GPU.
        """
        if not isinstance(mask, torch.Tensor):
            return (0.0, 0.0), 0.0

        # Squeeze to 2D: (H, W)
        m = mask.detach().squeeze()
        if m.ndim > 2:
            m = m[0]

        m = torch.clamp(m, min=0.0)
        total_weight = m.sum()
        area = float(total_weight.item())
        if area <= 1e-6:
            return (0.0, 0.0), 0.0

        height, width = m.shape
        rows, cols = self._get_axis_cache(height, width, m.device, m.dtype)

        cx = (m.sum(dim=0) * cols).sum() / total_weight
        cy = (m.sum(dim=1) * rows).sum() / total_weight

        centroid = torch.stack((cx, cy))
        cx_val, cy_val = centroid.cpu().tolist()
        return (float(cx_val), float(cy_val)), area

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
