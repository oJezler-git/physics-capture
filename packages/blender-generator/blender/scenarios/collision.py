import bpy
import math
from blender.scenarios.base import BaseScenario

class CollisionScenario(BaseScenario):
    def setup_scene(self, mat_table, mat_b0, mat_b1, mat_checker):
        self.setup_common(mat_table)
        
        # Calibration Board Animation (Zhang's Method)
        # Coverage is key: different depths, tilts, and covering the corners.
        bpy.ops.mesh.primitive_plane_add(size=1.0)
        board = bpy.context.active_object
        board.name = "CalibrationBoard"
        # Match CV expectation exactly: 8x6 inner corners => 9x7 squares.
        # Keep each square physically square (25 mm) so the board is not warped.
        square_size_m = 0.025
        board_width_m = 9 * square_size_m
        board_height_m = 7 * square_size_m
        board.scale = (board_width_m, board_height_m, 1.0)
        board.data.materials.append(mat_checker)
        
        # Stable in-FOV calibration sweep (less extreme than previous spiral).
        x_vals = [-0.22, 0.0, 0.22]
        y_vals = [0.45, 0.75, 1.05]
        z_vals = [0.18, 0.30, 0.42]
        frame = 1
        for y in y_vals:
            for z in z_vals:
                for x in x_vals:
                    board.location.x = x
                    board.location.y = y
                    board.location.z = z
                    # Moderate pose variation for Zhang calibration, while keeping visibility.
                    board.rotation_euler.x = math.radians(90 + 12 * math.sin(frame * 0.2))
                    board.rotation_euler.y = math.radians(10 * math.cos(frame * 0.15))
                    board.rotation_euler.z = math.radians(8 * math.sin(frame * 0.1))
                    board.keyframe_insert(data_path="location", frame=frame)
                    board.keyframe_insert(data_path="rotation_euler", frame=frame)
                    frame += 3

        # Move it out of the way after frame 100
        board.location.y = 10.0 
        board.keyframe_insert(data_path="location", frame=101)

        # Ball Setup: Blue rolls in, Red is stationary at the center
        for i, (mat, start_x, vel_x) in enumerate([
            (mat_b0, -0.8, 0.6), # Rolling Blue Ball
            (mat_b1, 0.0,  0.0)  # Stationary Red Ball
        ]):
            bpy.ops.mesh.primitive_uv_sphere_add(radius=self.config.BALL_RADIUS)
            b = bpy.context.active_object
            b.name = f"Ball{i}"
            b.data.materials.append(mat)
            bpy.ops.rigidbody.object_add()
            
            b.rigid_body.collision_shape = 'SPHERE'
            b.rigid_body.mass = 0.17 # Standard billiard ball (170g)
            b.rigid_body.friction = 0.05
            b.rigid_body.restitution = 0.95
            b.rigid_body.use_deactivation = False # Never sleep
            b.rigid_body.use_margin = True
            b.rigid_body.collision_margin = 0.001 # Tight collision
            
            # --- Robust Kinematic Handover ---
            # We release them at frame 101 (after calibration is done)
            b.rigid_body.kinematic = True
            b.keyframe_insert(data_path="rigid_body.kinematic", frame=1)
            
            # Use a slightly elevated position to avoid initial table friction/jitter
            start_z = self.config.BALL_RADIUS + 0.001 
            
            # Initial static position
            b.location = (start_x, 0.0, start_z)
            b.keyframe_insert(data_path="location", frame=100)
            
            # Position at frame 101 (creating the 'kick' velocity)
            # v = d / t -> d = v * t (t = 1/FPS)
            dt = 1.0 / self.config.FPS
            b.location = (start_x + vel_x * dt, 0.0, start_z)
            b.keyframe_insert(data_path="location", frame=101)
            
            # Ensure Linear interpolation for the kick (crucial for velocity handover)
            if b.animation_data and b.animation_data.action:
                for fcurve in b.animation_data.action.fcurves:
                    for kp in fcurve.keyframe_points:
                        kp.interpolation = 'LINEAR'

            # Handover to physics at frame 102
            # (Stay kinematic at 101 to ensure the move from 100->101 is registered as kinematic velocity)
            b.keyframe_insert(data_path="rigid_body.kinematic", frame=101)
            b.rigid_body.kinematic = False
            b.keyframe_insert(data_path="rigid_body.kinematic", frame=102)
            
            self.balls.append(b)

        return self.balls
