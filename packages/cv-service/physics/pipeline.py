# packages/cv-service/physics/pipeline.py

import json
from pathlib import Path
from typing import List, Dict, Any, Optional
from uncertainties import ufloat, UFloat
import numpy as np

from .loader import load_experiment_data, load_experiment_data_multi, LoadedTrack, ScaleCalibration
from .converter import convert_to_metric, MetricTrack
from .collision import detect_collision, CollisionResult
from .fitting import fit_velocity_segment, FitResult, kinematic_model
from .momentum import compute_physics, PhysicsOutput
from .triangulation import triangulate_loaded_tracks, triangulated_to_metric_track

def ufloat_to_dict(u: Optional[UFloat], key_stem: str, unit: str) -> dict:
    suffix = f"_{unit}" if unit else ""
    if u is None:
        return {
            f"value{suffix}": None,
            f"uncertainty{suffix}": None
        }
    return {
        f"value{suffix}": float(u.nominal_value),
        f"uncertainty{suffix}": float(u.std_dev)
    }

def run_physics_pipeline(
    experiment_id: str,
    base_dir: Path,
    masses: List[Dict[str, float]],  # List of {"ball_id": int, "mass_g": float, "uncertainty_g": float}
    mode: str = "SINGLE_CAMERA_PLANAR",
    ke_mode: str = "rolling_sphere",
    friction_mode: str = "IGNORE"
) -> Dict[str, Any]:
    """
    Full physics analysis pipeline.
    """
    experiment_dir = base_dir / experiment_id
    
    # 1. Load data
    positions_3d_data: Optional[Dict[str, Any]] = None
    if mode == "STEREO_3D":
        tracks_by_camera, _ = load_experiment_data_multi(experiment_dir, ["cam0", "cam1"])
        cam0_by_ball = {track.ball_id: track for track in tracks_by_camera.get("cam0", [])}
        cam1_by_ball = {track.ball_id: track for track in tracks_by_camera.get("cam1", [])}
        common_ball_ids = sorted(set(cam0_by_ball.keys()) & set(cam1_by_ball.keys()))
        if not common_ball_ids:
            raise ValueError(
                "No overlapping ball IDs across cam0/cam1 for stereo mode. "
                f"cam0_ball_ids={sorted(cam0_by_ball.keys())}, "
                f"cam1_ball_ids={sorted(cam1_by_ball.keys())}. "
                "Run stereo tracking with matching ball IDs seeded on both cameras."
            )
        tri_tracks = []
        metric_tracks = []
        for ball_id in common_ball_ids:
            tri_track = triangulate_loaded_tracks(
                experiment_dir=experiment_dir,
                cam0_track=cam0_by_ball[ball_id],
                cam1_track=cam1_by_ball[ball_id],
            )
            tri_tracks.append(tri_track)
            metric_tracks.append(triangulated_to_metric_track(tri_track))
        frame_count = max((track.xyz_m.shape[0] for track in tri_tracks), default=0)
        frames = []
        for frame_idx in range(frame_count):
            frame_entry = {"frame": frame_idx, "balls": []}
            for tri_track in tri_tracks:
                if frame_idx >= tri_track.xyz_m.shape[0]:
                    continue
                xyz = tri_track.xyz_m[frame_idx]
                if np.isnan(xyz).any():
                    continue
                frame_entry["balls"].append(
                    {
                        "ball_id": tri_track.ball_id,
                        "x_m": float(xyz[0]),
                        "y_m": float(xyz[1]),
                        "z_m": float(xyz[2]),
                        "x_unc_m": 0.001,
                        "y_unc_m": 0.001,
                        "z_unc_m": 0.002,
                        "flagged": False,
                    }
                )
            frames.append(frame_entry)
        positions_3d_data = {
            "experiment_id": experiment_id,
            "coordinate_system": "cam0_origin_right_handed_y_up",
            "units": "metres",
            "frames": frames,
        }
    else:
        loaded_tracks, scale = load_experiment_data(experiment_dir)
        metric_tracks = [convert_to_metric(t, scale) for t in loaded_tracks]
    
    # 3. Detect collision (using ball 0 as primary)
    primary_track = next((t for t in metric_tracks if t.ball_id == 0), metric_tracks[0])
    collision = detect_collision(primary_track)
    
    # 4. Fit segments
    ball_fits = []
    v_before = []
    v_after = []
    
    for track in metric_tracks:
        # Pre-collision fit
        pre_fit = fit_velocity_segment(
            track.t_s[collision.pre_start:collision.pre_end],
            track.x_m[collision.pre_start:collision.pre_end],
            track.sigma_x_m[collision.pre_start:collision.pre_end]
        )
        
        # Post-collision fit
        if collision.collision_frame != -1:
            post_fit = fit_velocity_segment(
                track.t_s[collision.post_start:collision.post_end],
                track.x_m[collision.post_start:collision.post_end],
                track.sigma_x_m[collision.post_start:collision.post_end]
            )
        else:
            post_fit = None
            
        # Friction compensation (Step 5 in plan)
        v_at_collision_before = pre_fit.v0
        if friction_mode == "COMPENSATE" and collision.collision_frame != -1:
             t_collision = track.t_s[collision.collision_frame]
             t_start_pre = track.t_s[collision.pre_start]
             dt = t_collision - t_start_pre
             # extrapolated velocity at collision instant: v(t) = v0 + a*t
             v_at_collision_before = pre_fit.v0 + pre_fit.a * dt
             
        v_before.append(v_at_collision_before)
        
        v_at_collision_after = None
        if post_fit:
            v_at_collision_after = post_fit.v0
            v_after.append(v_at_collision_after)
        else:
            v_after.append(ufloat(0, 0)) # Placeholder for no-collision case
            
        ball_fits.append({
            "ball_id": track.ball_id,
            "pre_fit": pre_fit,
            "post_fit": post_fit,
            "v_before": v_at_collision_before,
            "v_after": v_at_collision_after
        })

    # 5. Compute physics
    # Align masses with metric_tracks
    mass_ufloats = []
    for track in metric_tracks:
        m_data = next((m for m in masses if m["ball_id"] == track.ball_id), {"mass_g": 50.0, "uncertainty_g": 1.0})
        mass_ufloats.append(ufloat(m_data["mass_g"]/1000.0, m_data["uncertainty_g"]/1000.0))
        
    physics_results = compute_physics(mass_ufloats, v_before, v_after, ke_mode=ke_mode)
    
    # 6. Build output JSON structure
    # velocities.json
    velocities_data = {
        "experiment_id": experiment_id,
        "collision_frame": collision.collision_frame,
        "balls": []
    }
    for i, fit in enumerate(ball_fits):
        ball_entry = {
            "ball_id": fit["ball_id"],
            "v_before": ufloat_to_dict(fit["v_before"], "v_before", "mps"),
            "v_after": ufloat_to_dict(fit["v_after"], "v_after", "mps"),
            "friction_a": ufloat_to_dict(fit["pre_fit"].a, "friction_a", "mps2"),
            "fit_diagnostics": {
                "pre_window_frames": [collision.pre_start, collision.pre_end],
                "post_window_frames": [collision.post_start, collision.post_end] if fit["post_fit"] else None,
                "pre_chi2_reduced": float(fit["pre_fit"].chi2_reduced),
                "post_chi2_reduced": float(fit["post_fit"].chi2_reduced) if fit["post_fit"] else None,
                "pre_dof": int(fit["pre_fit"].dof),
                "post_dof": int(fit["post_fit"].dof) if fit["post_fit"] else None
            }
        }
        velocities_data["balls"].append(ball_entry)
        
    # momentum.json
    momentum_data = {
        "experiment_id": experiment_id,
        "ke_mode": ke_mode,
        "n_balls": len(metric_tracks),
        "per_ball": [],
        "system": {
            "p_before": ufloat_to_dict(physics_results.p_before_total, "p_before", "kgmps"),
            "p_after": ufloat_to_dict(physics_results.p_after_total, "p_after", "kgmps"),
            "conservation_pct": ufloat_to_dict(physics_results.conservation_pct, "conservation_pct", "pct") if physics_results.conservation_pct else None,
            "ke_before": ufloat_to_dict(physics_results.ke_before_total, "ke_before", "J"),
            "ke_after": ufloat_to_dict(physics_results.ke_after_total, "ke_after", "J"),
            "cor": ufloat_to_dict(physics_results.cor, "cor", "") if physics_results.cor else None
        }
    }
    for i in range(len(metric_tracks)):
        ball_entry = {
            "ball_id": metric_tracks[i].ball_id,
            "p_before": ufloat_to_dict(physics_results.p_before_per_ball[i], "p_before", "kgmps"),
            "p_after": ufloat_to_dict(physics_results.p_after_per_ball[i], "p_after", "kgmps"),
            "ke_before": ufloat_to_dict(physics_results.ke_before_per_ball[i], "ke_before", "J"),
            "ke_after": ufloat_to_dict(physics_results.ke_after_per_ball[i], "ke_after", "J")
        }
        momentum_data["per_ball"].append(ball_entry)
        
    # 7. Write to disk
    results_dir = experiment_dir / "results"
    results_dir.mkdir(parents=True, exist_ok=True)
    with open(results_dir / "velocities.json", 'w') as f:
        json.dump(velocities_data, f, indent=2)
    with open(results_dir / "momentum.json", 'w') as f:
        json.dump(momentum_data, f, indent=2)
    if positions_3d_data is not None:
        with open(results_dir / "positions_3d.json", "w") as f:
            json.dump(positions_3d_data, f, indent=2)
        
    return {
        "velocities": velocities_data,
        "momentum": momentum_data,
        "positions_3d": positions_3d_data,
    }
