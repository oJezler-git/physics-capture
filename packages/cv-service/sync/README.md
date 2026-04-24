# Sync Marker Diagnostic Tools

This directory contains the Computer Vision (CV) logic for the high-precision visual sync marker and a suite of diagnostic scripts to verify its performance.

## Core Scripts

### 1. Unified Debug Dashboard (UI)

The easiest way to debug is via the web interface.

- **URL:** `/debug`
- **Features:** Toggle to **Sync** mode to see the rectified ROI, Gray counter, Phase, and Magnitude updated in real-time as you scrub the timeline.

### 2. ROI Video Renderer

Renders a video of exactly what the tracker "sees" after the perspective warp.

- **Goal:** Check for warp stability, motion blur, or interference from other elements.
- **Command:**
  ```powershell
  .venv/Scripts/python.exe packages/cv-service/sync/_debug_render_roi_video.py --experiment-id b27c433b-9818-4b61-a393-a3d0a15de706 --camera-id 0
  ```
- **Output:** `packages/experiments/<ID>/results/_debug_roi_cam0.mp4` (includes F/G/P/M overlay).

### 3. Candidate Discovery

Prints every rectangular candidate found in a single frame and its detection score.

- **Goal:** Debug why a marker isn't being detected or if a distractor has a higher score.
- **Command:**
  ```powershell
  .venv/Scripts/python.exe packages/cv-service/sync/_debug_candidates.py --experiment-id <ID> --frame-index 0
  ```

### 4. ROI Image Export

Saves the top-scoring rectified candidates as PNG files.

- **Goal:** Inspect raw image quality of the marker.
- **Command:**
  ```powershell
  .venv/Scripts/python.exe packages/cv-service/sync/_debug_save_roi.py --experiment-id <ID> --count 5
  ```

### 5. Line Fit Diagnostic

Prints the mathematical results of the linear regression used for sub-millisecond timing.

- **Goal:** Debug "Rejected Fit" errors or high RMS residuals.
- **Command:**
  ```powershell
  .venv/Scripts/python.exe packages/cv-service/sync/_debug_fit.py --experiment-id <ID>
  ```

---

## Metric Definitions (F/G/P/M)

- **F (Frame):** The camera's raw frame index.
- **G (Gray Code):** The **Macro-time** counter (0-1023). Identifies which display frame was captured.
- **P (Phase):** The **Micro-time** phase (0-6.28 rad). Provides sub-millisecond precision within a display frame.
- **M (Magnitude):** The **Signal Strength** of the grating.
  - `> 150`: Excellent.
  - `80-120`: Good/Stable.
  - `< 50`: Poor (Too blurry/dark, leads to `P:ERR`).

## Production CLI

To manually trigger a full sync decode for an experiment:

```powershell
.venv/Scripts/python.exe packages/cv-service/sync/sync_marker_cli.py --experiments-dir packages/experiments --experiment-id <ID> --camera-ids 0 --debug
```
