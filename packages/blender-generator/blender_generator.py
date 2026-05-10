import bpy
import os
import argparse
import sys

# Add current directory to path so we can import blender module
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from blender.core.render import render_scene, render_debug_single_frame
from blender.core.camera import setup_cameras
from blender.core.material import create_materials
from blender.scenarios.collision import CollisionScenario
from blender.sync import create_sync_marker, get_sync_handler
from blender.physics import bake_physics
from blender.export import extract_and_write_data


def _remove_if_exists(path):
    if os.path.exists(path):
        os.remove(path)

class Config:
    RESOLUTION_X = 1920
    RESOLUTION_Y = 1080
    TOTAL_FRAMES = int(os.getenv("BLENDER_TOTAL_FRAMES", "100"))
    FPS = 30
    BASELINE_M = 0.12 # 12cm baseline
    BALL_RADIUS = 0.033 # 66mm diameter
    EXP_ID = "synthetic-stereo-01"
    EXP_DIR = ""

def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--debug-single-frame', action='store_true', help='Render a single debug frame')
    parser.add_argument('--debug-frame', type=int, default=1, help='Frame index for debug')
    parser.add_argument('--debug-sequence', action='store_true', help='Render snapshots every 20 frames')
    parser.add_argument('--experiment-id', type=str, default="synthetic-stereo-01", help='Experiment ID')
    parser.add_argument(
        '--blind-pipeline',
        action='store_true',
        help='Do not export helper artifacts (tracks/intrinsics/extrinsics/sync/scale); keep only GT for evaluation.',
    )
    
    # Check if we are running from blender
    if "--" in sys.argv:
        args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    else:
        args = parser.parse_args([])

    config = Config()
    config.EXP_ID = args.experiment_id
    config.EXP_DIR = os.path.join(os.getcwd(), "packages", "experiments", config.EXP_ID)
    os.makedirs(config.EXP_DIR, exist_ok=True)
    print(f"Directories created at: {config.EXP_DIR}")

    if args.blind_pipeline:
        # Ensure no previously generated helper artifacts leak into blind runs.
        calib_dir = os.path.join(config.EXP_DIR, "calibration")
        results_dir = os.path.join(config.EXP_DIR, "results")
        for p in [
            os.path.join(calib_dir, "cam0_intrinsics.json"),
            os.path.join(calib_dir, "cam1_intrinsics.json"),
            os.path.join(calib_dir, "stereo_extrinsics.json"),
            os.path.join(results_dir, "tracks.json"),
            os.path.join(results_dir, "sync.json"),
            os.path.join(results_dir, "scale.json"),
            os.path.join(results_dir, "positions_3d.json"),
        ]:
            _remove_if_exists(p)

    clear_scene()
    
    # 1. Component Setup
    cam0, cam1 = setup_cameras(config)
    
    # 2. Scene Setup
    mat_table, mat_b0, mat_b1, mat_checker = create_materials()
    scenario = CollisionScenario(config)
    balls = scenario.setup_scene(mat_table, mat_b0, mat_b1, mat_checker)
    
    # 3. Sync Marker & Frame Handler Injection
    create_sync_marker() # Single global marker in the scene
    bpy.app.handlers.frame_change_pre.clear()
    bpy.app.handlers.frame_change_pre.append(get_sync_handler(config))
    
    # 4. Bake Physics (Must happen before extraction to ensure determinism)
    bake_physics(balls)
    
    # 5. Data Extraction
    # Blind mode keeps GT but withholds helper artifacts so the core pipeline
    # must infer calibration/sync/tracks from rendered data.
    extract_and_write_data(
        config,
        cam0,
        cam1,
        balls,
        include_pipeline_assistance=not args.blind_pipeline,
    )
    
    # 6. Render Path
    scene = bpy.context.scene
    if args.debug_single_frame:
        if args.debug_sequence:
            # We already baked above, so we can just render
            for f in range(scene.frame_start, scene.frame_end + 1, 20):
                render_debug_single_frame(config, cam0, cam1, frame_idx=f)
        else:
            render_debug_single_frame(config, cam0, cam1, frame_idx=args.debug_frame)
        print("\n--- Debug Render Completed ---")
    else:
        # Full production render
        render_scene(config, cam0, cam1)
        print(f"\n--- Synthetic Experiment Generation Completed Successfully ---")

if __name__ == "__main__":
    main()
