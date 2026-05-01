import bpy

class BaseScenario:
    def __init__(self, config):
        self.config = config
        self.balls = []

    def setup_common(self, mat_table):
        """Setup table and common world properties."""
        bpy.context.scene.frame_start = 1
        bpy.context.scene.frame_end = self.config.TOTAL_FRAMES
        bpy.context.scene.render.fps = int(self.config.FPS)
        
        if not bpy.context.scene.rigidbody_world:
            bpy.ops.rigidbody.world_add()
            
        rw = bpy.context.scene.rigidbody_world
        rw.point_cache.frame_end = self.config.TOTAL_FRAMES
        rw.substeps_per_frame = 20 # Better precision for fast collisions
        rw.solver_iterations = 20
            
        # Table (Large floor to prevent balls falling off)
        bpy.ops.mesh.primitive_plane_add(size=100)
        table = bpy.context.active_object
        table.name = "Table"
        table.data.materials.append(mat_table)
        bpy.ops.rigidbody.object_add()
        table.rigid_body.type = 'PASSIVE'
        table.rigid_body.friction = 0.5
        table.rigid_body.restitution = 0.5
        
        # --- Professional Studio Rig (Lights + Reflection Cards) ---
        def create_studio_light(name, location, rotation, scale, energy):
            # Area light source
            bpy.ops.object.light_add(type='AREA', location=location, rotation=rotation)
            light = bpy.context.active_object
            light.name = f"Light_{name}"
            light.data.energy = energy * 10 # Area lights need more "oomph"
            light.data.size = scale[0]
            light.data.size_y = scale[1]
            
            # 2. The Reflection Card (so we see the shape in the ball)
            bpy.ops.mesh.primitive_plane_add(size=1, location=location, rotation=rotation)
            card = bpy.context.active_object
            card.name = f"Card_{name}"
            card.scale = scale
            card.location.z += 0.05 # Offset slightly so it doesn't z-fight with the light
            
            mat = bpy.data.materials.new(f"Mat_{name}")
            mat.use_nodes = True
            nodes = mat.node_tree.nodes
            nodes.remove(nodes['Principled BSDF'])
            emit = nodes.new('ShaderNodeEmission')
            emit.inputs['Strength'].default_value = 5.0 # Just enough to show up in reflections
            emit.inputs['Color'].default_value = (1, 0.95, 0.9, 1)
            output = nodes['Material Output']
            mat.node_tree.links.new(emit.outputs['Emission'], output.inputs['Surface'])
            card.data.materials.append(mat)
            return light

        # Main Light (Front-Left)
        create_studio_light("Main", (-3, -4, 5), (0.6, 0, -0.6), (3, 3, 1), 50)
        # Fill Light (Front-Right)
        create_studio_light("Fill", (4, -2, 4), (0.5, 0, 0.8), (4, 4, 1), 20)
        
        # --- World Ambient Light ---
        if not bpy.context.scene.world:
            bpy.context.scene.world = bpy.data.worlds.new("World")
        
        world = bpy.context.scene.world
        world.use_nodes = True
        bg = world.node_tree.nodes['Background']
        bg.inputs['Color'].default_value = (0.05, 0.05, 0.06, 1.0)
        bg.inputs['Strength'].default_value = 0.1

    def setup_scene(self):
        """Override this to define the specific scenario."""
        pass
