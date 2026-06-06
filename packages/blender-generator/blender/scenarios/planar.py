import bpy
import math
from blender.scenarios.base import BaseScenario

class PlanarScenario(BaseScenario):
    def setup_scene(self, mat_table, mat_b0, mat_b1, mat_checker):
        self.setup_common(mat_table)
        
        # Ruler Setup (Scale Reference)
        # 10cm ruler in the middle of the table
        bpy.ops.mesh.primitive_plane_add(size=1.0)
        ruler = bpy.context.active_object
        ruler.name = "Ruler"
        ruler.scale = (0.1, 0.02, 1.0) # 10cm x 2cm
        ruler.location = (0.0, -0.1, 0.001) # Slightly above table
        
        # Create a simple ruler material
        mat_ruler = bpy.data.materials.new("Ruler")
        mat_ruler.use_nodes = True
        bsdf = mat_ruler.node_tree.nodes["Principled BSDF"]
        bsdf.inputs['Base Color'].default_value = (0.8, 0.6, 0.01, 1.0) # Safety Yellow
        ruler.data.materials.append(mat_ruler)
        
        # Add black ticks to the ruler using a texture
        self._add_ticks_to_ruler(mat_ruler)

        # Ball Setup: One stationary center, one moving off-center
        ball_radius = 0.005 # 5mm radius
        
        # Stationary Ball (Red, center)
        for i, (mat, pos_x, pos_y, vel_x, vel_y) in enumerate([
            (mat_b1, 0.0, 0.0, 0.0, 0.0),      # Stationary Red ball
            (mat_b0, -0.2, 0.007, 0.2, 0.0)    # Moving Blue ball, grazing collision
        ]):
            bpy.ops.mesh.primitive_uv_sphere_add(radius=ball_radius)
            b = bpy.context.active_object
            b.name = f"Ball{i}"
            b.data.materials.append(mat)
            bpy.ops.rigidbody.object_add()
            
            b.rigid_body.collision_shape = 'SPHERE'
            b.rigid_body.mass = 0.005 # 5g
            b.rigid_body.friction = 0.01 # Very low friction for clean collision
            b.rigid_body.restitution = 0.9 # High bounciness
            b.rigid_body.use_deactivation = False
            b.rigid_body.use_margin = True
            b.rigid_body.collision_margin = 0.0001
            
            b.rigid_body.kinematic = True
            b.keyframe_insert(data_path="rigid_body.kinematic", frame=1)
            
            start_z = ball_radius + 0.0001
            b.location = (pos_x, pos_y, start_z)
            b.keyframe_insert(data_path="location", frame=10)
            
            # Apply velocity if not stationary
            if vel_x != 0 or vel_y != 0:
                dt = 1.0 / self.config.FPS
                b.location = (pos_x + vel_x * dt, pos_y + vel_y * dt, start_z)
                b.keyframe_insert(data_path="location", frame=11)
                
                # Ensure Linear interpolation for the kick
                if b.animation_data and b.animation_data.action:
                    for fcurve in b.animation_data.action.fcurves:
                        for kp in fcurve.keyframe_points:
                            kp.interpolation = 'LINEAR'
                
                b.keyframe_insert(data_path="rigid_body.kinematic", frame=11)
                b.rigid_body.kinematic = False
                b.keyframe_insert(data_path="rigid_body.kinematic", frame=12)
            else:
                # Stationary ball: ensure it becomes dynamic at frame 12 so it can react to collision
                b.keyframe_insert(data_path="rigid_body.kinematic", frame=11)
                b.rigid_body.kinematic = False
                b.keyframe_insert(data_path="rigid_body.kinematic", frame=12)
            
            self.balls.append(b)

        return self.balls

    def _add_ticks_to_ruler(self, mat):
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        bsdf = nodes["Principled BSDF"]
        
        tex_coord = nodes.new("ShaderNodeTexCoord")
        mapping = nodes.new("ShaderNodeMapping")
        
        # 10 ticks for 10cm
        wave = nodes.new("ShaderNodeTexWave")
        wave.wave_type = 'BANDS'
        wave.inputs['Scale'].default_value = 62.8 # ~10 cycles for UV 0-1
        wave.inputs['Distortion'].default_value = 0
        wave.inputs['Detail'].default_value = 0
        
        math_node = nodes.new("ShaderNodeMath")
        math_node.operation = 'GREATER_THAN'
        math_node.inputs[1].default_value = 0.5
        
        links.new(tex_coord.outputs["UV"], mapping.inputs["Vector"])
        links.new(mapping.outputs["Vector"], wave.inputs["Vector"])
        links.new(wave.outputs["Color"], math_node.inputs[0])
        
        mix = nodes.new("ShaderNodeMixRGB")
        mix.inputs['Color1'].default_value = (0.8, 0.6, 0.01, 1.0) # Safety Yellow
        mix.inputs['Color2'].default_value = (0.0, 0.0, 0.0, 1.0) # Black ticks
        links.new(math_node.outputs["Value"], mix.inputs["Fac"])
        links.new(mix.outputs["Color"], bsdf.inputs["Base Color"])
