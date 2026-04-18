# packages/cv-service/physics/converter.py

import numpy as np
from dataclasses import dataclass
from .loader import LoadedTrack, ScaleCalibration
from .exceptions import InsufficientDataError

@dataclass
class MetricTrack:
    ball_id:       int
    t_s:           np.ndarray   # float64, shape [N] — seconds
    x_m:           np.ndarray   # float64, shape [N] — metres; NaN if frame missing
    sigma_x_m:     np.ndarray   # float64, shape [N] — position uncertainty in metres

def convert_to_metric(
    track: LoadedTrack,
    scale: ScaleCalibration,
    position_sigma_px: float = 0.3
) -> MetricTrack:
    """
    Convert pixel coordinates to metres; attach timestamps in seconds;
    compute per-point position uncertainty in metres.
    Projects to 1D using the axis of maximum variance.
    """
    # 1. Convert timestamps to seconds
    t_s = track.timestamps_ms / 1000.0
    
    # 2. Filter non-NaN frames for variance calculation
    mask = ~np.isnan(track.x_px)
    if np.sum(mask) < 2:
        raise InsufficientDataError(f"Ball {track.ball_id} has less than 2 valid frames")
        
    x_px_valid = track.x_px[mask]
    y_px_valid = track.y_px[mask]
    
    # 3. Determine primary axis of motion (max variance)
    var_x = np.var(x_px_valid)
    var_y = np.var(y_px_valid)
    
    if var_x >= var_y:
        p_px = track.x_px
    else:
        p_px = track.y_px
        
    # 4. Convert to metres
    # x_mm = x_px / scale_px_per_mm
    # x_m = x_mm / 1000.0
    p_m = p_px / scale.scale_px_per_mm / 1000.0
    
    # 5. Position uncertainty propagation (Step 2.2 in plan)
    # sigma_x_mm = sqrt( (sigma_x_px / scale_px_per_mm)^2
    #                  + (x_px * scale_unc_px_per_mm / scale_px_per_mm^2)^2 )
    
    sigma_p_mm = np.sqrt(
        (position_sigma_px / scale.scale_px_per_mm)**2 +
        (p_px * scale.scale_uncertainty_px_per_mm / (scale.scale_px_per_mm**2))**2
    )
    sigma_p_m = sigma_p_mm / 1000.0
    
    return MetricTrack(
        ball_id=track.ball_id,
        t_s=t_s,
        x_m=p_m,
        sigma_x_m=sigma_p_m
    )
