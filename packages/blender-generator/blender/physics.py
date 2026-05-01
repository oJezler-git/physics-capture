import bpy

def bake_physics(balls):
    """Bake physics into absolute animation keyframes for 100% determinism during multi-pass renders."""
    scene = bpy.context.scene
    
    # We will manually step through the frames to ensure the rigid body simulation 
    # runs and we capture the evaluated state. This is more reliable in background 
    # mode than the asynchronous 'bake_all' operator.
    
    baked_locs = {b: [] for b in balls}
    baked_rots = {b: [] for b in balls}
    
    print(f"Simulating and capturing {len(balls)} balls over {scene.frame_end} frames...")
    
    # Ensure we start from frame 1 to trigger the simulation correctly
    for frame in range(scene.frame_start, scene.frame_end + 1):
        scene.frame_set(frame)
        dg = bpy.context.evaluated_depsgraph_get()
        for ball in balls:
            eval_ball = ball.evaluated_get(dg)
            # Store the world matrix translation and rotation
            baked_locs[ball].append((frame, eval_ball.matrix_world.translation.copy()))
            baked_rots[ball].append((frame, eval_ball.matrix_world.to_euler().copy()))
            
    print("Capture complete. Converting to keyframes...")
    
    # Apply the captured keyframes and remove physics
    for ball in balls:
        bpy.ops.object.select_all(action='DESELECT')
        ball.select_set(True)
        bpy.context.view_layer.objects.active = ball
        
        # Strip rigid body so it doesn't interfere with the baked animation
        if ball.rigid_body:
            bpy.ops.rigidbody.object_remove()
            
        # Clear existing animation data
        if ball.animation_data:
            ball.animation_data_clear()
        
        # Apply the captured path
        for frame, loc in baked_locs[ball]:
            ball.location = loc
            ball.keyframe_insert(data_path="location", frame=frame)
        for frame, rot in baked_rots[ball]:
            ball.rotation_euler = rot
            ball.keyframe_insert(data_path="rotation_euler", frame=frame)
            
    print("Physics baking completed.")
