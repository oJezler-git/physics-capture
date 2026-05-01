# Synthetic Experiment Generator

This generator creates a realistic dual-camera experiment without recording hardware footage.

It produces:

- `raw/cam0.mp4`, `raw/cam1.mp4`
- `frames/cam0/*.jpg`, `frames/cam1/*.jpg`
- `calibration/cam0_intrinsics.json`, `calibration/cam1_intrinsics.json`
- `calibration/stereo_extrinsics.json`
- `results/sync.json`, `results/tracks.json`, `results/scale.json`
- `results/positions_3d_gt.json` (ground truth)

## Usage

From repo root:

```powershell
.\.venv\Scripts\python.exe packages/cv-service/synthetic/generate_experiment.py --experiment-id synthetic-stereo-01
```

Optional realism controls:

```powershell
.\.venv\Scripts\python.exe packages/cv-service/synthetic/generate_experiment.py `
  --experiment-id synthetic-stereo-01 `
  --seconds 10 `
  --fps 30 `
  --baseline-mm 300 `
  --seed 42
```

## Notes

- Frames include checkerboard motion, sync-style overlay, and colliding balls in both camera views.
- Camera artifacts are simulated (noise, blur, exposure jitter, JPEG loss).
- Outputs are directly compatible with the existing tracking/calibration/physics pipeline for E2E validation.
