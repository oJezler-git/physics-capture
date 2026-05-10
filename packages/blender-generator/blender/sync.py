import bpy
import math
import numpy as np

def create_sync_marker():
    """Generates a single physical sync marker in the scene visible to both cameras."""
    img = bpy.data.images.get("SyncMarkerImg")
    if not img:
        img = bpy.data.images.new("SyncMarkerImg", width=400, height=200, alpha=False)
        img.use_fake_user = True
    
    marker_name = "SyncMarker"
    if bpy.data.objects.get(marker_name):
        return

    bpy.ops.mesh.primitive_plane_add(size=1.0)
    marker = bpy.context.active_object
    marker.name = marker_name
    
    # Position in the world: Behind the collision zone, visible to both cameras
    # Tilted up like a tablet on a stand
    marker.location = (0.4, 1.2, 0.25)
    marker.rotation_euler = (math.radians(75), 0, math.radians(-15))
    marker.scale = (1.2, 0.6, 1.0)
    
    mat = bpy.data.materials.new("SyncMarkerMat")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    for n in nodes: nodes.remove(n)
    
    output = nodes.new('ShaderNodeOutputMaterial')
    emission = nodes.new('ShaderNodeEmission')
    emission.inputs['Strength'].default_value = 5.0 # Bright enough to be seen in the scene
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = img
    tex.interpolation = 'Closest' 
    
    mat.node_tree.links.new(tex.outputs[0], emission.inputs[0])
    mat.node_tree.links.new(emission.outputs[0], output.inputs[0])
    marker.data.materials.append(mat)

def get_sync_handler(config):
    def update_marker_image(scene):
        img = bpy.data.images.get("SyncMarkerImg")
        if not img: return
        
        frame_idx = max(0, scene.frame_current - 1)
        rw, rh = 400, 200
        p = np.zeros((rh, rw, 4), dtype=np.float32) 
        p[:, :, 3] = 1.0 
        
        # Borders & Content Frame
        border = 10
        dead_zone = 4
        cf = border + dead_zone
        p[0:border, :, 0:3] = 1.0
        p[rh-border:rh, :, 0:3] = 1.0
        p[:, 0:border, 0:3] = 1.0
        p[:, rw-border:rw, 0:3] = 1.0
        
        # Content frame (thin white line)
        p[cf:cf+1, cf:rw-cf, 0:3] = 1.0
        p[rh-cf-1:rh-cf, cf:rw-cf, 0:3] = 1.0
        p[cf:rh-cf, cf:cf+1, 0:3] = 1.0
        p[cf:rh-cf, rw-cf-1:rw-cf, 0:3] = 1.0

        # Compact L-Corners
        arm = 30 # Shortened to avoid overlap
        th = 6
        p[border:border+arm, border:border+th, 0:3] = 1.0 # TL
        p[border:border+th, border:border+arm, 0:3] = 1.0
        p[border:border+arm, rw-border-th:rw-border, 0:3] = 1.0 # TR
        p[border:border+th, rw-border-arm:rw-border, 0:3] = 1.0
        p[rh-border-arm:rh-border, rw-border-th:rw-border, 0:3] = 1.0 # BR
        p[rh-border-th:rh-border, rw-border-arm:rw-border, 0:3] = 1.0
        p[rh-border-arm:rh-border, border:border+th, 0:3] = 1.0 # BL
        p[rh-border-th:rh-border, border:border+arm, 0:3] = 1.0

        # Signature Checker (Shifted to clear Gray rows)
        sz = 6
        sx, sy = rw - border - (4*sz) - 2, border + 2
        for r in range(4):
            for c in range(4):
                if (r + c) % 2 == 1:
                    p[sy + r*sz : sy + (r+1)*sz, sx + c*sz : sx + (c+1)*sz, 0:3] = 1.0

        # Content Area Layout
        pad = 8
        inner_y = cf + pad
        inner_h = rh - 2 * (cf + pad)
        
        # Gray Rows
        gray_h = 24
        gap = 6
        row1_y = inner_y + 4 # Offset slightly from top
        row2_y = row1_y + gray_h + gap
        
        # Gratings (Dynamic height to fill bottom area)
        grating_y_start = row2_y + gray_h + gap + 4
        grating_total_h = max(1, (rh - (cf + pad)) - grating_y_start)
        grating_band_gap = max(2, int(grating_total_h * 0.08))
        grating_h = max(1, (grating_total_h - grating_band_gap) // 2)
        
        grating1_y = grating_y_start
        grating2_y = grating1_y + grating_h + grating_band_gap

        # Draw Gray Code
        bits = 8
        gray_val = (frame_idx ^ (frame_idx >> 1)) & ((1 << bits) - 1)
        inner_w = rw - 2 * (cf + pad)
        cell_w = inner_w / bits
        x0 = cf + pad
        
        for i in range(bits):
            bit = (gray_val >> (bits - 1 - i)) & 1
            if bit:
                bx0 = int(x0 + i * cell_w + 2)
                bx1 = int(x0 + (i + 1) * cell_w - 2)
                p[row1_y : row1_y + gray_h, bx0:bx1, 0:3] = 1.0
                p[row2_y : row2_y + gray_h, bx0:bx1, 0:3] = 1.0

        # Draw Dual Gratings (Clipped to inner width)
        grating_inner_w = int(inner_w)
        x_coords = np.linspace(0, 1, grating_inner_w)
        phase = (frame_idx * (math.pi * 2 / 32)) % (math.pi * 2)
        omega = 2 * math.pi * 4 # 4 cycles
        
        sine = 0.5 + 0.48 * np.sin(omega * x_coords + phase)
        quad = 0.5 + 0.48 * np.sin(omega * x_coords + phase + (math.pi / 2))
        
        # Draw into the horizontal inner area only
        ix0 = int(x0)
        ix1 = int(x0 + grating_inner_w)
        p[grating1_y : grating1_y + grating_h, ix0:ix1, 0:3] = sine[:, np.newaxis]
        p[grating2_y : grating2_y + grating_h, ix0:ix1, 0:3] = quad[:, np.newaxis]

        img.pixels.foreach_set(np.flipud(p).ravel())
        img.update()
    return update_marker_image
