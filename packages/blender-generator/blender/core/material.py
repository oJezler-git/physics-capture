import bpy

def create_materials():
    """Create high-quality PBR materials for the table and balls."""
    # 1. Table (Felt)
    mat_table = bpy.data.materials.new("Felt")
    mat_table.use_nodes = True
    nodes = mat_table.node_tree.nodes
    links = mat_table.node_tree.links
    
    bsdf = nodes["Principled BSDF"]
    bsdf.inputs['Base Color'].default_value = (0.01, 0.04, 0.01, 1.0) # Much darker green
    bsdf.inputs['Roughness'].default_value = 0.98
    bsdf.inputs['Sheen Weight'].default_value = 1.0 
    
    # Add noise for subtle texture
    noise = nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 500
    noise.inputs['Detail'].default_value = 15
    
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.1
    links.new(noise.outputs['Fac'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])

    # 2. Billiard Balls (High Gloss with micro-imperfections)
    def create_ball_mat(name, color):
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        
        bsdf = nodes["Principled BSDF"]
        bsdf.inputs['Base Color'].default_value = color
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

    mat_b0 = create_ball_mat("Ball0", (0.05, 0.4, 0.8, 1.0)) # Deep Blue
    mat_b1 = create_ball_mat("Ball1", (0.8, 0.05, 0.1, 1.0)) # Deep Red
    mat_checker = create_checkerboard_material()
    
    return mat_table, mat_b0, mat_b1, mat_checker

def create_checkerboard_material():
    mat = bpy.data.materials.new("CalibrationCheckerboard")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    
    bsdf = nodes["Principled BSDF"]
    bsdf.inputs['Roughness'].default_value = 1.0 # Fully matte
    
    checker = nodes.new("ShaderNodeTexChecker")
    checker.inputs["Scale"].default_value = 10.0 # 10x10 pattern
    checker.inputs["Color1"].default_value = (1.0, 1.0, 1.0, 1.0)
    checker.inputs["Color2"].default_value = (0.0, 0.0, 0.0, 1.0)
    
    links.new(checker.outputs["Color"], bsdf.inputs["Base Color"])
    return mat
