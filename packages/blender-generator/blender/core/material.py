import bpy

def create_materials():
    """Create high-quality PBR materials for the table and balls."""
    # 1. Table (Paper)
    mat_table = bpy.data.materials.new("Paper")
    mat_table.use_nodes = True
    nodes = mat_table.node_tree.nodes
    links = mat_table.node_tree.links
    
    bsdf = nodes["Principled BSDF"]
    bsdf.inputs['Roughness'].default_value = 0.85
    bsdf.inputs['Sheen Weight'].default_value = 0.1 
    
    # Large scale variation (unevenness)
    noise_large = nodes.new('ShaderNodeTexNoise')
    noise_large.inputs['Scale'].default_value = 5.0
    noise_large.inputs['Detail'].default_value = 2.0
    
    # Fine grain noise
    noise_fine = nodes.new('ShaderNodeTexNoise')
    noise_fine.inputs['Scale'].default_value = 800.0
    noise_fine.inputs['Detail'].default_value = 15.0
    
    # Mix node for color variation
    mix_color = nodes.new('ShaderNodeMix')
    mix_color.data_type = 'RGBA'
    mix_color.blend_type = 'MIX'
    # Target Hex #a9a7a8 => ~0.66 sRGB => ~0.39 Linear
    mix_color.inputs[6].default_value = (0.42, 0.42, 0.41, 1.0) # Slightly lighter patch
    mix_color.inputs[7].default_value = (0.36, 0.36, 0.36, 1.0) # Slightly darker patch
    
    # Connect large noise to mix factor
    links.new(noise_large.outputs['Fac'], mix_color.inputs[0])
    links.new(mix_color.outputs[2], bsdf.inputs['Base Color'])
    
    # Bump for fine grain
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.03
    links.new(noise_fine.outputs['Fac'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])

    # 2. Billiard Balls (High Gloss with micro-imperfections)
    def create_ball_mat(name):
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        
        bsdf = nodes["Principled BSDF"]
        bsdf.inputs['Base Color'].default_value = (0.9, 0.9, 0.9, 1.0) # Bright Silver
        bsdf.inputs['Metallic'].default_value = 1.0
        bsdf.inputs['Roughness'].default_value = 0.25 # Slightly higher roughness to scatter light
        bsdf.inputs['Specular IOR Level'].default_value = 0.5
        bsdf.inputs['Coat Weight'].default_value = 1.0 
        
        # Micro-imperfections (scratches/smudges) using modern Noise node
        noise = nodes.new('ShaderNodeTexNoise')
        noise.noise_dimensions = '3D'
        noise.inputs['Scale'].default_value = 20
        noise.inputs['Detail'].default_value = 15
        noise.inputs['Roughness'].default_value = 0.7
        noise.inputs['Distortion'].default_value = 0.2
        
        ramp = nodes.new('ShaderNodeValToRGB')
        ramp.color_ramp.interpolation = 'LINEAR'
        ramp.color_ramp.elements[0].position = 0.4
        ramp.color_ramp.elements[0].color = (0.02, 0.02, 0.02, 1)
        ramp.color_ramp.elements[1].position = 0.6
        ramp.color_ramp.elements[1].color = (0.15, 0.15, 0.15, 1)
        
        links.new(noise.outputs['Fac'], ramp.inputs['Fac'])
        links.new(ramp.outputs['Color'], bsdf.inputs['Roughness'])
        
        return mat

    mat_b0 = create_ball_mat("Ball0")
    mat_b1 = create_ball_mat("Ball1")
    mat_checker = create_checkerboard_material()
    
    return mat_table, mat_b0, mat_b1, mat_checker

def create_checkerboard_material():
    mat = bpy.data.materials.new("CalibrationCheckerboard")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    
    bsdf = nodes["Principled BSDF"]
    bsdf.inputs['Roughness'].default_value = 1.0 # Fully matte

    # OpenCV calibrator expects 9x6 inner corners => 10x7 checker squares.
    cols, rows = 10, 7
    px_per_cell = 64
    width, height = cols * px_per_cell, rows * px_per_cell
    img = bpy.data.images.get("CalibrationBoard_10x7")
    if img is None:
      img = bpy.data.images.new("CalibrationBoard_10x7", width=width, height=height, alpha=False)
      img.use_fake_user = True
      pixels = []
      for y in range(height):
        cy = y // px_per_cell
        for x in range(width):
          cx = x // px_per_cell
          white = 1.0 if (cx + cy) % 2 == 0 else 0.0
          pixels.extend((white, white, white, 1.0))
      img.pixels.foreach_set(pixels)
      img.update()

    tex = nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = 'Closest'

    tex_coord = nodes.new("ShaderNodeTexCoord")
    mapping = nodes.new("ShaderNodeMapping")
    # Keep one clean board over the plane UV (no tiling).
    mapping.inputs["Scale"].default_value = (1.0, 1.0, 1.0)

    links.new(tex_coord.outputs["UV"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], tex.inputs["Vector"])
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    return mat
