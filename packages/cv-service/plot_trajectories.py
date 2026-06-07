
import sys
import json
from pathlib import Path

def plot_trajectories(exp_id):
    # Adjust to your actual experiments path
    base_dir = Path("C:/Users/Jezler/Documents/physics-capture/packages/experiments")
    track_file = base_dir / exp_id / "results" / "tracks.json"
    
    if not track_file.exists():
        print(f"Error: {track_file} not found")
        sys.exit(1)
        
    with open(track_file, "r") as f:
        data = json.load(f)
        
    print(f"Trajectories around collision (Frame 44):")
    print("-" * 60)
    
    for ball in data["balls"]:
        ball_id = ball["ball_id"]
        # Look for frames around 44
        frames = [f for f in ball["frames"] if 40 <= f["frame_idx"] <= 50]
        
        print(f"Ball {ball_id}:")
        for f in frames:
            print(f"  Frame {f['frame_idx']}: x={f['x_px']:.2f}, y={f['y_px']:.2f}, conf={f.get('confidence', 1.0):.2f}")
        print("-" * 20)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python plot_trajectories.py <experiment_id>")
    else:
        plot_trajectories(sys.argv[1])
