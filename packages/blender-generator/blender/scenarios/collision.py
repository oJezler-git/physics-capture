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
        board.scale = (0.4, 0.3, 1.0) # Slightly smaller for better fit
        board.data.materials.append(mat_checker)
        
        # Path: Spiraling from very close to cameras, staying within FOV
        for f in range(1, 101, 4):
            t = f / 100.0
            # Move from very close (y=-0.1) to mid-field (y=1.2)
            board.location.y = -0.1 + 1.3 * t
            # Horizontal sweep (wider closer to camera)
            board.location.x = 0.8 * math.sin(t * math.pi * 3) * (1 - 0.3 * t)
            # Vertical sweep: stay between 0.15 (table) and 0.7 (top of FOV)
            board.location.z = 0.25 + 0.2 * (1 - t) + 0.15 * math.cos(t * math.pi * 5)
            
            # Rotation (Zhang's method needs aggressive tilts)
            board.rotation_euler.x = math.radians(90 + 25 * math.cos(t * math.pi * 4))
            board.rotation_euler.y = math.radians(30 * math.sin(t * math.pi * 3))
            board.rotation_euler.z = math.radians(15 * math.sin(t * math.pi * 2))
            
            board.keyframe_insert(data_path="location", frame=f)
            board.keyframe_insert(data_path="rotation_euler", frame=f)

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
