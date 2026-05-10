import os

class Config:
    def __init__(self, experiment_id="synthetic-stereo-01"):
        self.EXP_ID = experiment_id
        # Point to the experiments directory at the project root
        project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../"))
        self.EXP_DIR = os.path.join(project_root, "experiments", self.EXP_ID)
        self.FPS = 30.0
        # Temporary calibration-focused cap to keep iteration fast.
        self.TOTAL_FRAMES = int(os.getenv("BLENDER_TOTAL_FRAMES", "100"))
        self.SECONDS = self.TOTAL_FRAMES / self.FPS
        self.RESOLUTION_X = 1280
        self.RESOLUTION_Y = 720
        self.BASELINE_M = 0.28
        self.BALL_RADIUS = 0.028
        self.SYNC_GRAY_BITS = 8

    def setup_directories(self):
        """Create the exact required output directory structure."""
        dirs = [
            "frames/cam0", "frames/cam1",
            "raw", "calibration", "results"
        ]
        for d in dirs:
            os.makedirs(os.path.join(self.EXP_DIR, d), exist_ok=True)
        print(f"Directories created at: {self.EXP_DIR}")
