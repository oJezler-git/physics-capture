# packages/cv-service/physics/collision.py

import numpy as np
from dataclasses import dataclass
from .converter import MetricTrack
from .exceptions import InsufficientDataError

# Closest center-to-center distance allowed for a contact event (~10 cm).
# This should be slightly larger than the diameter of the balls (e.g. 57mm for billiards).
CONTACT_DISTANCE_M = 0.10
# Early separation must be substantially larger than the contact distance.
APPROACH_RATIO = 0.60


@dataclass
class CollisionResult:
    collision_frame: int          # -1 if not detected
    pre_start:  int               # first frame of pre-collision window
    pre_end:    int               # last frame of pre-collision window (exclusive of collision)
    post_start: int               # first frame of post-collision window (exclusive of collision)
    post_end:   int               # last frame of post-collision window
    rolling_velocities: np.ndarray  # float64 [N] — crude dv/dt for diagnostics


def detect_collision(
    primary_track: MetricTrack,
    window_frames: int = 5,
    threshold_factor: float = 5.0,
    pre_window: int = 12,
    post_window: int = 12
) -> CollisionResult:

    """
    Identify the collision frame and define pre/post windows using a rolling velocity estimator.
    """
    return detect_system_collision(
        [primary_track],
        window_frames=window_frames,
        threshold_factor=threshold_factor,
        pre_window=pre_window,
        post_window=post_window
    )


def _compute_rolling_speeds(
    tracks: list[MetricTrack],
    window_frames: int,
) -> tuple[np.ndarray, list[np.ndarray], np.ndarray]:
    """Return per-ball rolling speeds, per-ball delta_v, and combined delta_v."""
    N = len(tracks[0].x_m)
    t_s = tracks[0].t_s
    system_delta_v = np.zeros(N)
    per_ball_delta_v: list[np.ndarray] = []
    primary_v_roll = np.full(N, np.nan, dtype=np.float64)

    for track_idx, track in enumerate(tracks):
        v_roll = np.full(N, np.nan, dtype=np.float64)
        x = track.x_m
        y = track.y_m_raw

        for i in range(window_frames, N - window_frames):
            xl, xr = x[i - window_frames], x[i + window_frames]
            yl, yr = y[i - window_frames], y[i + window_frames]
            tl, tr = t_s[i - window_frames], t_s[i + window_frames]

            if not np.any(np.isnan([xl, xr, yl, yr])):
                vx = (xr - xl) / (tr - tl)
                vy = (yr - yl) / (tr - tl)
                v_roll[i] = np.sqrt(vx**2 + vy**2)

        if track_idx == 0:
            primary_v_roll = v_roll

        ball_delta_v = np.zeros(N)
        for i in range(window_frames + 1, N - window_frames):
            if not np.isnan(v_roll[i]) and not np.isnan(v_roll[i - 1]):
                ball_delta_v[i] = abs(v_roll[i] - v_roll[i - 1])

        per_ball_delta_v.append(ball_delta_v)
        system_delta_v += ball_delta_v

    return primary_v_roll, per_ball_delta_v, system_delta_v


def _pairwise_distances(tracks: list[MetricTrack]) -> np.ndarray:
    """Minimum pairwise center distance across all balls at each frame."""
    N = len(tracks[0].x_m)
    distances = np.full(N, np.nan)

    for i in range(N):
        positions: list[tuple[float, float]] = []
        for track in tracks:
            if np.isnan(track.x_m[i]) or np.isnan(track.y_m_raw[i]):
                positions = []
                break
            positions.append((float(track.x_m[i]), float(track.y_m_raw[i])))

        if len(positions) < 2:
            continue

        min_pair = float("inf")
        for a_idx in range(len(positions)):
            for b_idx in range(a_idx + 1, len(positions)):
                xa, ya = positions[a_idx]
                xb, yb = positions[b_idx]
                min_pair = min(min_pair, np.hypot(xa - xb, ya - yb))
        distances[i] = min_pair

    return distances


def _windows_are_valid(
    tracks: list[MetricTrack],
    collision_frame: int,
    pre_window: int,
    post_window: int,
    window_frames: int,
    N: int,
) -> tuple[int, int, int, int] | None:
    # Use a 3-frame guard band for constrained parabolic fitting.
    # This ensures we are clear of tracker center-snapping noise.
    guard = 3
    pre_end = collision_frame - guard
    pre_start = max(0, pre_end - pre_window)
    
    post_start = collision_frame + guard
    post_end = min(N, post_start + post_window)

    if pre_start >= pre_end or post_start >= post_end:
        return None

    for track in tracks:
        pre_non_nan = np.sum(~np.isnan(track.x_m[pre_start:pre_end]))
        post_non_nan = np.sum(~np.isnan(track.x_m[post_start:post_end]))
        # Need at least 4 points for a parabolic fit (x0, v0, a)
        if pre_non_nan < 4 or post_non_nan < 4:
            return None

    return pre_start, pre_end, post_start, post_end


def _detect_collision_by_proximity(
    tracks: list[MetricTrack],
    window_frames: int,
    pre_window: int,
    post_window: int,
) -> int | None:
    """
    For multi-ball planar captures, closest approach is a more reliable cue than
    delta-v when one ball starts from rest and the collision is relatively soft.
    """
    if len(tracks) < 2:
        return None

    N = len(tracks[0].x_m)
    distances = _pairwise_distances(tracks)
    valid = ~np.isnan(distances)
    if np.sum(valid) < 10:
        return None

    all_valid = np.ones(N, dtype=bool)
    for track in tracks:
        all_valid &= ~np.isnan(track.x_m) & ~np.isnan(track.y_m_raw)
    if not np.any(all_valid):
        return None

    search_start = int(np.argmax(all_valid)) + window_frames + 1
    if search_start >= N:
        return None

    search = distances.copy()
    search[:search_start] = np.inf
    search[~valid] = np.inf
    if not np.any(np.isfinite(search)):
        return None

    collision_frame = int(np.argmin(search))
    min_dist = float(distances[collision_frame])
    if min_dist > CONTACT_DISTANCE_M:
        return None

    baseline_end = min(search_start + 5, N)
    baseline = float(np.nanmedian(distances[search_start:baseline_end]))
    if baseline > 0.0 and min_dist > APPROACH_RATIO * baseline:
        return None

    if collision_frame <= search_start or collision_frame >= N - 1:
        return None

    prev_dist = distances[collision_frame - 1]
    next_dist = distances[collision_frame + 1]
    if np.isnan(prev_dist) or np.isnan(next_dist):
        return None
    if not (min_dist <= prev_dist and min_dist <= next_dist):
        return None

    if _windows_are_valid(tracks, collision_frame, pre_window, post_window, window_frames, N) is None:
        return None

    return collision_frame


def _detect_collision_by_delta_v(
    tracks: list[MetricTrack],
    per_ball_delta_v: list[np.ndarray],
    system_delta_v: np.ndarray,
    window_frames: int,
    threshold_factor: float,
    pre_window: int,
    post_window: int,
) -> int | None:
    N = len(tracks[0].x_m)
    valid_delta = system_delta_v[system_delta_v > 0.001]
    if len(valid_delta) < 5:
        return None

    median_delta = np.median(valid_delta)
    mad_delta = np.median(np.abs(valid_delta - median_delta))
    rolling_std_delta = 1.4826 * mad_delta
    threshold = max(threshold_factor * rolling_std_delta, 0.005)
    per_ball_threshold = max(threshold * 0.25, 0.002)

    candidates = np.where(system_delta_v > threshold)[0]
    if len(candidates) == 0:
        return None

    if len(tracks) >= 2:
        multi_ball_candidates = [
            idx
            for idx in candidates
            if sum(1 for ball_delta_v in per_ball_delta_v if ball_delta_v[idx] > per_ball_threshold) >= 2
        ]
        if multi_ball_candidates:
            candidates = np.array(multi_ball_candidates, dtype=int)
        else:
            return None

    collision_frame = int(candidates[np.argmax(system_delta_v[candidates])])
    if _windows_are_valid(tracks, collision_frame, pre_window, post_window, window_frames, N) is None:
        return None
    return collision_frame


def detect_system_collision(
    tracks: list[MetricTrack],
    window_frames: int = 5,
    threshold_factor: float = 5.0,
    pre_window: int = 15,
    post_window: int = 15
) -> CollisionResult:
    """
    Identify the collision frame from all ball tracks.

    Multi-ball experiments prefer closest-approach detection. Single-ball and
    fallback paths use rolling delta-v anomaly detection.
    """
    if not tracks:
        raise InsufficientDataError("No tracks provided for collision detection")

    N = len(tracks[0].x_m)
    primary_v_roll, per_ball_delta_v, system_delta_v = _compute_rolling_speeds(tracks, window_frames)

    collision_frame = -1
    pre_start, pre_end = 0, N
    post_start, post_end = 0, 0

    if len(tracks) >= 2:
        proximity_frame = _detect_collision_by_proximity(
            tracks,
            window_frames=window_frames,
            pre_window=pre_window,
            post_window=post_window,
        )
        if proximity_frame is not None:
            import logging
            logging.getLogger(__name__).info(f"Collision detected by PROXIMITY at frame {proximity_frame}")
            collision_frame = proximity_frame

    if collision_frame == -1:
        delta_frame = _detect_collision_by_delta_v(
            tracks,
            per_ball_delta_v=per_ball_delta_v,
            system_delta_v=system_delta_v,
            window_frames=window_frames,
            threshold_factor=threshold_factor,
            pre_window=pre_window,
            post_window=post_window,
        )
        if delta_frame is not None:
            import logging
            logging.getLogger(__name__).info(f"Collision detected by DELTA_V at frame {delta_frame}")
            collision_frame = delta_frame

    if collision_frame != -1:
        windows = _windows_are_valid(
            tracks,
            collision_frame,
            pre_window=pre_window,
            post_window=post_window,
            window_frames=window_frames,
            N=N,
        )
        if windows is None:
            collision_frame = -1
            pre_start, pre_end = 0, N
            post_start, post_end = 0, 0
        else:
            pre_start, pre_end, post_start, post_end = windows

    return CollisionResult(
        collision_frame=collision_frame,
        pre_start=pre_start,
        pre_end=pre_end,
        post_start=post_start,
        post_end=post_end,
        rolling_velocities=primary_v_roll
    )
