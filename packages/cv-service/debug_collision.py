import sys
import warnings
from pathlib import Path

import numpy as np

sys.path.append("packages/cv-service")
warnings.filterwarnings("ignore")

from physics.collision import detect_system_collision
from physics.converter import convert_to_metric
from physics.loader import load_experiment_data
from physics.pipeline import _track_max_delta_v

experiment_dir = Path("packages/experiments/planar-final-prod-v2")
if not experiment_dir.exists():
    print(f"Experiment not found: {experiment_dir}")
    sys.exit(1)

loaded_tracks, scale = load_experiment_data(experiment_dir)
print(f"Scale: {scale.scale_px_per_mm:.4f} px/mm (unc={scale.scale_uncertainty_px_per_mm:.4f})")
metric_tracks = [convert_to_metric(t, scale) for t in loaded_tracks]

for mt in metric_tracks:
    mdv = _track_max_delta_v(mt)
    valid = ~np.isnan(mt.x_m)
    first = int(np.where(valid)[0][0]) if np.any(valid) else -1
    print(f"Ball {mt.ball_id}: first_valid={first}, max_delta_v={mdv:.5f} m/s")

result = detect_system_collision(metric_tracks)
print(f"\nDetected collision frame: {result.collision_frame}")
print(f"Pre window: [{result.pre_start}, {result.pre_end})")
print(f"Post window: [{result.post_start}, {result.post_end})")
