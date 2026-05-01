import bpy
import math
from mathutils import Matrix, Vector

def get_cv_matrix(cam_obj):
    """
    Compute OpenCV Camera Extrinsics.
    Maps Blender World (Right-handed, Z-up) to OpenCV Camera (Right-handed, Y-down, Z-forward).
    """
    R_b2cv = Matrix((
        (1,  0,  0, 0),
        (0, -1,  0, 0),
        (0,  0, -1, 0),
        (0,  0,  0, 1)
    ))
    return R_b2cv @ cam_obj.matrix_world.inverted()

def blender_point_to_target(p):
    """Convert Blender (x, y, z) to target (X, Y, Z) = (x, -z, y)."""
    return Vector((float(p.x), float(-p.z), float(p.y)))

def setup_cameras(config):
    """Create and align the stereo camera pair."""
    # Camera 0
    bpy.ops.object.camera_add(location=(0.0, -1.0, 1.2), rotation=(math.radians(50), 0, 0))
    cam0 = bpy.context.active_object
    cam0.name = "cam0"
    
    # Camera 1 (Offset by baseline, angled slightly inwards)
    bpy.ops.object.camera_add(location=(config.BASELINE_M, -1.0, 1.2), rotation=(math.radians(50), 0, math.radians(2)))
    cam1 = bpy.context.active_object
    cam1.name = "cam1"
    
    # Set Intrinsics to match downstream expectations (fx = 980)
    for cam in [cam0, cam1]:
        cam.data.type = 'PERSP'
        cam.data.sensor_fit = 'HORIZONTAL'
        cam.data.sensor_width = 36.0
        # focal_length_mm = fx * sensor_width / image_width
        cam.data.lens = 980.0 * 36.0 / config.RESOLUTION_X
        
        # Depth of Field (Disabled for sharp CV tracking)
        cam.data.dof.use_dof = False 
        
    return cam0, cam1
