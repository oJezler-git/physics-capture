# packages/cv-service/physics/collision.py

import numpy as np
from dataclasses import dataclass
from .converter import MetricTrack
from .exceptions import InsufficientDataError, InsufficientWindowError

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
    window_frames: int = 2, # Smaller window for sharper jump detection
    threshold_factor: float = 5.0,
    pre_window: int = 7,
    post_window: int = 7
) -> CollisionResult:
    """
    Identify the collision frame and define pre/post windows using a rolling velocity estimator.
    """
    t_s = primary_track.t_s
    x_m = primary_track.x_m
    N = len(x_m)
    
    # 1. Rolling velocity estimate
    v_roll = np.full(N, np.nan, dtype=np.float64)
    
    for i in range(window_frames, N - window_frames):
        t_left  = t_s[i - window_frames]
        t_right = t_s[i + window_frames]
        x_left  = x_m[i - window_frames]
        x_right = x_m[i + window_frames]
        
        if not np.isnan(x_left) and not np.isnan(x_right):
            v_roll[i] = (x_right - x_left) / (t_right - t_left)
            
    # 2. Detect jumps
    delta_v = np.zeros(N)
    for i in range(window_frames + 1, N - window_frames):
        if not np.isnan(v_roll[i]) and not np.isnan(v_roll[i-1]):
            delta_v[i] = abs(v_roll[i] - v_roll[i-1])
            
    # 3. Robust anomaly detection on delta_v
    # Use only delta_v > 0 for stats
    valid_delta = delta_v[delta_v > 0]
    if len(valid_delta) < 5:
        if np.max(delta_v) > 0.01:
             valid_delta = delta_v
        else:
             return CollisionResult(-1, 0, N, 0, 0, v_roll)
             
    median_delta = np.median(delta_v)
    mad_delta = np.median(np.abs(delta_v - median_delta))
    rolling_std_delta = 1.4826 * mad_delta
    
    rolling_std_delta = max(rolling_std_delta, 1e-6)
    
    threshold = threshold_factor * rolling_std_delta
    candidates = np.where(delta_v > threshold)[0]
    
    if len(candidates) == 0:
        collision_frame = -1
        pre_start, pre_end = 0, N
        post_start, post_end = 0, 0
    else:
        # Pick the FIRST frame where we see a significant jump
        collision_frame = int(candidates[0])
        
        pre_start = max(0, collision_frame - pre_window)
        pre_end   = collision_frame
        post_start = collision_frame + (2 * window_frames) # Skip the transition zone
        post_end   = min(N, post_start + post_window)
        
        pre_non_nan = np.sum(~np.isnan(x_m[pre_start:pre_end]))
        post_non_nan = np.sum(~np.isnan(x_m[post_start:post_end]))
        
        if pre_non_nan < 4 or post_non_nan < 4:
             collision_frame = -1
             pre_start, pre_end = 0, N
             post_start, post_end = 0, 0
             
    return CollisionResult(
        collision_frame=collision_frame,
        pre_start=pre_start,
        pre_end=pre_end,
        post_start=post_start,
        post_end=post_end,
        rolling_velocities=v_roll
    )
