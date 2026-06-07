# packages/cv-service/physics/pipeline.py

import json
import logging
from pathlib import Path
from typing import List, Dict, Any, Optional
from uncertainties import ufloat, UFloat
import numpy as np

from .loader import load_experiment_data, load_experiment_data_multi, LoadedTrack, ScaleCalibration
from .converter import convert_to_metric, MetricTrack
from .collision import detect_collision, detect_system_collision, CollisionResult
from .fitting import fit_velocity_segment, FitResult, kinematic_model
from .momentum import compute_physics, compute_physics_2d, PhysicsOutput
from .triangulation import triangulate_loaded_tracks, triangulated_to_metric_track
from uncertainties.umath import sqrt as usqrt

logger = logging.getLogger(__name__)


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


def _track_max_delta_v(track: MetricTrack) -> float:
    """
    Return the maximum frame-to-frame rolling-velocity change for a track.
    Used to pick the ball with the strongest collision signal as the primary.
    """
    w = 2
    v = np.full(len(track.x_m), np.nan)
    for i in range(w, len(track.x_m) - w):
        xl, xr = track.x_m[i - w], track.x_m[i + w]
        tl, tr = track.t_s[i - w], track.t_s[i + w]
        if not np.isnan(xl) and not np.isnan(xr):
            v[i] = (xr - xl) / (tr - tl)
    valid = v[~np.isnan(v)]
    return float(np.max(np.abs(np.diff(valid)))) if len(valid) >= 2 else 0.0


def run_physics_pipeline(
    experiment_id: str,
    base_dir: Path,
    masses: List[Dict[str, float]],  # List of {"ball_id": int, "mass_g": float, "uncertainty_g": float}
    mode: str = "SINGLE_CAMERA_PLANAR",
    ke_mode: str = "rolling_sphere",
    friction_mode: str = "COMPENSATE"
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
        frame_count = max((len(track.timestamps_ms) for track in loaded_tracks), default=0)
        frames = []
        for frame_idx in range(frame_count):
            frame_entry = {"frame": frame_idx, "balls": []}
            for track in loaded_tracks:
                if frame_idx >= len(track.x_px):
                    continue
                x_px = track.x_px[frame_idx]
                y_px = track.y_px[frame_idx]
                if np.isnan(x_px) or np.isnan(y_px):
                    continue
                valid_mask = ~np.isnan(track.x_px) & ~np.isnan(track.y_px)
                if not np.any(valid_mask):
                    continue
                first_idx = int(np.where(valid_mask)[0][0])
                x_m = float((x_px - track.x_px[first_idx]) / scale.scale_px_per_mm / 1000.0)
                z_m = float((y_px - track.y_px[first_idx]) / scale.scale_px_per_mm / 1000.0)
                frame_entry["balls"].append(
                    {
                        "ball_id": track.ball_id,
                        "x_m": x_m,
                        "y_m": 0.0,
                        "z_m": z_m,
                        "x_unc_m": 0.001,
                        "y_unc_m": 0.0,
                        "z_unc_m": 0.001,
                        "flagged": bool(track.confidence[frame_idx] < 0.7),
                    }
                )
            frames.append(frame_entry)
        positions_3d_data = {
            "experiment_id": experiment_id,
            "coordinate_system": "single_camera_planar_xz",
            "units": "metres",
            "frames": frames,
        }

    # 3. Detect collision — combine signals from all balls to find the system event.
    # This correctly favors the collision (where multiple balls move) over
    # a single ball's start-of-motion.
    collision = detect_system_collision(metric_tracks)

    # 4. Fit segments
    ball_fits = []
    v_before_vecs = []
    v_after_vecs = []

    for track in metric_tracks:
        # We must fit BOTH dimensions to handle deflections in grazing collisions.
        # Otherwise, momentum 'disappears' in the UI.
        
        # Fit X component
        fit_x_pre = fit_velocity_segment(
            track.t_s[collision.pre_start:collision.pre_end],
            track.x_m[collision.pre_start:collision.pre_end],
            track.sigma_x_m[collision.pre_start:collision.pre_end]
        )
        # Fit Y component
        fit_y_pre = fit_velocity_segment(
            track.t_s[collision.pre_start:collision.pre_end],
            track.y_m_raw[collision.pre_start:collision.pre_end],
            track.sigma_x_m[collision.pre_start:collision.pre_end] # Use same sigma
        )

        # Post-collision fits
        fit_x_post = None
        fit_y_post = None
        if collision.collision_frame != -1:
            fit_x_post = fit_velocity_segment(
                track.t_s[collision.post_start:collision.post_end],
                track.x_m[collision.post_start:collision.post_end],
                track.sigma_x_m[collision.post_start:collision.post_end]
            )
            fit_y_post = fit_velocity_segment(
                track.t_s[collision.post_start:collision.post_end],
                track.y_m_raw[collision.post_start:collision.post_end],
                track.sigma_x_m[collision.post_start:collision.post_end]
            )

        # Velocity Extrapolation to EXACT collision instant
        t_collision = track.t_s[collision.collision_frame] if collision.collision_frame != -1 else 0
        
        # Zero-Velocity Damping: 
        # If a ball is effectively stationary before impact (<0.005 m/s), 
        # force its PRE velocity to zero to remove jitter from CoR projection.
        from dataclasses import replace
        v_pre_raw_mag = usqrt(fit_x_pre.v0**2 + fit_y_pre.v0**2).nominal_value
        if v_pre_raw_mag < 0.010:
            fit_x_pre = replace(fit_x_pre, v0=ufloat(0, 1e-6), a=ufloat(0, 1e-6))
            fit_y_pre = replace(fit_y_pre, v0=ufloat(0, 1e-6), a=ufloat(0, 1e-6))
            logger.info(f"  Ball {track.ball_id}: Pre-collision velocity damped to zero (stationary detected).")

        logger.info(f"Ball {track.ball_id} Fit Diagnostics:")
        logger.info(f"  Pre-window:  [{collision.pre_start}:{collision.pre_end}]")
        logger.info(f"  Post-window: [{collision.post_start}:{collision.post_end}]")
        
        # Helper to get extrapolated vector
        def get_v_vec(fx, fy, t_eval, t_ref_start, t_ref_end, label):
            dt_to_collision = t_eval - t_ref_end
            
            if friction_mode == "COMPENSATE":
                # Full kinematic extrapolation: v(t) = v0 + a*t
                dt_window_width = t_ref_end - t_ref_start
                vx_at_end = fx.v0 + fx.a * dt_window_width
                vy_at_end = fy.v0 + fy.a * dt_window_width
                vx = vx_at_end + fx.a * dt_to_collision
                vy = vy_at_end + fy.a * dt_to_collision
                logger.info(f"    {label} extrapolation (COMPENSATE, dt={dt_to_collision:.3f}s):")
            else:
                # Constant velocity
                vx = fx.v0
                vy = fy.v0
                logger.info(f"    {label} extrapolation (LINEAR_ONLY):")
            
            logger.info(f"      vx: {vx.nominal_value:.4f}, vy: {vy.nominal_value:.4f}")
            return (vx, vy)


        vb_vec = get_v_vec(
            fit_x_pre, fit_y_pre, 
            t_collision, 
            track.t_s[collision.pre_start], 
            track.t_s[collision.pre_end-1], 
            "PRE"
        )
        
        if fit_x_post and fit_y_post:
            va_vec = get_v_vec(
                fit_x_post, fit_y_post, 
                t_collision, 
                track.t_s[collision.post_start], 
                track.t_s[collision.post_start], # For POST, start is the closest edge
                "POST"
            )
        else:
            # Use tiny std_dev to avoid UserWarning: Using UFloat objects with std_dev==0
            va_vec = (ufloat(0, 1e-6), ufloat(0, 1e-6))
            logger.info("    POST: No fit available.")

        v_before_vecs.append(vb_vec)
        v_after_vecs.append(va_vec)

        # Magnitudes for legacy compatibility and per-ball display
        v_at_collision_before = usqrt(vb_vec[0]**2 + vb_vec[1]**2)
        v_at_collision_after = usqrt(va_vec[0]**2 + va_vec[1]**2)

        ball_fits.append({
            "ball_id": track.ball_id,
            "pre_fit": fit_x_pre, # Keep X fit for diagnostics/UI backward compat
            "post_fit": fit_x_post,
            "v_before": v_at_collision_before,
            "v_after": v_at_collision_after if fit_x_post else None
        })

    # 5. Compute physics
    mass_ufloats = []
    for track in metric_tracks:
        m_data = next((m for m in masses if m["ball_id"] == track.ball_id), None)
        if m_data is None:
            logger.warning(f"No mass provided for ball {track.ball_id}. Using default 50g (0.05kg).")
            logger.info("  Note: If your simulation uses 5g, System KE will appear 10x too high in the UI.")
            m_data = {"mass_g": 50.0, "uncertainty_g": 1.0}
        mass_ufloats.append(ufloat(m_data["mass_g"] / 1000.0, m_data["uncertainty_g"] / 1000.0))

    # Positions at impact for Projected CoR
    pos_at_col = []
    if collision.collision_frame != -1:
        for track in metric_tracks:
            px = float(track.x_m[collision.collision_frame])
            py = float(track.y_m_raw[collision.collision_frame])
            pos_at_col.append((px, py))

    physics_results = compute_physics_2d(
        mass_ufloats, 
        v_before_vecs, 
        v_after_vecs, 
        positions_at_collision=pos_at_col if len(pos_at_col) == 2 else None,
        ke_mode=ke_mode
    )

    # 6. Build output JSON structure
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

    momentum_data = {
        "experiment_id": experiment_id,
        "ke_mode": ke_mode,
        "n_balls": len(metric_tracks),
        "per_ball": [],
        "system": {
            "p_before": ufloat_to_dict(physics_results.p_before_total, "p_before", "kgmps"),
            "p_after": ufloat_to_dict(physics_results.p_after_total, "p_after", "kgmps"),
            "conservation_pct": ufloat_to_dict(physics_results.conservation_pct, "conservation_pct", "pct") if physics_results.conservation_pct is not None else None,
            "ke_before": ufloat_to_dict(physics_results.ke_before_total, "ke_before", "J"),
            "ke_after": ufloat_to_dict(physics_results.ke_after_total, "ke_after", "J"),
            "cor": ufloat_to_dict(physics_results.cor, "cor", "") if physics_results.cor is not None else None
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
