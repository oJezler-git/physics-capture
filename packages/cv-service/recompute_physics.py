
import sys
import os
import json
from pathlib import Path
from physics.pipeline import run_physics_pipeline

def main():
    if len(sys.argv) < 2:
        print("Usage: python recompute_physics.py <experiment_id>")
        sys.exit(1)

    exp_id = sys.argv[1]
    
    # Path setup
    base_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), "../experiments")))
    if not (base_dir / exp_id).exists():
        # Fallback to local experiments folder if not in packages/
        base_dir = Path("C:/Users/Jezler/Documents/physics-capture/packages/experiments")
    
    print(f"Recomputing physics for: {exp_id}")
    print(f"Base Directory: {base_dir}")

    # Use default 5g mass from your simulation
    masses = [
        {"ball_id": 0, "mass_g": 5.0, "uncertainty_g": 0.1},
        {"ball_id": 1, "mass_g": 5.0, "uncertainty_g": 0.1}
    ]

    try:
        results = run_physics_pipeline(
            experiment_id=exp_id,
            base_dir=base_dir,
            masses=masses,
            mode="SINGLE_CAMERA_PLANAR",
            ke_mode="point_mass"
        )
        
        print("\n" + "="*40)
        print("PHYSICS RESULTS")
        print("="*40)
        print(f"Collision Point: Frame {results['velocities']['collision_frame']}")
        
        m = results['momentum']['system']
        print(f"Momentum Conserved: {m['conservation_pct']['value_pct']:.2f} +/- {m['conservation_pct']['uncertainty_pct']:.2f}%")
        print(f"Restitution (e):     {m['cor']['value']:.3f} +/- {m['cor']['uncertainty']:.3f}")
        print(f"System KE (Pre):     {m['ke_before']['value_J']:.6f} J")
        
        print("\nFit Diagnostic Parameters:")
        print(f"  System p_before: {m['p_before']['value_kgmps']:.6f} kg·m/s")
        print(f"  System p_after:  {m['p_after']['value_kgmps']:.6f} kg·m/s")
        
        print("\nPer-Ball Velocities (at impact):")
        for ball in results['velocities']['balls']:
            print(f"  Ball {ball['ball_id']}: {ball['v_before']['value_mps']:.3f} -> {ball['v_after']['value_mps']:.3f} m/s")
        print("="*40)

    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()
