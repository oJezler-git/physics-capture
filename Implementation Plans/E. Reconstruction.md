# Module E — Reconstruction: Full Implementation Plan

**Target submodules:**

- E.1 — 2D → 3D Triangulation _(multi-camera only)_
- E.2 — Projection Models & Reprojection Validation
- E.3 — Single-Camera Planar Mode

**Document version:** 1.0  
**Execution environment:** Python 3.11 · `cv-service/` · OpenCV 4.9 · NumPy 1.26 · SciPy 1.12 · `uncertainties` 3.1

---

## 0. Relevant Context Extraction

### 0.1 Upstream dependencies — who provides inputs

| Provider                                        | Artefact                 | Location                        | Contents                                                                      |
| ----------------------------------------------- | ------------------------ | ------------------------------- | ----------------------------------------------------------------------------- |
| Calibration module (`calibration/intrinsic.py`) | `cam{N}_intrinsics.json` | `experiments/{id}/calibration/` | Camera matrix `K`, distortion coefficients `dist`                             |
| Calibration module (`calibration/stereo.py`)    | `stereo_extrinsics.json` | `experiments/{id}/calibration/` | Rotation matrix `R`, translation vector `T`, projection matrices `P0`, `P1`   |
| Tracking module (`tracking/sam2_tracker.py`)    | `tracks.json`            | `experiments/{id}/results/`     | Sub-pixel 2D centroids per ball per frame per camera, **already undistorted** |
| Scale calibration (UI interaction)              | `scale.json`             | `experiments/{id}/results/`     | Ruler pixel distance, known physical distance, px→mm factor                   |
| Sync module (`sync/timestamp_array.py`)         | `sync.json`              | `experiments/{id}/results/`     | `frame_index → true_ms` mapping                                               |

> **Assumption A1:** Tracking module outputs **undistorted** pixel coordinates. The tracking module applies `cv2.undistortPoints()` before writing `tracks.json`. Module E does **not** undistort — if this assumption is wrong, E.1 must call `cv2.undistortPoints()` itself on raw tracks before triangulating.

> **Assumption A2:** The calibration module has already computed `P0`, `P1` as 3×4 projection matrices in the **rectified** stereo coordinate frame, using `cv2.stereoRectify()`. If non-rectified projection matrices are stored instead, E.1 must derive them from `K`, `R`, `T` directly (documented in §4.1).

> **Assumption A3:** `tracks.json` exists and is complete for all frames before Module E is invoked. Module E is a post-processing step — it does not stream.

> **Assumption A4:** Single-camera mode and stereo mode are mutually exclusive within a single experiment. The `metadata.json` field `mode: "single" | "stereo"` determines which submodule executes.

> **Assumption A5:** Up to 3 balls may be tracked simultaneously. All three are processed identically through this module.

### 0.2 Downstream consumers — who uses outputs

| Consumer                              | Artefact consumed                                                           | Module      |
| ------------------------------------- | --------------------------------------------------------------------------- | ----------- |
| Physics engine (`physics/fitting.py`) | `positions_3d.json` _(stereo)_ or `positions_2d_metric.json` _(single-cam)_ | F — Physics |
| Frontend results UI                   | `reprojection_report.json`                                                  | UI          |
| Observability / debug                 | `reprojection_report.json`, log stream                                      | —           |

### 0.3 Execution environment

- **Python 3.11**, inside `cv-service/` Docker container
- Invoked by `grpc_server.py` as a synchronous function call from `ComputePhysics` RPC handler
- No GPU required for this module (OpenCV triangulation is CPU-bound, sub-millisecond)
- Runs entirely after tracking completes — **no real-time constraint**

### 0.4 Hardware constraints (inherited — not enforced here)

- Cameras: iPhone PWA, 30 fps, 1080p nominal, up to 4K
- Network: already used for upload; not relevant to this module
- Clock: sync handled by Module C; this module consumes `sync.json` passively

### 0.5 Timing / accuracy constraints

| Constraint                               | Value        | Source                 |
| ---------------------------------------- | ------------ | ---------------------- |
| Reprojection error threshold (per frame) | < 1.0 px     | Overall plan §7 Step 4 |
| Stereo calibration quality pre-requisite | < 0.5 px RMS | Overall plan §7 Step 2 |
| Position accuracy target (stereo)        | ±0.5 mm      | Accuracy budget §11    |
| Position accuracy target (single-cam)    | ±0.3 mm      | Accuracy budget §11    |

### 0.6 Missing / ambiguous details — stated assumptions

| Item                                  | Ambiguity                                                       | Resolution assumed                                                                                |
| ------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Projection matrix source              | Not specified whether `P0/P1` are pre-stored or must be derived | **Assumed stored** in `stereo_extrinsics.json`; fallback derivation documented in §4.1            |
| Coordinate system handedness          | Not stated                                                      | **Assumed right-handed, Y-up**, with cam0 as world origin in stereo mode                          |
| Scale calibration per-axis            | Not stated if scale factor is isotropic                         | **Assumed isotropic** (single scalar `px_per_mm`); anisotropy would require two orthogonal rulers |
| Reprojection error action             | "Flagged for review" — no downstream blocking stated            | **Flagging is informational only**; physics engine receives all frames, flagged or not            |
| Uncertainty representation in outputs | Not specified                                                   | **Using `uncertainties.ufloat`** internally; serialised as `{value, uncertainty}` pairs in JSON   |

### 0.7 Module boundary — explicit

**INSIDE Module E:**

- Homogeneous triangulation from 2D point pairs
- Homogeneous → Cartesian division
- Projection matrix derivation (fallback)
- 3D→2D reprojection for validation
- Reprojection error computation and per-frame flagging
- Px-to-metric coordinate conversion (single-camera mode)
- Uncertainty attachment to all output positions

**OUTSIDE Module E (treated as fixed black boxes):**

- SAM2 tracking (upstream)
- Camera calibration — intrinsic and stereo (upstream)
- Sync timestamp array generation (upstream)
- Physics velocity fitting and momentum (downstream)
- UI rendering of reprojection overlay (downstream)

---

## 1. Module Definition

### 1.1 Precise responsibility

Module E takes **synchronised, undistorted 2D pixel coordinates** per ball per frame from both cameras (stereo) or one camera (single), and converts them into **metric 3D world positions** (stereo) or **metric 2D planar positions** (single-camera), with per-position uncertainty estimates. It validates stereo outputs via reprojection error and flags frames exceeding the threshold.

### 1.2 Explicit non-goals

- Does **not** filter, smooth, or temporally interpolate positions (physics engine's job)
- Does **not** undistort raw frames (calibration module's job)
- Does **not** fit velocities or compute momentum
- Does **not** rectify the stereo pair (calibration module's job)
- Does **not** display anything — all output is JSON

### 1.3 Inputs — fully specified

#### E.1 / E.2 Stereo inputs

**`tracks.json`** — written by tracking module:

```json
{
  "num_balls": 2,
  "num_frames": 180,
  "cameras": {
    "cam0": {
      "ball_1": [
        {"frame": 0, "x": 412.37, "y": 601.82, "confidence": 0.98},
        {"frame": 1, "x": 418.11, "y": 601.74, "confidence": 0.97},
        ...
      ],
      "ball_2": [...]
    },
    "cam1": {
      "ball_1": [...],
      "ball_2": [...]
    }
  }
}
```

| Field        | Type      | Units                | Constraints                                   |
| ------------ | --------- | -------------------- | --------------------------------------------- |
| `x`, `y`     | `float64` | pixels (undistorted) | `0 ≤ x < frame_width`, `0 ≤ y < frame_height` |
| `confidence` | `float32` | —                    | `[0.0, 1.0]`                                  |
| `frame`      | `uint32`  | frame index          | monotonically increasing, may have gaps       |

**`stereo_extrinsics.json`**:

```json
{
  "R": [[...], [...], [...]],
  "T": [[tx], [ty], [tz]],
  "P0": [[...], [...], [...]],
  "P1": [[...], [...], [...]]
}
```

| Field | Type      | Shape   | Units  | Meaning                  |
| ----- | --------- | ------- | ------ | ------------------------ |
| `R`   | `float64` | `[3×3]` | —      | Rotation: cam0 → cam1    |
| `T`   | `float64` | `[3×1]` | metres | Translation: cam0 → cam1 |
| `P0`  | `float64` | `[3×4]` | —      | Projection matrix cam0   |
| `P1`  | `float64` | `[3×4]` | —      | Projection matrix cam1   |

**`cam{N}_intrinsics.json`** (both cameras):

```json
{
  "K": [[fx, 0, cx], [0, fy, cy], [0, 0, 1]],
  "dist": [k1, k2, p1, p2, k3]
}
```

| Field  | Type      | Shape   | Units                                            |
| ------ | --------- | ------- | ------------------------------------------------ |
| `K`    | `float64` | `[3×3]` | pixels (focal lengths), pixels (principal point) |
| `dist` | `float64` | `[5]`   | dimensionless                                    |

#### E.3 Single-camera inputs

**`tracks.json`** — same format, `cam0` only.

**`scale.json`** — written by scale calibration UI interaction:

```json
{
  "point_a": { "x": 102.0, "y": 540.0 },
  "point_b": { "x": 984.0, "y": 541.3 },
  "pixel_distance": 882.04,
  "physical_distance_mm": 1000.0,
  "px_per_mm": 0.8822
}
```

| Field                  | Type      | Units  | Constraints                                    |
| ---------------------- | --------- | ------ | ---------------------------------------------- |
| `pixel_distance`       | `float64` | pixels | > 0                                            |
| `physical_distance_mm` | `float64` | mm     | > 0                                            |
| `px_per_mm`            | `float64` | px/mm  | > 0; = `pixel_distance / physical_distance_mm` |

> **Note:** The scale factor `px_per_mm` is the number of pixels per millimetre. To convert pixel distance to mm: `d_mm = d_px / px_per_mm`.

### 1.4 Outputs — fully specified

#### E.1 / E.2 Stereo output: `positions_3d.json`

```json
{
  "coordinate_system": "cam0_origin_right_handed_y_up",
  "units": "metres",
  "num_balls": 2,
  "frames": [
    {
      "frame": 0,
      "true_ms": 0.0,
      "ball_1": {
        "X": 0.1234, "X_unc": 0.0005,
        "Y": 0.0011, "Y_unc": 0.0005,
        "Z": 1.2041, "Z_unc": 0.0008,
        "reprojection_error_cam0_px": 0.31,
        "reprojection_error_cam1_px": 0.44,
        "flagged": false
      },
      "ball_2": { ... }
    },
    ...
  ],
  "flagged_frames": [17, 42]
}
```

| Field                          | Type      | Units  | Constraints                               |
| ------------------------------ | --------- | ------ | ----------------------------------------- |
| `X`, `Y`, `Z`                  | `float64` | metres | finite                                    |
| `X_unc`, `Y_unc`, `Z_unc`      | `float64` | metres | > 0                                       |
| `reprojection_error_cam{N}_px` | `float64` | pixels | ≥ 0                                       |
| `flagged`                      | `bool`    | —      | `true` if any reprojection error ≥ 1.0 px |
| `true_ms`                      | `float64` | ms     | from `sync.json`                          |

#### E.2 Validation output: `reprojection_report.json`

```json
{
  "summary": {
    "mean_reprojection_error_px": 0.38,
    "max_reprojection_error_px": 1.74,
    "num_flagged_frames": 3,
    "threshold_px": 1.0
  },
  "per_frame": [
    {
      "frame": 17,
      "ball_1_cam0_px": 1.21,
      "ball_1_cam1_px": 1.74,
      "ball_2_cam0_px": 0.29,
      "ball_2_cam1_px": 0.33
    }
  ]
}
```

#### E.3 Single-camera output: `positions_2d_metric.json`

```json
{
  "coordinate_system": "image_plane_x_right_y_up_from_ruler_reference",
  "units": "mm",
  "px_per_mm": 0.8822,
  "num_balls": 2,
  "frames": [
    {
      "frame": 0,
      "true_ms": 0.0,
      "ball_1": {
        "x_mm": 123.4, "x_mm_unc": 0.34,
        "y_mm": 201.8, "y_mm_unc": 0.34
      },
      "ball_2": { ... }
    }
  ]
}
```

| Field                  | Type      | Units | Constraints                                          |
| ---------------------- | --------- | ----- | ---------------------------------------------------- |
| `x_mm`, `y_mm`         | `float64` | mm    | finite                                               |
| `x_mm_unc`, `y_mm_unc` | `float64` | mm    | > 0; derived from px uncertainty + scale uncertainty |

---

## 2. Internal Architecture

Module E is decomposed into four independently testable subcomponents:

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Module E Entry                             │
│             reconstruction/reconstruct.py :: run()                   │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
              ┌─────────────────▼──────────────────┐
              │  E.0 — Input Loader & Validator     │
              │  reconstruction/loader.py           │
              └─────────────────┬──────────────────┘
                                │
            ┌───────────────────▼──────────────────────┐
            │         mode == "stereo" ?                │
            └────────┬────────────────────┬────────────┘
                     │ YES                │ NO
          ┌──────────▼──────────┐  ┌─────▼──────────────┐
          │ E.1 — Triangulator  │  │ E.3 — Planar Scaler │
          │ triangulation.py    │  │ planar.py           │
          └──────────┬──────────┘  └─────┬───────────────┘
                     │                   │
          ┌──────────▼──────────┐        │
          │ E.2 — Reprojection  │        │
          │     Validator       │        │
          │ reprojection.py     │        │
          └──────────┬──────────┘        │
                     └─────────┬─────────┘
                     ┌─────────▼─────────┐
                     │ E.4 — Output      │
                     │    Serialiser     │
                     │ serialiser.py     │
                     └───────────────────┘
```

### 2.1 E.0 — Input Loader & Validator

**Purpose:** Load all input JSON files, validate structure and types, raise descriptive errors on malformed input. Returns typed Python dataclasses. No computation.

**Inputs:** Filesystem paths to `tracks.json`, `stereo_extrinsics.json` or `scale.json`, `cam{N}_intrinsics.json`, `sync.json`

**Outputs:** `ExperimentInputs` dataclass (see §3.1)

**Failure modes:**

- File not found → `ReconstructionInputError("tracks.json missing for experiment {id}")`
- Field missing → `ReconstructionInputError("tracks.json missing field 'cameras.cam1'")`
- `px_per_mm ≤ 0` → `ReconstructionInputError("px_per_mm must be positive")`
- `P0`, `P1` not 3×4 → `ReconstructionInputError("P0 must be shape [3,4]")`

### 2.2 E.1 — Triangulator

**Purpose:** For each frame and each ball, take the undistorted 2D point from cam0 and cam1, call `cv2.triangulatePoints`, divide homogeneous result to get metric 3D coordinates.

**Inputs:** `(p0: ndarray[2], p1: ndarray[2], P0: ndarray[3×4], P1: ndarray[3×4])`

**Outputs:** `(X: float64, Y: float64, Z: float64)` in metres

**Core logic:** Homogeneous linear triangulation (DLT). `cv2.triangulatePoints` implements the DLT method by constructing a 4×4 system from the two projection equations and solving via SVD.

**Failure modes:**

- Points at infinity (`W ≈ 0` in homogeneous output) → flag frame as `degenerate`, skip
- Negative `Z` (point behind camera) → flag as `behind_camera`, skip
- `Z > 20.0` metres → flag as `implausible_depth` (configurable constant)

### 2.3 E.2 — Reprojection Validator

**Purpose:** Take each triangulated 3D point, project it back into both cameras using `cv2.projectPoints`, compute Euclidean distance in pixels to the original tracked 2D point, flag frames exceeding 1.0 px threshold.

**Inputs:** `(point_3d: ndarray[3], p0_tracked: ndarray[2], p1_tracked: ndarray[2], K0: ndarray[3×3], dist0: ndarray[5], K1: ndarray[3×3], dist1: ndarray[5], R: ndarray[3×3], T: ndarray[3×1])`

**Outputs:** `(err_cam0: float64, err_cam1: float64, flagged: bool)`

**Failure modes:**

- `cv2.projectPoints` fails → log warning, set errors to `NaN`, flag frame

### 2.4 E.3 — Planar Scaler

**Purpose:** Convert pixel coordinates to millimetres using the ruler scale factor. Attach uncertainty. Y-axis is inverted to convert image convention (Y-down) to physical convention (Y-up).

**Inputs:** `(x_px: float64, y_px: float64, px_per_mm: float64, tracking_uncertainty_px: float64, scale_uncertainty_px_per_mm: float64, frame_height_px: int)`

**Outputs:** `(x_mm: float64, x_mm_unc: float64, y_mm: float64, y_mm_unc: float64)`

**Core logic:**

```
x_mm = x_px / px_per_mm
y_mm = (frame_height_px - y_px) / px_per_mm   ← Y-flip for physical up=positive
```

Uncertainty propagation (first-order):

```
σ_x_mm = sqrt((σ_px / px_per_mm)² + (x_px · σ_scale / px_per_mm²)²)
```

**Failure modes:**

- `px_per_mm ≤ 0` → caught at loader stage; should never reach here

### 2.5 E.4 — Output Serialiser

**Purpose:** Merge sync timestamps into per-frame records, construct output dicts, serialise to JSON with controlled precision (`float64` → 6 decimal places in JSON). Write output files.

**Inputs:** Per-frame position records, `sync.json` mapping, output directory path

**Outputs:** Written files: `positions_3d.json` or `positions_2d_metric.json`, `reprojection_report.json`

**Failure modes:**

- `sync.json` has no entry for a frame index → use `null` for `true_ms`, log warning

---

## 3. Data Contracts & Interfaces

### 3.1 Python dataclasses

```python
# reconstruction/types.py

from dataclasses import dataclass, field
from typing import Optional
import numpy as np

@dataclass
class TrackedPoint:
    frame: int            # uint32, frame index
    x: float              # float64, pixels (undistorted)
    y: float              # float64, pixels (undistorted)
    confidence: float     # float32, [0.0, 1.0]

@dataclass
class BallTrack:
    ball_id: int                         # 1-indexed
    cam0: list[TrackedPoint]
    cam1: Optional[list[TrackedPoint]]   # None in single-camera mode

@dataclass
class StereoCalibration:
    K0: np.ndarray    # shape [3,3], float64
    dist0: np.ndarray # shape [5],   float64
    K1: np.ndarray    # shape [3,3], float64
    dist1: np.ndarray # shape [5],   float64
    R: np.ndarray     # shape [3,3], float64
    T: np.ndarray     # shape [3,1], float64
    P0: np.ndarray    # shape [3,4], float64
    P1: np.ndarray    # shape [3,4], float64

@dataclass
class ScaleCalibration:
    px_per_mm: float           # float64, > 0
    physical_distance_mm: float
    pixel_distance: float
    # Derived uncertainty: assume ruler placement error of ±1 px each end → ±sqrt(2) px total
    # scale_uncertainty = (sqrt(2) / physical_distance_mm) px/mm
    scale_uncertainty_px_per_mm: float  # float64

@dataclass
class ExperimentInputs:
    mode: str                          # "stereo" | "single"
    num_balls: int                     # 1, 2, or 3
    ball_tracks: list[BallTrack]
    sync_map: dict[int, float]         # frame_index → true_ms
    stereo_cal: Optional[StereoCalibration]
    scale_cal: Optional[ScaleCalibration]
    frame_height_px: int               # needed for Y-flip in planar mode

@dataclass
class Position3D:
    frame: int
    true_ms: Optional[float]
    X: float; X_unc: float
    Y: float; Y_unc: float
    Z: float; Z_unc: float
    reprojection_error_cam0_px: Optional[float]
    reprojection_error_cam1_px: Optional[float]
    flagged: bool
    flag_reason: Optional[str]   # "high_reprojection" | "degenerate" | "behind_camera" | "implausible_depth"

@dataclass
class Position2DMetric:
    frame: int
    true_ms: Optional[float]
    x_mm: float; x_mm_unc: float
    y_mm: float; y_mm_unc: float
```

### 3.2 Public function signatures

```python
# reconstruction/reconstruct.py

def run(
    experiment_dir: str,    # absolute path to experiments/{id}/
    mode: str               # "stereo" | "single"
) -> ReconstructionResult:
    """
    Entry point. Loads all inputs, dispatches to stereo or planar pipeline,
    writes output JSON files.

    Returns:
      ReconstructionResult.success: bool
      ReconstructionResult.output_paths: dict[str, str]  # file paths written
      ReconstructionResult.summary: dict                  # reprojection summary (stereo) or scale info
      ReconstructionResult.error: Optional[str]
    """

# reconstruction/triangulation.py

def triangulate_point(
    p0: np.ndarray,   # shape [2], float64, undistorted px
    p1: np.ndarray,   # shape [2], float64, undistorted px
    P0: np.ndarray,   # shape [3,4], float64
    P1: np.ndarray    # shape [3,4], float64
) -> tuple[np.ndarray, str | None]:
    """
    Returns: (point_3d [shape 3, float64, metres], flag_reason or None)
    """

# reconstruction/reprojection.py

def compute_reprojection_error(
    point_3d: np.ndarray,      # shape [3], float64, metres
    p0_tracked: np.ndarray,    # shape [2], float64, px
    p1_tracked: np.ndarray,    # shape [2], float64, px
    K0: np.ndarray,            # shape [3,3]
    dist0: np.ndarray,         # shape [5]
    K1: np.ndarray,            # shape [3,3]
    dist1: np.ndarray,         # shape [5]
    R: np.ndarray,             # shape [3,3]
    T: np.ndarray              # shape [3,1]
) -> tuple[float, float, bool]:
    """
    Returns: (err_cam0_px, err_cam1_px, flagged)
    flagged = True if max(err_cam0, err_cam1) >= REPROJECTION_THRESHOLD_PX
    """

# reconstruction/planar.py

def scale_to_metric(
    x_px: float,
    y_px: float,
    frame_height_px: int,
    scale_cal: ScaleCalibration,
    tracking_uncertainty_px: float = 0.3   # from SAM2 + Gaussian centroid
) -> Position2DMetric:
    """
    Returns Position2DMetric with uncertainty.
    """

# reconstruction/loader.py

def load_inputs(experiment_dir: str, mode: str) -> ExperimentInputs:
    """
    Raises ReconstructionInputError on any validation failure.
    """
```

### 3.3 Constants file

```python
# reconstruction/constants.py

REPROJECTION_THRESHOLD_PX: float = 1.0      # flag if any reprojection error >= this
IMPLAUSIBLE_DEPTH_METRES: float = 20.0       # flag if Z >= this
MIN_HOMOGENEOUS_W: float = 1e-9              # treat as degenerate if |W| < this
TRACKING_UNCERTAINTY_PX: float = 0.3        # from accuracy budget §11
JSON_FLOAT_PRECISION: int = 6               # decimal places in output JSON
```

### 3.4 File naming and paths

```
experiments/{id}/
  results/
    positions_3d.json           ← E.1/E.2 stereo output
    positions_2d_metric.json    ← E.3 single-camera output
    reprojection_report.json    ← E.2 validation report (stereo only)
```

### 3.5 Coordinate systems — explicit

**Stereo 3D output:**

- Origin: optical centre of cam0
- X: right (in cam0 image plane)
- Y: up (against image Y convention — Y is flipped)
- Z: into scene (away from cam0)
- Units: metres
- Right-handed

**Single-camera 2D metric output:**

- Origin: top-left pixel of cam0 image, then Y-flipped
- X: right
- Y: up (Y-flipped from image convention so positive Y = upward physical motion)
- Units: mm

---

## 4. Algorithmic Implementation

### 4.1 E.1 — Triangulation Algorithm

#### Background: DLT via `cv2.triangulatePoints`

Given:

- `P0` (3×4 projection matrix for cam0)
- `P1` (3×4 projection matrix for cam1)
- `p0 = [u0, v0]ᵀ` (2D point in cam0, undistorted normalised or pixel coords consistent with P)
- `p1 = [u1, v1]ᵀ` (2D point in cam1)

The DLT method constructs a 4×4 system `A·X_h = 0` from the two projection equations:

```
u0 · (P0[2,:]·X_h) - P0[0,:]·X_h = 0
v0 · (P0[2,:]·X_h) - P0[1,:]·X_h = 0
u1 · (P1[2,:]·X_h) - P1[0,:]·X_h = 0
v1 · (P1[2,:]·X_h) - P1[1,:]·X_h = 0
```

Solved via SVD: smallest singular value's right singular vector = `X_h = [X, Y, Z, W]ᵀ`.

Homogeneous → Cartesian: `[X/W, Y/W, Z/W]` in metres.

#### Full numbered procedure per frame per ball

```
INPUTS:
  p0 = undistorted tracked pixel [u0, v0]  (float64)
  p1 = undistorted tracked pixel [u1, v1]  (float64)
  P0, P1                                    (3×4 float64)

STEP 1 — Reshape for OpenCV:
  p0_cv = np.array([[[u0, v0]]], dtype=np.float64)   # shape [1,1,2]
  p1_cv = np.array([[[u1, v1]]], dtype=np.float64)

STEP 2 — Triangulate:
  point_4d = cv2.triangulatePoints(P0, P1, p0_cv.T, p1_cv.T)
  # point_4d shape: [4, 1], dtype float64
  # NOTE: cv2.triangulatePoints expects shape [2,N] for point arrays
  # Correct call:
  point_4d = cv2.triangulatePoints(P0, P1,
                                    p0_cv.reshape(2,1).astype(np.float64),
                                    p1_cv.reshape(2,1).astype(np.float64))

STEP 3 — Homogeneous division:
  W = point_4d[3, 0]
  IF |W| < MIN_HOMOGENEOUS_W:
    RETURN flag_reason = "degenerate"

  X = point_4d[0, 0] / W
  Y = point_4d[1, 0] / W
  Z = point_4d[2, 0] / W

STEP 4 — Sanity checks:
  IF Z < 0:
    RETURN flag_reason = "behind_camera"
  IF Z > IMPLAUSIBLE_DEPTH_METRES:
    RETURN flag_reason = "implausible_depth"

STEP 5 — Uncertainty estimation (analytical, first-order):
  # Stereo position uncertainty from tracking pixel uncertainty σ_px = 0.3 px
  # Baseline b = |T| (metres), focal length f = P0[0,0] (pixels)
  # Depth uncertainty (z-direction):
  #   σ_Z ≈ (Z² · σ_px) / (f · b)
  # Lateral uncertainty (x/y direction at depth Z):
  #   σ_XY ≈ (Z · σ_px) / f
  f  = P0[0, 0]                    # focal length in pixels (from calibration)
  b  = np.linalg.norm(T)           # baseline in metres
  sigma_px = TRACKING_UNCERTAINTY_PX

  sigma_Z  = (Z**2 * sigma_px) / (f * b)
  sigma_XY = (Z * sigma_px) / f

STEP 6 — Return:
  RETURN point_3d = [X, Y, Z],
         uncertainties = [sigma_XY, sigma_XY, sigma_Z],
         flag_reason = None
```

#### Projection matrix derivation (fallback if P0/P1 not stored)

If only `K0`, `K1`, `R`, `T` are available, derive projection matrices:

```python
# Camera 0 is world origin:
R0 = np.eye(3)
t0 = np.zeros((3, 1))
RT0 = np.hstack([R0, t0])       # [3×4]
P0 = K0 @ RT0

# Camera 1:
RT1 = np.hstack([R, T])         # [3×4]
P1 = K1 @ RT1
```

> **Note:** This gives projection matrices for un-rectified stereo. For rectified stereo (post `cv2.stereoRectify`), use the `P1`, `P2` output of `stereoRectify` directly. The triangulation call is identical.

### 4.2 E.2 — Reprojection Validation Algorithm

```
INPUTS:
  point_3d = [X, Y, Z]          (metres, float64)
  p0_tracked = [u0, v0]         (px, float64)
  p1_tracked = [u1, v1]         (px, float64)
  K0, dist0, K1, dist1          (calibration)
  R, T                          (stereo extrinsics)

STEP 1 — Project 3D → cam0:
  # Cam0 is world origin, so rvec=zeros, tvec=zeros
  rvec0 = np.zeros((3,1), dtype=np.float64)
  tvec0 = np.zeros((3,1), dtype=np.float64)
  p0_reproj, _ = cv2.projectPoints(
      point_3d.reshape(1,3),
      rvec0, tvec0,
      K0, dist0
  )
  # p0_reproj shape: [1,1,2]
  p0_reproj = p0_reproj[0,0]    # [u_reproj, v_reproj]

STEP 2 — Reprojection error cam0:
  err_cam0 = np.linalg.norm(p0_reproj - p0_tracked)

STEP 3 — Project 3D → cam1:
  # cam1 is at rotation R, translation T relative to cam0
  rvec1, _ = cv2.Rodrigues(R)
  p1_reproj, _ = cv2.projectPoints(
      point_3d.reshape(1,3),
      rvec1, T,
      K1, dist1
  )
  p1_reproj = p1_reproj[0,0]

STEP 4 — Reprojection error cam1:
  err_cam1 = np.linalg.norm(p1_reproj - p1_tracked)

STEP 5 — Flag:
  flagged = (max(err_cam0, err_cam1) >= REPROJECTION_THRESHOLD_PX)

STEP 6 — Return:
  RETURN (err_cam0, err_cam1, flagged)
```

### 4.3 E.3 — Single-Camera Planar Scaling Algorithm

```
INPUTS:
  x_px, y_px                  (float64, image pixel coords)
  frame_height_px              (int)
  px_per_mm                    (float64)
  scale_uncertainty_px_per_mm  (float64)
  tracking_uncertainty_px      (float64 = 0.3)

STEP 1 — Y-flip (image Y-down → physical Y-up):
  y_px_flipped = frame_height_px - y_px

STEP 2 — Convert to mm:
  x_mm = x_px          / px_per_mm
  y_mm = y_px_flipped  / px_per_mm

STEP 3 — Uncertainty propagation (first-order, sum in quadrature):

  For x_mm = f(x_px, s) where s = px_per_mm:
    ∂x_mm/∂x_px = 1/s
    ∂x_mm/∂s   = -x_px / s²

  σ_x_mm = sqrt((σ_px / s)² + (x_px · σ_s / s²)²)
  σ_y_mm = sqrt((σ_px / s)² + (y_px_flipped · σ_s / s²)²)

STEP 4 — Scale uncertainty derivation:
  # Ruler: two endpoints placed with ±0.5 px uncertainty each
  # Combined endpoint uncertainty: sqrt(0.5² + 0.5²) = 0.707 px on pixel_distance
  # s = pixel_distance / physical_distance_mm
  # σ_s = 0.707 / physical_distance_mm  (px/mm)
  # This is computed in the loader and stored in ScaleCalibration.scale_uncertainty_px_per_mm

STEP 5 — Return:
  RETURN Position2DMetric(
      x_mm=x_mm, x_mm_unc=σ_x_mm,
      y_mm=y_mm, y_mm_unc=σ_y_mm,
      ...
  )
```

### 4.4 Full stereo pipeline (E.1 + E.2 combined, per-ball loop)

```python
# Pseudocode — reconstruction/reconstruct.py :: _run_stereo()

def _run_stereo(inputs: ExperimentInputs) -> list[dict]:
    results = []
    cal = inputs.stereo_cal

    for frame_idx in range(inputs.num_frames):
        frame_record = {"frame": frame_idx,
                        "true_ms": inputs.sync_map.get(frame_idx, None)}

        for ball in inputs.ball_tracks:
            pt0 = get_point_at_frame(ball.cam0, frame_idx)
            pt1 = get_point_at_frame(ball.cam1, frame_idx)

            if pt0 is None or pt1 is None:
                # Frame missing from tracking — skip, mark as gap
                frame_record[f"ball_{ball.ball_id}"] = {"flagged": True,
                                                         "flag_reason": "tracking_gap"}
                continue

            # E.1 — Triangulate
            p0 = np.array([pt0.x, pt0.y], dtype=np.float64)
            p1 = np.array([pt1.x, pt1.y], dtype=np.float64)
            point_3d, unc, flag_reason = triangulate_point(p0, p1, cal.P0, cal.P1,
                                                            cal.T)

            if flag_reason is not None:
                frame_record[f"ball_{ball.ball_id}"] = {
                    "flagged": True, "flag_reason": flag_reason,
                    "X": None, "Y": None, "Z": None
                }
                continue

            # E.2 — Validate
            err0, err1, flagged = compute_reprojection_error(
                point_3d, p0, p1,
                cal.K0, cal.dist0, cal.K1, cal.dist1,
                cal.R, cal.T
            )

            frame_record[f"ball_{ball.ball_id}"] = {
                "X": point_3d[0], "X_unc": unc[0],
                "Y": point_3d[1], "Y_unc": unc[1],
                "Z": point_3d[2], "Z_unc": unc[2],
                "reprojection_error_cam0_px": err0,
                "reprojection_error_cam1_px": err1,
                "flagged": flagged,
                "flag_reason": "high_reprojection" if flagged else None
            }

        results.append(frame_record)

    return results
```

---

## 5. Execution Model

### 5.1 Invocation type

**Synchronous, blocking.** Module E is called once per experiment after tracking completes. It is not streaming. Total execution time expected: < 1 second for 300 frames × 3 balls (triangulation is sub-millisecond per point; reprojection adds ~0.5 ms per point).

### 5.2 Trigger condition

Called from `grpc_server.py` inside the `ComputePhysics` RPC handler, after `tracks.json` exists:

```python
# grpc_server.py
def ComputePhysics(request, context):
    experiment_dir = resolve_experiment_dir(request.experiment_id)
    mode = load_metadata(experiment_dir)["mode"]

    result = reconstruction.run(experiment_dir, mode)   # ← Module E entry
    if not result.success:
        context.abort(grpc.StatusCode.INTERNAL, result.error)

    physics_result = physics.run(experiment_dir)
    return physics_result
```

### 5.3 Concurrency model

**Single-threaded.** No parallelism needed. The inner loops are:

- `O(N_frames × N_balls)` triangulations — all CPU-bound numpy ops, microseconds each
- `O(N_frames × N_balls)` reprojections — same

If `N_frames > 1000` (unusual), parallelism with `concurrent.futures.ThreadPoolExecutor` per ball is straightforward but not required.

### 5.4 Timing model

No real-time constraints. Post-processing only. Complete in under 5 seconds on any modern CPU for any plausible experiment length.

---

## 6. State & Data Flow

```
tracks.json ──────────────────────────────────────────────┐
stereo_extrinsics.json ──── E.0 Loader ─────────────────► │
cam0_intrinsics.json    ──────────────                     │
cam1_intrinsics.json    ──────────────                     ▼
sync.json ──────────────────────────────       ExperimentInputs (RAM)
                                                           │
                                               ┌───────────▼───────────┐
                                               │     mode == stereo?    │
                                               └──┬────────────────┬───┘
                                                  │ YES             │ NO
                                          ────────▼──────   ───────▼──────
                                          per frame/ball    per frame/ball
                                          ────────▼──────   ───────▼──────
                                          triangulate()     scale_to_metric()
                                                  │
                                          ────────▼──────
                                          reprojection_error()
                                          ────────▼──────
                                          Position3D record (RAM)
                                                  │         │
                                          ─────────────────────────────
                                          E.4 Serialiser (assembles all frames)
                                          ─────────────────────────────
                                                  │
                                     ┌────────────┼──────────────────┐
                                     ▼            ▼                  ▼
                          positions_3d.json  reprojection_report.json
                          (or positions_2d_metric.json)
```

**What is retained:** Input files on disk (unchanged). Output JSON files on disk.  
**What is discarded:** All in-RAM intermediate arrays after serialisation.  
**What is recalculated:** Nothing — module is idempotent; re-running overwrites output files.

---

## 7. Integration Points

### 7.1 Call sequence — stereo mode

```
1. gRPC client (Node.js) calls ComputePhysics({experiment_id})
2. grpc_server.py resolves experiment_dir
3. grpc_server.py calls reconstruction.run(experiment_dir, "stereo")
4. E.0 Loader reads: tracks.json, stereo_extrinsics.json, cam0_intrinsics.json,
                      cam1_intrinsics.json, sync.json
5. E.1 Triangulator called per (frame, ball)
6. E.2 Reprojection Validator called per (frame, ball)
7. E.4 Serialiser writes positions_3d.json, reprojection_report.json
8. reconstruction.run() returns ReconstructionResult
9. grpc_server.py passes experiment_dir to physics.run()
10. physics.run() reads positions_3d.json (Module F consumes E's output)
11. grpc_server.py returns PhysicsResult to Node.js
```

### 7.2 Call sequence — single-camera mode

```
1. Steps 1–3 as above, mode = "single"
2. E.0 Loader reads: tracks.json, scale.json, sync.json, cam0_intrinsics.json
3. E.3 Planar Scaler called per (frame, ball)
4. E.4 Serialiser writes positions_2d_metric.json
5. Steps 8–11 as above; physics.run() reads positions_2d_metric.json
```

### 7.3 Error propagation

```python
class ReconstructionInputError(Exception): pass   # bad input — gRPC INVALID_ARGUMENT
class ReconstructionComputeError(Exception): pass  # triangulation failure — gRPC INTERNAL
```

All exceptions propagate to `grpc_server.py`, which maps them to gRPC status codes and returns a structured error to Node.js. Node.js relays the error to the UI via WebSocket.

### 7.4 Timeouts / retries

No timeouts within Module E (synchronous, fast). The gRPC `ComputePhysics` RPC has a 60-second deadline set on the Node.js client side — well beyond any realistic execution time.

---

## 8. Edge Cases & Failure Handling

| Scenario                                                            | Detection                                                      | Recovery                                                                                                                    |
| ------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| **Tracking gap** — a frame is missing from `tracks.json` for a ball | `get_point_at_frame()` returns `None`                          | Skip that (frame, ball) pair; mark as `tracking_gap` in output; physics engine handles gaps via robust fitting              |
| **Degenerate triangulation** — nearly parallel rays (`W ≈ 0`)       | `                                                              | W                                                                                                                           | < MIN_HOMOGENEOUS_W` check in Step 3 | Flag frame as `degenerate`; exclude from physics; log at WARNING level |
| **Ball behind camera** — `Z < 0`                                    | Sign check on `Z`                                              | Flag as `behind_camera`; indicates stereo calibration error — log at ERROR level                                            |
| **High reprojection error** — `> 1.0 px`                            | Threshold check in E.2                                         | Flag frame; include in `reprojection_report.json`; physics engine receives flagged frames but fitting is robust to outliers |
| **Stereo calibration drift** — many frames all flagged              | Count flagged frames; if `> 30%` of total, emit global warning | Log `CALIBRATION_QUALITY_WARNING`; do not abort — partial results are better than none                                      |
| **Scale calibration missing** (single mode)                         | `scale.json` file not found at load time                       | `ReconstructionInputError` — halt with descriptive message                                                                  |
| **Negative `px_per_mm`**                                            | Validation in E.0 Loader                                       | `ReconstructionInputError`                                                                                                  |
| **Single ball tracked in one camera only** (stereo)                 | `ball.cam1 is None` or missing frames                          | Skip triangulation for that ball; emit WARNING; continue with remaining balls                                               |
| **Implausible depth** (`Z > 20 m`)                                  | Threshold check                                                | Flag as `implausible_depth`; likely a stereo calibration issue; log at WARNING                                              |

### 8.1 Simulation / testing of failures

- **Degenerate triangulation:** Set `p0 = p1` with matching projection matrices → forces collinear rays
- **High reprojection error:** Introduce a known 5px offset to tracked coordinates before calling triangulation
- **Behind camera:** Manually construct a test 3D point at `Z = -1.0`, project to both cameras, triangulate → should return `behind_camera` flag

### 8.2 Logs and metrics emitted

| Event                       | Level   | Fields                                                                     |
| --------------------------- | ------- | -------------------------------------------------------------------------- |
| Module entry                | INFO    | `experiment_id`, `mode`, `num_balls`, `num_frames`                         |
| Per-frame flag              | WARNING | `frame`, `ball_id`, `flag_reason`, `err_cam0`, `err_cam1`                  |
| Behind-camera detection     | ERROR   | `frame`, `ball_id`, `Z`                                                    |
| Calibration quality warning | WARNING | `pct_flagged`, `num_flagged`, `num_frames`                                 |
| Module complete             | INFO    | `duration_ms`, `num_flagged`, `mean_reprojection_error_px`, `output_files` |

---

## 9. Accuracy & Error Sources

### 9.1 Stereo triangulation error budget

| Source                                                | Magnitude                      | Propagation                               |
| ----------------------------------------------------- | ------------------------------ | ----------------------------------------- |
| Tracking pixel uncertainty (SAM2 + Gaussian centroid) | ±0.3 px                        | σ_Z ≈ Z²·σ_px/(f·b); σ_XY ≈ Z·σ_px/f      |
| Stereo calibration reprojection error                 | < 0.5 px RMS                   | Absorbed into effective pixel uncertainty |
| Lens distortion residual (post undistortion)          | < 0.1 px                       | Absorbed                                  |
| Floating point precision                              | ~1e-14 relative                | Negligible                                |
| **Total (at Z=1.5m, f=1400px, b=0.3m)**               | **σ_Z ≈ 1.6mm, σ_XY ≈ 0.32mm** | Consistent with ±0.5mm budget             |

Depth uncertainty σ_Z scales as Z². At Z = 1.5m with typical parameters:

```
σ_Z  = (1.5² × 0.3) / (1400 × 0.3) = 0.675 / 420 ≈ 1.6 mm
σ_XY = (1.5  × 0.3) / 1400          = 0.45  / 1400 ≈ 0.32 mm
```

This gives ±0.5mm or better at working distances up to ~2m, consistent with §11 budget.

### 9.2 Single-camera planar error budget

| Source                                          | Magnitude                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| Tracking pixel uncertainty                      | ±0.3 px                                                          |
| Ruler placement uncertainty                     | ±0.5 px per endpoint → ±0.71 px total                            |
| Combined scale uncertainty (1m ruler, 882 px)   | σ_s ≈ 0.71/1000 = 0.00071 px/mm                                  |
| **Position uncertainty (at 500px from origin)** | σ_x ≈ sqrt((0.3/0.88)² + (500 × 0.00071 / 0.88²)²) ≈ **0.34 mm** |

### 9.3 Error propagation chain

```
Tracking pixel uncertainty (±0.3 px)
    → triangulation depth uncertainty (σ_Z ∝ Z²)
    → lateral position uncertainty (σ_XY ∝ Z)
        → velocity fit uncertainty (via SciPy curve_fit covariance)
            → momentum uncertainty (via uncertainties library)
                → final reported ± on all physics quantities
```

No error is discarded. All uncertainties in `positions_3d.json` are consumed by the physics engine and propagated via the `uncertainties` library.

---

## 10. Testing Strategy

### 10.1 Unit tests

#### `test_triangulation.py`

**T1 — Perfect synthetic reconstruction:**

```python
# Known 3D point at [0.1, 0.0, 2.0] metres
# Project to cam0 and cam1 using known P0, P1
# Triangulate from projected points
# Assert: |reconstructed - true| < 0.001 m in all axes
```

**T2 — Degenerate detection:**

```python
# p0 == p1, parallel projection matrices
# Assert: flag_reason == "degenerate"
```

**T3 — Behind-camera detection:**

```python
# Construct point at Z = -1.0, project, triangulate
# Assert: flag_reason == "behind_camera"
```

**T4 — Implausible depth detection:**

```python
# Point at Z = 25.0 m
# Assert: flag_reason == "implausible_depth"
```

**T5 — Uncertainty scaling:**

```python
# Triangulate same point at Z=1m and Z=2m
# Assert: σ_Z(2m) ≈ 4 × σ_Z(1m)  (quadratic depth dependence)
```

#### `test_reprojection.py`

**T6 — Zero-error case:**

```python
# Perfect calibration, perfect 3D point
# Project back, assert: err_cam0 < 1e-5, err_cam1 < 1e-5, flagged = False
```

**T7 — Threshold boundary:**

```python
# Introduce exactly 0.999 px error → flagged = False
# Introduce exactly 1.000 px error → flagged = True
```

**T8 — Camera 1 error propagation:**

```python
# Perturb only p1_tracked by 2px
# Assert: err_cam1 ≈ 2.0 px, err_cam0 near zero, flagged = True
```

#### `test_planar.py`

**T9 — Known metric conversion:**

```python
# scale_cal: 882 px = 1000 mm → px_per_mm = 0.882
# Point at (441, 540), frame_height = 1080
# Expected: x_mm = 500.0, y_mm = (1080 - 540) / 0.882 = 612.2 mm
# Assert to within 0.01 mm
```

**T10 — Y-flip correctness:**

```python
# Point at top of image (y=0) should have max y_mm
# Point at bottom (y=frame_height) should have y_mm ≈ 0
```

**T11 — Uncertainty increases with distance from origin:**

```python
# σ_x_mm at x=1000px > σ_x_mm at x=100px  (due to scale uncertainty term)
```

#### `test_loader.py`

**T12 — Missing file raises descriptive error:**

```python
with pytest.raises(ReconstructionInputError, match="scale.json"):
    load_inputs(experiment_dir_without_scale, "single")
```

**T13 — Bad P0 shape raises error:**

```python
# Write stereo_extrinsics.json with P0 shape [3,3]
with pytest.raises(ReconstructionInputError, match="P0 must be shape"):
    load_inputs(experiment_dir, "stereo")
```

### 10.2 Integration test

**T14 — Full pipeline synthetic experiment:**

```python
# Generate 50 frames of a ball moving linearly in 3D
# Project to two cameras, add ±0.2 px Gaussian noise
# Write synthetic tracks.json, stereo_extrinsics.json
# Run reconstruction.run()
# Assert: all 50 positions within 1mm of true trajectory
# Assert: all reprojection errors < 1.0 px
# Assert: output files written correctly
```

### 10.3 Real-world validation

After Sprint 4 deployment:

1. Place a reference target at a known 3D position (measured with a tape measure ± 1mm)
2. Record 5 seconds of static target with both cameras
3. Run reconstruction pipeline
4. Compare reconstructed position to measured position
5. **Pass criterion:** error < 2mm in all axes

**Metric:** Mean reprojection error on calibration checkerboard frames should be < 0.5 px. If a production session produces mean reprojection error > 0.8 px, the UI should warn "Consider recalibrating cameras."

---

## 11. Implementation Plan (Step-by-Step Build Order)

Each step is independently testable and produces observable output.

### Step 1 — File structure and types (Day 1)

```
cv-service/
  reconstruction/
    __init__.py
    types.py          ← dataclasses from §3.1
    constants.py      ← from §3.3
    loader.py         ← E.0 stub (loads and validates JSON only)
    triangulation.py  ← EMPTY
    reprojection.py   ← EMPTY
    planar.py         ← EMPTY
    reconstruct.py    ← entry point skeleton
    serialiser.py     ← EMPTY
  tests/
    test_loader.py    ← T12, T13
```

**Observable output:** `pytest tests/test_loader.py` passes. Loader correctly validates synthetic JSON fixtures.

### Step 2 — Planar scaler (Day 1–2)

Implement `planar.py` fully. Write `test_planar.py` (T9, T10, T11).

**Observable output:** `pytest tests/test_planar.py` passes. `positions_2d_metric.json` written from synthetic input.

> **Single-camera mode is now end-to-end testable.** Sprint 2 depends on this — unblock it first.

### Step 3 — Triangulation core (Day 2)

Implement `triangulation.py`. Write `test_triangulation.py` (T1–T5).

**Observable output:** `pytest tests/test_triangulation.py` passes. Confirm sub-mm accuracy on synthetic 3D points.

### Step 4 — Reprojection validator (Day 2–3)

Implement `reprojection.py`. Write `test_reprojection.py` (T6–T8).

**Observable output:** `pytest tests/test_reprojection.py` passes. Threshold boundary test confirms exact 1.0 px cutoff.

### Step 5 — Serialiser (Day 3)

Implement `serialiser.py`. Write test for output JSON schema conformance.

**Observable output:** Both `positions_3d.json` and `reprojection_report.json` written correctly from in-memory data.

### Step 6 — Integration: full stereo pipeline (Day 3–4)

Wire `reconstruct.py` entry point. Write T14 synthetic integration test.

**Observable output:** Full pipeline produces `positions_3d.json` with < 1mm error on synthetic 50-frame trajectory.

### Step 7 — gRPC integration (Day 4)

Call `reconstruction.run()` from `grpc_server.py` inside `ComputePhysics`. Verify end-to-end from Node.js gRPC call through to JSON file on disk.

**Observable output:** Running `ComputePhysics` via grpcurl produces output JSON files in the correct experiment directory.

### Step 8 — Real-world validation (Sprint 4 end)

Conduct reference target test per §10.3. Tune `IMPLAUSIBLE_DEPTH_METRES` constant if needed.

---

## 12. Performance Considerations

### 12.1 Time complexity

| Operation                  | Complexity            | Wall time (est.)                         |
| -------------------------- | --------------------- | ---------------------------------------- |
| Input loading (JSON parse) | O(N_frames × N_balls) | ~50ms for 300 frames                     |
| Triangulation              | O(N_frames × N_balls) | ~0.01ms/call → ~10ms total               |
| Reprojection validation    | O(N_frames × N_balls) | ~0.05ms/call → ~50ms total               |
| Planar scaling             | O(N_frames × N_balls) | ~0.001ms/call → ~1ms total               |
| JSON serialisation         | O(N_frames × N_balls) | ~20ms for 300 frames                     |
| **Total**                  |                       | **< 200ms for any realistic experiment** |

### 12.2 Memory usage

All intermediate data is held in RAM as Python lists of `Position3D` or `Position2DMetric`. For 300 frames × 3 balls, each with ~10 float64 fields:

```
300 × 3 × 10 × 8 bytes = 72 kB
```

Negligible. No streaming or chunking required.

### 12.3 Bandwidth

No network bandwidth consumed by this module. All I/O is local filesystem reads/writes.

### 12.4 Bottleneck

If performance ever matters (it doesn't for this system): JSON parsing of `tracks.json` for long experiments (> 1000 frames) is the likely bottleneck. Migration to binary format (numpy `.npy` or `msgpack`) would give 10–20× speedup, not needed now.

---

## 13. Observability

### 13.1 Logging

All logs via Python standard `logging` module, logger name `"reconstruction"`.

```python
import logging
log = logging.getLogger("reconstruction")

# On entry:
log.info("Starting reconstruction", extra={
    "experiment_id": experiment_id,
    "mode": mode,
    "num_balls": inputs.num_balls,
    "num_frames": inputs.num_frames
})

# Per flagged frame (WARNING):
log.warning("Frame flagged", extra={
    "frame": frame_idx,
    "ball_id": ball.ball_id,
    "flag_reason": flag_reason,
    "err_cam0_px": err0,
    "err_cam1_px": err1
})

# Calibration quality warning (WARNING):
log.warning("High fraction of flagged frames — consider recalibrating", extra={
    "pct_flagged": pct,
    "num_flagged": n_flagged,
    "num_frames": inputs.num_frames
})

# On completion (INFO):
log.info("Reconstruction complete", extra={
    "duration_ms": elapsed_ms,
    "num_flagged": n_flagged,
    "mean_reprojection_error_px": mean_err,
    "output_files": list(result.output_paths.values())
})
```

### 13.2 Metrics (exposed via FastAPI `/metrics` endpoint)

```python
{
  "reconstruction": {
    "last_run_duration_ms": 182.4,
    "last_run_num_flagged": 3,
    "last_run_mean_reprojection_error_px": 0.41,
    "last_run_max_reprojection_error_px": 0.87,
    "last_run_mode": "stereo"
  }
}
```

### 13.3 Debug hooks

- **Reprojection overlay:** `reprojection_report.json` contains per-frame per-camera reprojection errors. The frontend can visualise this as a colour-coded heatmap on the frame scrubber (red = flagged, green = good).
- **Synthetic test harness:** `reconstruction/tests/generate_synthetic.py` can generate arbitrary synthetic camera setups and export `tracks.json` + calibration files for offline debugging.
- **Verbose flag:** Pass `verbose=True` to `reconstruction.run()` to log every frame's reprojection errors at DEBUG level (not just flagged ones).

---

## 14. Future Improvements

| Simplification made                              | Potential upgrade                                                                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First-order uncertainty propagation (analytical) | Full Monte Carlo uncertainty propagation: perturb input points by σ_px 1000× and measure 3D scatter                                                                                               |
| Isotropic scale factor (single camera)           | Two-ruler calibration: one horizontal, one vertical, for anisotropic scale correction                                                                                                             |
| Identity rvec/tvec for cam0 projection           | No change needed — cam0 always at world origin in this architecture                                                                                                                               |
| Uniform TRACKING_UNCERTAINTY_PX = 0.3            | Per-frame confidence-weighted uncertainty: σ_px_i = 0.3 / confidence_i                                                                                                                            |
| No bundle adjustment                             | Full bundle adjustment via SciPy optimisation over all frames simultaneously: minimise total reprojection error across all points jointly — reduces systematic bias from calibration imperfection |
| No outlier rejection                             | RANSAC-style triangulation: for each frame, triangulate 3× with jittered inputs, reject outliers by reprojection error                                                                            |
