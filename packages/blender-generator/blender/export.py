import bpy
import json
import os
import numpy as np
import bpy_extras
from blender.core.camera import get_cv_matrix


def extract_and_write_data(config, cam0, cam1, balls, include_pipeline_assistance=True):
    scene = bpy.context.scene
    track_data = {}
    gt_frames = []
    timestamps = []
    
    for frame in range(scene.frame_start, scene.frame_end + 1):
        scene.frame_set(frame)
        t_s = (frame - 1) / config.FPS
        timestamps.append(float(t_s * 1000.0))
        frame_gt = {"frame": frame - 1, "balls": []}
        
        for ball in balls:
            ball_id = int(ball.name.replace("Ball", ""))
            pos = ball.matrix_world.translation
            
            # True 3D coordinate defined entirely in the coordinate system of Cam0 OpenCV
            pos_cv0 = get_cv_matrix(cam0) @ pos
            frame_gt["balls"].append({
                "ball_id": ball_id,
                "x_m": float(pos_cv0.x),
                "y_m": float(pos_cv0.y),
                "z_m": float(pos_cv0.z)
            })
            
            if include_pipeline_assistance:
                # Projected 2D screen coordinates
                cams = [cam0] if cam1 is None else [cam0, cam1]
                for cam_id, cam in enumerate(cams):
                    co2d = bpy_extras.object_utils.world_to_camera_view(scene, cam, pos)
                    if co2d.z > 0 and 0 <= co2d.x <= 1 and 0 <= co2d.y <= 1:
                        if (cam_id, ball_id) not in track_data:
                            track_data[(cam_id, ball_id)] = []

                        track_data[(cam_id, ball_id)].append({
                            "frame_idx": frame - 1,
                            "x_px": float(co2d.x * config.RESOLUTION_X),
                            "y_px": float((1.0 - co2d.y) * config.RESOLUTION_Y),
                            "confidence": 1.0
                        })
        gt_frames.append(frame_gt)
        
    # --- Write JSON Payload Exports ---
    results_dir = os.path.join(config.EXP_DIR, "results")
    calib_dir = os.path.join(config.EXP_DIR, "calibration")
    os.makedirs(results_dir, exist_ok=True)
    os.makedirs(calib_dir, exist_ok=True)
    
    # positions_3d_gt.json
    with open(os.path.join(results_dir, "positions_3d_gt.json"), "w") as f:
        json.dump({"experiment_id": config.EXP_ID, "units": "metres", "frames": gt_frames}, f, indent=2)
        
    if include_pipeline_assistance:
        # tracks.json
        tracks_payload = {"experiment_id": config.EXP_ID, "balls": []}
        for (cam_id, ball_id), frames in track_data.items():
            tracks_payload["balls"].append({"ball_id": ball_id, "camera_id": cam_id, "frames": frames})
        with open(os.path.join(results_dir, "tracks.json"), "w") as f:
            json.dump(tracks_payload, f, indent=2)

        # sync.json
        sync_payload = {
            "schema_version": "1.0", "experiment_id": config.EXP_ID, "is_mock": False,
            "cameras": {
                "cam0": {
                    "frame_count": config.TOTAL_FRAMES, "true_fps": config.FPS, "phase_offset_ms": 0.0,
                    "fit_residual_rms_ms": 0.7, "timestamps_ms": timestamps
                },
            }
        }
        if cam1 is not None:
            sync_payload["cameras"]["cam1"] = {
                "frame_count": config.TOTAL_FRAMES, "true_fps": config.FPS, "phase_offset_ms": 0.3,
                "fit_residual_rms_ms": 0.8, "timestamps_ms": [float(t + 0.3) for t in timestamps]
            }

        with open(os.path.join(results_dir, "sync.json"), "w") as f:
            json.dump(sync_payload, f, indent=2)

        # scale.json
        with open(os.path.join(results_dir, "scale.json"), "w") as f:
            json.dump({"px_per_mm": 1.8, "scale_uncertainty_px_per_mm": 0.01}, f, indent=2)

        # Intrinsics
        for cam in cams:
            f_mm, sensor_w = cam.data.lens, cam.data.sensor_width
            fx = f_mm * config.RESOLUTION_X / sensor_w
            cx, cy = config.RESOLUTION_X / 2.0, config.RESOLUTION_Y / 2.0
            intr_payload = {
                "camera_id": int(cam.name[-1]), "image_size": [config.RESOLUTION_X, config.RESOLUTION_Y],
                "fx": fx, "fy": fx, "cx": cx, "cy": cy,
                # Synthetic Blender projection is generated in an ideal pinhole space.
                # Keep distortion coefficients at zero so downstream undistortion does not
                # bend already-undistorted tracks.
                "k1": 0.0, "k2": 0.0, "p1": 0.0, "p2": 0.0, "k3": 0.0,
                "reprojection_error_px": 0.0, "scale_px_per_mm": None, "scale_uncertainty_px_per_mm": None
            }
            with open(os.path.join(calib_dir, f"{cam.name}_intrinsics.json"), "w") as f:
                json.dump(intr_payload, f, indent=2)

        if cam1 is not None:
            # Stereo Extrinsics
            M_cv0 = get_cv_matrix(cam0)
            M_cv1 = get_cv_matrix(cam1)
            E = M_cv1 @ M_cv0.inverted()  # Transform CV frame 0 -> CV frame 1

            R = E.to_3x3()
            T = E.to_translation() * 1000.0  # Output metric expects Baseline in mm

            K = np.array([[fx, 0, cx], [0, fx, cy], [0, 0, 1]])
            P0 = K @ np.hstack([np.eye(3), np.zeros((3, 1))])
            P1 = K @ np.hstack([np.array(R), np.array(T).reshape(3, 1)])

            stereo_payload = {
                "R": [list(float(c) for c in row) for row in R],
                "T": [float(c) for c in T],
                "E": np.zeros((3, 3)).tolist(), "F": np.zeros((3, 3)).tolist(),
                "P0": P0.tolist(), "P1": P1.tolist(),
                "reprojection_error_px": 0.0,
                "baseline_mm": float(T.length)
            }
            with open(os.path.join(calib_dir, "stereo_extrinsics.json"), "w") as f:
                json.dump(stereo_payload, f, indent=2)
