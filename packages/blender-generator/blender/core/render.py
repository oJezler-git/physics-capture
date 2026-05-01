import bpy
import os

def setup_compositor(scene):
    """Builds the compositor node tree once."""
    scene.use_nodes = True
    tree = scene.node_tree
    
    for node in tree.nodes:
        tree.nodes.remove(node)
        
    render_layers = tree.nodes.new('CompositorNodeRLayers')
    
    # JPG Output (Sequence)
    file_output = tree.nodes.new('CompositorNodeOutputFile')
    file_output.name = "MultiOutput"
    file_output.format.file_format = 'JPEG'
    file_output.format.quality = 95
    # The node starts with one default slot. Just rename its prefix.
    file_output.file_slots[0].path = "frame_"
    
    tree.links.new(render_layers.outputs['Image'], file_output.inputs[0])
    
    # The 'Main' output handles the FFMPEG video
    comp_node = tree.nodes.new('CompositorNodeComposite')
    tree.links.new(render_layers.outputs['Image'], comp_node.inputs['Image'])
    
    return file_output

def setup_render_engine(scene):
    """Configure render settings for a cinematic look and optimized speed."""
    # Color Management
    scene.display_settings.display_device = 'sRGB'
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'None'
    scene.view_settings.exposure = 0.2 
    
    # Engine Setup (Blender 4.2+ uses EEVEE_NEXT)
    scene.render.engine = 'BLENDER_EEVEE_NEXT'
    scene.eevee.taa_render_samples = 16 # Optimized for speed
    scene.eevee.use_raytracing = True 
    
    # Shadows (Faster settings)
    scene.eevee.shadow_ray_count = 1
    scene.eevee.shadow_step_count = 4

def render_scene(config, cam0, cam1):
    scene = bpy.context.scene
    scene.render.resolution_x = config.RESOLUTION_X
    scene.render.resolution_y = config.RESOLUTION_Y
    scene.render.resolution_percentage = 100
    scene.render.use_persistent_data = True
    
    setup_render_engine(scene)
    file_output_node = setup_compositor(scene)
        
    for cam in [cam0, cam1]:
        scene.camera = cam
        file_output_node.base_path = os.path.join(config.EXP_DIR, "frames", cam.name)
        scene.render.filepath = os.path.join(config.EXP_DIR, "raw", f"{cam.name}.mp4")
        scene.render.image_settings.file_format = 'FFMPEG'
        scene.render.ffmpeg.format = 'MPEG4'
        scene.render.ffmpeg.codec = 'H264'
        scene.render.ffmpeg.constant_rate_factor = 'MEDIUM'
        bpy.ops.render.render(animation=True)

def render_debug_single_frame(config, cam0, cam1, frame_idx=1):
    scene = bpy.context.scene
    scene.render.resolution_x = config.RESOLUTION_X
    scene.render.resolution_y = config.RESOLUTION_Y
    scene.render.resolution_percentage = 100

    setup_render_engine(scene)

    frame_idx = max(scene.frame_start, min(scene.frame_end, int(frame_idx)))
    scene.frame_set(frame_idx)

    debug_dir = os.path.join(config.EXP_DIR, "debug")
    os.makedirs(debug_dir, exist_ok=True)
    scene.render.image_settings.file_format = 'JPEG'
    scene.render.image_settings.quality = 95

    for cam in [cam0, cam1]:
        scene.camera = cam
        scene.render.filepath = os.path.join(debug_dir, f"{cam.name}_frame_{frame_idx:06d}.jpg")
        bpy.ops.render.render(write_still=True)

    print(f"Debug stills rendered to: {debug_dir} (frame={frame_idx})")
