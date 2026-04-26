# Module F — Physics Analysis System

## Full Implementation Plan

> **System:** PhysicsCapture v1.2
> **Target module group:** F. Physics Analysis System
> **Submodules in scope:** Velocity Estimation · Collision Detection · Momentum & Energy · Uncertainty Propagation · Friction Modelling
> **Language / runtime:** Python 3.11 — `packages/cv-service/physics/`
> **Plan version:** 1.0

---

## 0. Relevant Context Extraction

### 0.1 Upstream dependencies

| Provider                                                     | What it provides                                                          | Exact artefact                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Sync module (`sync/timestamp_array.py`)                      | Master timestamp array: `frame_index → true_ms`                           | `experiments/{id}/results/sync.json`                                          |
| Tracking module (`tracking/sam2_tracker.py`, `centroid.py`)  | Sub-pixel ball centroids per frame per camera                             | `experiments/{id}/results/tracks.json`                                        |
| Calibration module (`calibration/intrinsic.py`, `stereo.py`) | px→mm scale factor (single-cam) or stereo projection matrices (multi-cam) | `experiments/{id}/calibration/cam0_intrinsics.json`, `stereo_extrinsics.json` |
| Session Setup (Frontend → Node → gRPC)                       | Mass per ball (g), mass uncertainty per ball (g), number of balls (1–3)   | Embedded in `PhysicsRequest` protobuf message                                 |

### 0.2 Downstream consumers

| Consumer                              | What it reads                                                                   | Where it reads it                                           |
| ------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Node.js gRPC layer (`grpc-client.ts`) | `PhysicsResult` protobuf message (velocities, momenta, KE, CoR, % conservation) | gRPC streaming response                                     |
| Node.js file storage (`storage.ts`)   | JSON representations of all physics outputs                                     | `experiments/{id}/results/velocities.json`, `momentum.json` |
| React Results screen                  | All output values with uncertainties                                            | Via WebSocket relay from Node                               |

### 0.3 Required data formats

**`sync.json`** (written by sync module, read-only to physics module):

```json
{
  "experiment_id": "string",
  "cameras": {
    "cam0": {
      "frame_count": 900,
      "true_fps": 29.97,
      "phase_offset_ms": 0.0,
      "timestamps_ms": [0.0, 33.37, 66.74, ...]
    },
    "cam1": {
      "frame_count": 890,
      "true_fps": 29.94,
      "phase_offset_ms": 11.2,
      "timestamps_ms": [11.2, 44.57, 77.94, ...]
    }
  },
  "sync_residual_ms": 0.18
}
```

`timestamps_ms[i]` is the true wall-clock time (ms) of frame `i` for that camera, relative to a shared epoch defined as t=0 of cam0 frame 0. This is the canonical time axis for all physics fitting.

**`tracks.json`** (written by tracking module, read-only to physics module):

```json
{
  "experiment_id": "string",
  "balls": [
    {
      "ball_id": 0,
      "camera_id": 0,
      "frames": [
        { "frame_idx": 0, "x_px": 142.3, "y_px": 480.1, "confidence": 0.98 },
        { "frame_idx": 1, "x_px": 165.7, "y_px": 480.4, "confidence": 0.96 },
        ...
      ]
    }
  ]
}
```

**Scale calibration** (`cam0_intrinsics.json`, relevant field):

```json
{
  "scale_px_per_mm": 3.142,
  "scale_uncertainty_px_per_mm": 0.008
}
```

**`PhysicsRequest`** (gRPC input):

```protobuf
message PhysicsRequest {
  string experiment_id = 1;
  repeated BallMass masses = 2;
  PhysicsMode mode = 3;          // PLANAR_SINGLE_CAM or STEREO_3D
  FrictionMode friction = 4;     // IGNORE or COMPENSATE
}
message BallMass {
  int32  ball_id         = 1;
  float  mass_g          = 2;   // grams
  float  uncertainty_g   = 3;   // default 1.0
}
enum PhysicsMode { PLANAR_SINGLE_CAM = 0; STEREO_3D = 1; }
enum FrictionMode { IGNORE = 0; COMPENSATE = 1; }
```

### 0.4 Execution environment

- **Runtime:** Python 3.11, inside Docker container (`cv-service`)
- **Invocation path:** Node.js → gRPC → `grpc_server.py` → `physics/fitting.py` + `physics/momentum.py`
- **All processing is post-hoc** — no real-time constraint; correctness > speed
- **Libraries:** `scipy`, `numpy`, `uncertainties` (all CPU-only; no GPU required for this module)

### 0.5 Hardware / timing constraints inherited

- Frame rate: 30 fps nominal; true fps derived from sync module (typically 29.94–30.06)
- Timestamp precision: < 0.5 ms (from sync module residuals); treat as exact for fitting purposes
- Position measurement uncertainty: ±0.3 px (from tracking module Gaussian centroid fit)
- Mass uncertainty: ±1 g default (user-overridable)

### 0.6 Explicit assumptions

| #   | Assumption                                                                                 | Rationale                               |
| --- | ------------------------------------------------------------------------------------------ | --------------------------------------- |
| A1  | `sync.json` and `tracks.json` always exist and are valid before `ComputePhysics` is called | Node.js enforces job ordering           |
| A2  | Ball motion in the primary analysis window is approximately planar (single-cam mode)       | System design decision §14 item 2       |
| A3  | Balls are solid uniform spheres (I = 2/5·mr²) — rolling without slipping                   | System design decision §14 item 8       |
| A4  | Collision occupies at most 5 frames (< 167 ms at 30 fps)                                   | True for billiard/steel ball collisions |
| A5  | Velocity sign convention: positive = direction of initial motion of ball 0                 | Defined here; communicated to frontend  |
| A6  | Friction deceleration is constant over the pre-collision window                            | Linear deceleration model only          |
| A7  | At most 3 balls per experiment                                                             | System design decision §14 item 3       |
| A8  | Frames with confidence < 0.7 have already been manually corrected before this module runs  | Tracking module responsibility          |
| A9  | In single-camera mode the scale factor is the same for x and y (isotropic pixel pitch)     | Standard for digital cameras            |

### 0.7 Module boundary

**Inside this module:**

- Loading tracks and timestamps from JSON files on disk
- Converting pixel positions → metric positions (mm)
- Fitting kinematic models to position data
- Collision zone detection
- Velocity extraction with covariance-derived uncertainties
- Momentum, KE, CoR, and % conservation calculations
- Friction detection and optional compensation
- Writing `velocities.json`, `momentum.json`
- Returning `PhysicsResult` via gRPC

**Outside this module (treated as black boxes):**

- SAM2 tracking and centroid extraction
- Sync Marker decoding (Gray code + grating phase) and timestamp generation
- Camera calibration and stereo triangulation
- All UI, WebSocket relay, and file upload logic

---

## 1. Module Definition

### 1.1 Responsibility

The Physics Analysis module ingests per-frame ball positions (in pixels) and their true timestamps (in ms), converts them to metric positions, fits kinematic models before and after each collision, extracts velocities with full uncertainty estimates from the covariance matrix, and computes all derived physics quantities (momentum, kinetic energy, coefficient of restitution, % momentum conserved). All values carry automatic uncertainty propagation via the `uncertainties` library.

### 1.2 Non-goals

- Ball tracking (upstream)
- Synchronisation / timestamp generation (upstream)
- Stereo triangulation (upstream — positions arrive pre-converted if stereo mode)
- Displaying or formatting results (downstream)
- Real-time computation

### 1.3 Inputs (fully typed)

| Field                     | Type      | Units        | Shape  | Constraints                               |
| ------------------------- | --------- | ------------ | ------ | ----------------------------------------- |
| `experiment_id`           | `str`     | —            | scalar | Valid directory under `/experiments/`     |
| `masses[i].ball_id`       | `uint8`   | —            | scalar | 0–2                                       |
| `masses[i].mass_g`        | `float32` | grams        | scalar | > 0                                       |
| `masses[i].uncertainty_g` | `float32` | grams        | scalar | > 0, default 1.0                          |
| `mode`                    | `enum`    | —            | scalar | PLANAR_SINGLE_CAM or STEREO_3D            |
| `friction`                | `enum`    | —            | scalar | IGNORE or COMPENSATE                      |
| `timestamps_ms[n]`        | `float64` | milliseconds | [N]    | Monotonically increasing, N = frame count |
| `positions_px[n]`         | `float64` | pixels       | [N, 2] | (x, y) per frame; NaN if frame missing    |
| `confidence[n]`           | `float32` | —            | [N]    | 0.0–1.0                                   |
| `scale_px_per_mm`         | `float64` | px/mm        | scalar | > 0                                       |
| `scale_unc_px_per_mm`     | `float64` | px/mm        | scalar | > 0                                       |

_Note: `timestamps_ms` and `positions_px` are per-ball, per-camera. In single-cam mode, one camera; stereo mode positions arrive already triangulated as (X_mm, Y_mm, Z_mm) and `scale_px_per_mm` is ignored._

### 1.4 Outputs (fully typed)

| Field                            | Type      | Units  | Shape    | Constraints                                                 |
| -------------------------------- | --------- | ------ | -------- | ----------------------------------------------------------- |
| `collision_frame`                | `int32`   | —      | scalar   | Frame index of detected collision; -1 if none detected      |
| `velocities[i].ball_id`          | `uint8`   | —      | scalar   |                                                             |
| `velocities[i].v_before_mps`     | `float64` | m/s    | scalar   |                                                             |
| `velocities[i].v_before_unc_mps` | `float64` | m/s    | scalar   | > 0                                                         |
| `velocities[i].v_after_mps`      | `float64` | m/s    | scalar   |                                                             |
| `velocities[i].v_after_unc_mps`  | `float64` | m/s    | scalar   | > 0                                                         |
| `velocities[i].friction_a_mps2`  | `float64` | m/s²   | scalar   | Negative for deceleration; 0.0 if `friction=IGNORE`         |
| `momentum.p_before_kgmps`        | `float64` | kg·m/s | scalar   |                                                             |
| `momentum.p_before_unc`          | `float64` | kg·m/s | scalar   |                                                             |
| `momentum.p_after_kgmps`         | `float64` | kg·m/s | scalar   |                                                             |
| `momentum.p_after_unc`           | `float64` | kg·m/s | scalar   |                                                             |
| `momentum.conservation_pct`      | `float64` | %      | scalar   |                                                             |
| `momentum.conservation_pct_unc`  | `float64` | %      | scalar   |                                                             |
| `energy.ke_before_J`             | `float64` | Joules | scalar   | ≥ 0                                                         |
| `energy.ke_before_unc_J`         | `float64` | Joules | scalar   | > 0                                                         |
| `energy.ke_after_J`              | `float64` | Joules | scalar   | ≥ 0                                                         |
| `energy.ke_after_unc_J`          | `float64` | Joules | scalar   | > 0                                                         |
| `energy.cor`                     | `float64` | —      | scalar   | 0–1 for elastic–inelastic; may exceed 1 (measurement noise) |
| `energy.cor_unc`                 | `float64` | —      | scalar   | > 0                                                         |
| `fit_diagnostics[i]`             | `dict`    | —      | per ball | See §3.3                                                    |

---

## 2. Internal Architecture

The module is decomposed into five independently-testable subcomponents with explicit interfaces between them:

```
┌──────────────────────────────────────────────────────────────────┐
│  physics/                                                        │
│                                                                  │
│  loader.py          ─── load tracks.json + sync.json            │
│       │                                                          │
│       ▼                                                          │
│  converter.py       ─── px → mm → m; attach true timestamps     │
│       │                                                          │
│       ▼                                                          │
│  collision.py       ─── rolling velocity estimate + threshold   │
│       │             ─── outputs: collision_frame, windows       │
│       ▼                                                          │
│  fitting.py         ─── curve_fit to x(t) model per window      │
│       │             ─── outputs: v0 as ufloat + friction a      │
│       ▼                                                          │
│  momentum.py        ─── p, KE, CoR, % conservation              │
│                     ─── outputs: all physics quantities          │
└──────────────────────────────────────────────────────────────────┘
```

### 2.1 `loader.py` — Data Loader

**Purpose:** Read `sync.json` and `tracks.json` from disk; validate schema; return structured numpy arrays.

**Inputs:** `experiment_id: str`

**Outputs:**

```python
@dataclass
class LoadedTrack:
    ball_id:       int
    camera_id:     int
    frame_indices: np.ndarray   # uint32, shape [N]
    timestamps_ms: np.ndarray   # float64, shape [N] — from sync.json
    x_px:          np.ndarray   # float64, shape [N] — NaN if frame missing
    y_px:          np.ndarray   # float64, shape [N]
    confidence:    np.ndarray   # float32, shape [N]
```

**Core logic:**

1. Read `sync.json`; extract `timestamps_ms` array for the relevant camera_id.
2. Read `tracks.json`; for each ball+camera combination, align frame indices against the timestamp array (index-to-index mapping — guaranteed 1:1 by sync module contract).
3. Insert `np.nan` for any missing frame indices in the dense range `[min_frame, max_frame]`.
4. Validate: assert `len(timestamps_ms) == len(x_px)`.

**Failure modes:**

- Missing files → raise `FileNotFoundError` with path; gRPC layer returns `NOT_FOUND`
- Schema mismatch → raise `ValueError`; gRPC layer returns `INVALID_ARGUMENT`

---

### 2.2 `converter.py` — Unit Converter

**Purpose:** Convert pixel coordinates to metres; attach timestamps in seconds; compute per-point position uncertainty in metres.

**Inputs:**

```python
track: LoadedTrack
scale_px_per_mm: float
scale_unc_px_per_mm: float
```

**Outputs:**

```python
@dataclass
class MetricTrack:
    ball_id:       int
    t_s:           np.ndarray   # float64, shape [N] — seconds (t=0 = first frame of cam0)
    x_m:           np.ndarray   # float64, shape [N] — metres; NaN if frame missing
    sigma_x_m:     np.ndarray   # float64, shape [N] — position uncertainty in metres
```

**Core logic:**

Position uncertainty in metres is derived from two independent sources (added in quadrature):

```
sigma_px_tracking = 0.3          # px — fixed, from SAM2 Gaussian centroid fit spec
sigma_x_px = sigma_px_tracking   # for each frame

# Convert to mm:
x_mm = x_px / scale_px_per_mm

# Uncertainty in mm (error propagation):
sigma_x_mm = sqrt( (sigma_x_px / scale_px_per_mm)^2
                 + (x_px * scale_unc_px_per_mm / scale_px_per_mm^2)^2 )

# Convert to metres:
x_m = x_mm / 1000.0
sigma_x_m = sigma_x_mm / 1000.0
```

Timestamps:

```
t_s[i] = timestamps_ms[i] / 1000.0
```

**Failure modes:**

- `scale_px_per_mm <= 0` → raise `ValueError`
- All frames NaN → raise `InsufficientDataError` (custom exception)

---

### 2.3 `collision.py` — Collision Detector

**Purpose:** Identify the collision frame and define pre/post windows using a rolling velocity estimator. Must not require any fitted parameters — this is a detection step only.

**Inputs:**

```python
track: MetricTrack         # for the primary ball (ball_id=0, or the initiating ball)
window_frames: int = 5     # rolling window half-width for crude velocity estimate
threshold_factor: float = 3.0  # std-dev multiplier for change detection
pre_window: int = 7        # frames before collision for pre-collision fit
post_window: int = 7       # frames after collision for post-collision fit
```

**Outputs:**

```python
@dataclass
class CollisionResult:
    collision_frame: int          # -1 if not detected
    pre_start:  int               # first frame of pre-collision window
    pre_end:    int               # last frame of pre-collision window (exclusive of collision)
    post_start: int               # first frame of post-collision window (exclusive of collision)
    post_end:   int               # last frame of post-collision window
    rolling_velocities: np.ndarray  # float64 [N] — crude dv/dt for diagnostics
```

**Core logic (rolling velocity estimator, step-by-step):**

```
For each frame i from window_frames to N - window_frames:
    t_left  = t_s[i - window_frames]
    t_right = t_s[i + window_frames]
    x_left  = x_m[i - window_frames]
    x_right = x_m[i + window_frames]

    # Simple central difference on the window endpoints
    # This is used ONLY for anomaly detection, not for final velocity
    v_roll[i] = (x_right - x_left) / (t_right - t_left)

v_roll is padded with NaN for edge frames.

Compute rolling_mean = median(v_roll[non-NaN])
Compute rolling_std  = 1.4826 * MAD(v_roll[non-NaN])   # robust std estimator

For each i:
    delta_v[i] = |v_roll[i] - v_roll[i-1]|

collision_candidates = [i for i where delta_v[i] > threshold_factor * rolling_std]

If len(collision_candidates) == 0:
    collision_frame = -1
Else:
    collision_frame = collision_candidates[argmax(delta_v[candidates])]

pre_start  = max(0,   collision_frame - pre_window)
pre_end    = collision_frame
post_start = collision_frame + 1
post_end   = min(N-1, collision_frame + post_window + 1)
```

**Constraint:** `pre_end - pre_start >= 4` and `post_end - post_start >= 4` are required for curve fitting. If not satisfied, raise `InsufficientWindowError`.

**Failure modes:**

- Track too short (< 20 non-NaN frames) → raise `InsufficientDataError`
- No collision detected → return `collision_frame = -1`; caller fits a single window over all frames

---

### 2.4 `fitting.py` — Velocity Fitter

**Purpose:** Fit the kinematic model `x(t) = x₀ + v₀·t + ½·a·t²` to a window of frames; extract `v₀` as a `ufloat` with correctly propagated covariance uncertainty.

**Inputs:**

```python
t_s:       np.ndarray   # float64, shape [M] — true timestamps in seconds
x_m:       np.ndarray   # float64, shape [M] — metric positions in metres
sigma_x_m: np.ndarray   # float64, shape [M] — per-point position uncertainty in metres
```

**Outputs:**

```python
@dataclass
class FitResult:
    v0:           UFloat   # ufloat — velocity in m/s with 1-sigma uncertainty
    a:            UFloat   # ufloat — acceleration in m/s² (friction proxy)
    x0:           UFloat   # ufloat — initial position (nuisance parameter)
    chi2_reduced: float    # goodness of fit; expected ~1.0 for good fit
    dof:          int      # degrees of freedom = M - 3
    covariance:   np.ndarray  # float64, shape [3,3] — full pcov from curve_fit
```

**Core logic:**

```python
from scipy.optimize import curve_fit
from uncertainties import correlated_values

def kinematic_model(t, x0, v0, a):
    return x0 + v0 * t + 0.5 * a * t**2

# Centre time array to improve numerical conditioning
t_origin = t_s[0]
t_rel = t_s - t_origin

# Initial parameter estimate
x0_init = x_m[0]
v0_init = (x_m[-1] - x_m[0]) / (t_rel[-1] - t_rel[0])  # crude finite difference
a_init  = 0.0

p0 = [x0_init, v0_init, a_init]

# Bounds: no constraints (allow negative velocity for rebounds)
popt, pcov = curve_fit(
    kinematic_model,
    t_rel,
    x_m,
    p0=p0,
    sigma=sigma_x_m,
    absolute_sigma=True,   # CRITICAL: sigma are true measurement std devs, not relative weights
    method='lm'            # Levenberg-Marquardt: most robust for well-posed fits
)

# Extract correlated ufloats — preserves full covariance structure
x0_u, v0_u, a_u = correlated_values(popt, pcov)

# Compute reduced chi-squared for fit quality
residuals   = x_m - kinematic_model(t_rel, *popt)
chi2        = np.sum((residuals / sigma_x_m)**2)
dof         = len(t_s) - 3
chi2_reduced = chi2 / dof
```

**Critical implementation notes:**

1. `absolute_sigma=True` must be set. With `absolute_sigma=False`, `scipy` rescales the covariance by the residual variance, which effectively ignores the known measurement uncertainties and gives nonsensical uncertainty estimates when the fit is very good.

2. The fit is performed on the **time-centred** array `t_rel = t_s - t_s[0]`. This prevents numerical cancellation in the `x0 + v0·t` terms when timestamps are large absolute values.

3. `v0_u` is returned as a `ufloat` with automatic uncertainty. Downstream code never extracts `.nominal_value` and `.std_dev` separately until the final serialisation step.

4. If `pcov` contains `inf` entries (singular covariance — fit did not converge), raise `FitDivergenceError`.

**Failure modes:**

- `M < 4` → raise `InsufficientDataError`
- `curve_fit` raises `RuntimeError` (max iterations) → raise `FitDivergenceError`
- `chi2_reduced > 10` → emit `WARNING` log but do not raise; return result with flag

---

### 2.5 `momentum.py` — Physics Calculator

**Purpose:** Given `ufloat` velocities and `ufloat` masses, compute all physics quantities. The `uncertainties` library propagates all uncertainty automatically — no manual error formulae required.

**Inputs:**

```python
masses:     List[UFloat]          # mass in kg, as ufloats — one per ball
v_before:   List[UFloat]          # m/s per ball, before collision
v_after:    List[UFloat]          # m/s per ball, after collision
ke_mode:    str = "rolling_sphere" # or "point_mass" — controls KE factor
```

**Outputs:**

```python
@dataclass
class PhysicsOutput:
    # Per ball
    p_before_per_ball:  List[UFloat]   # kg·m/s
    p_after_per_ball:   List[UFloat]   # kg·m/s
    ke_before_per_ball: List[UFloat]   # Joules
    ke_after_per_ball:  List[UFloat]   # Joules
    # System totals
    p_before_total:     UFloat
    p_after_total:      UFloat
    ke_before_total:    UFloat
    ke_after_total:     UFloat
    # Derived
    conservation_pct:   UFloat         # (p_after/p_before - 1) * 100
    cor:                UFloat         # coefficient of restitution
```

**Core logic:**

```python
from uncertainties import ufloat

# KE factor: 0.7 for solid rolling sphere, 0.5 for point mass
ke_factor = 0.7 if ke_mode == "rolling_sphere" else 0.5

# Per-ball quantities — uncertainty propagates automatically through all arithmetic
for i, (m, vb, va) in enumerate(zip(masses, v_before, v_after)):
    p_before_per_ball[i] = m * vb
    p_after_per_ball[i]  = m * va
    ke_before_per_ball[i] = ke_factor * m * vb**2
    ke_after_per_ball[i]  = ke_factor * m * va**2

# System totals — simple summation; uncertainties add in quadrature automatically
p_before_total = sum(p_before_per_ball)
p_after_total  = sum(p_after_per_ball)
ke_before_total = sum(ke_before_per_ball)
ke_after_total  = sum(ke_after_per_ball)

# % momentum conserved: signed so over-conservation shows positive
conservation_pct = (p_after_total / p_before_total - 1.0) * 100.0

# Coefficient of restitution (2-ball case):
# e = |v2_after - v1_after| / |v1_before - v2_before|
# For single ball (wall collision), v2 = 0 throughout
if len(masses) >= 2:
    relative_v_before = v_before[0] - v_before[1]   # signed
    relative_v_after  = v_after[1]  - v_after[0]    # signed (reversal)
    cor = relative_v_after / relative_v_before
else:
    # Single ball bouncing off fixed wall
    cor = -v_after[0] / v_before[0]   # velocity reversal ratio
```

**Failure modes:**

- `p_before_total.nominal_value ≈ 0` → conservation_pct would be div-by-zero → return `NaN` with a diagnostic flag; do not raise

---

## 3. Data Contracts & Interfaces

### 3.1 Function signatures (fully typed)

```python
# loader.py
def load_experiment_data(
    experiment_dir: Path,
    camera_id: int = 0
) -> tuple[list[LoadedTrack], ScaleCalibration]:
    ...

# converter.py
def convert_to_metric(
    track: LoadedTrack,
    scale: ScaleCalibration,
    position_sigma_px: float = 0.3
) -> MetricTrack:
    ...

# collision.py
def detect_collision(
    primary_track: MetricTrack,
    window_frames: int = 5,
    threshold_factor: float = 3.0,
    pre_window: int = 7,
    post_window: int = 7
) -> CollisionResult:
    ...

# fitting.py
def fit_velocity_segment(
    t_s: np.ndarray,
    x_m: np.ndarray,
    sigma_x_m: np.ndarray
) -> FitResult:
    ...

# momentum.py
def compute_physics(
    masses_kg: list[UFloat],
    v_before: list[UFloat],
    v_after: list[UFloat],
    ke_mode: Literal["rolling_sphere", "point_mass"] = "rolling_sphere"
) -> PhysicsOutput:
    ...
```

### 3.2 JSON output files

**`velocities.json`:**

```json
{
  "experiment_id": "string",
  "collision_frame": 47,
  "balls": [
    {
      "ball_id": 0,
      "v_before": { "value_mps": 1.342, "uncertainty_mps": 0.018 },
      "v_after": { "value_mps": 0.214, "uncertainty_mps": 0.022 },
      "friction_a": { "value_mps2": -0.041, "uncertainty_mps2": 0.007 },
      "fit_diagnostics": {
        "pre_window_frames": [40, 47],
        "post_window_frames": [48, 55],
        "pre_chi2_reduced": 1.13,
        "post_chi2_reduced": 0.97,
        "pre_dof": 4,
        "post_dof": 4
      }
    }
  ]
}
```

**`momentum.json`:**

```json
{
  "experiment_id": "string",
  "ke_mode": "rolling_sphere",
  "n_balls": 2,
  "per_ball": [
    {
      "ball_id": 0,
      "p_before": { "value_kgmps": 0.0671, "uncertainty_kgmps": 0.0014 },
      "p_after": { "value_kgmps": 0.0107, "uncertainty_kgmps": 0.0012 },
      "ke_before": { "value_J": 0.04506, "uncertainty_J": 0.00121 },
      "ke_after": { "value_J": 0.000723, "uncertainty_J": 0.000165 }
    }
  ],
  "system": {
    "p_before": { "value_kgmps": 0.0671, "uncertainty_kgmps": 0.0014 },
    "p_after": { "value_kgmps": 0.0659, "uncertainty_kgmps": 0.0018 },
    "conservation_pct": { "value": -1.79, "uncertainty": 2.31 },
    "ke_before": { "value_J": 0.04506, "uncertainty_J": 0.00121 },
    "ke_after": { "value_J": 0.02814, "uncertainty_J": 0.00094 },
    "cor": { "value": 0.813, "uncertainty": 0.031 }
  }
}
```

### 3.3 Serialisation helper

All `ufloat` values are serialised with a single helper to avoid ad-hoc `.nominal_value` access:

```python
def ufloat_to_dict(u: UFloat, key_stem: str, unit: str) -> dict:
    return {
        f"value_{unit}": round(u.nominal_value, 6),
        f"uncertainty_{unit}": round(u.std_dev, 6)
    }
```

### 3.4 gRPC: `PhysicsResult` message

The protobuf definition (extends the outline in `physics.proto`) must be updated to carry uncertainty fields:

```protobuf
message UncertainValue {
  double value       = 1;
  double uncertainty = 2;
}

message BallResult {
  uint32       ball_id      = 1;
  UncertainValue v_before   = 2;   // m/s
  UncertainValue v_after    = 3;   // m/s
  UncertainValue p_before   = 4;   // kg·m/s
  UncertainValue p_after    = 5;   // kg·m/s
  UncertainValue ke_before  = 6;   // J
  UncertainValue ke_after   = 7;   // J
  double friction_a         = 8;   // m/s² (0 if IGNORE mode)
}

message SystemResult {
  UncertainValue p_before        = 1;
  UncertainValue p_after         = 2;
  UncertainValue conservation_pct = 3;
  UncertainValue ke_before       = 4;
  UncertainValue ke_after        = 5;
  UncertainValue cor             = 6;
  int32          collision_frame = 7;
}

message PhysicsResult {
  repeated BallResult balls  = 1;
  SystemResult        system = 2;
  string              error  = 3;   // empty if success
}
```

---

## 4. Algorithmic Implementation

### 4.1 Full pipeline — numbered steps

**Step 1: Load data**

```
1.1  Open experiments/{id}/results/sync.json
1.2  For camera_id=0 (single-cam mode): extract timestamps_ms array
1.3  Open experiments/{id}/results/tracks.json
1.4  For each ball, build frame_index → (x_px, y_px, confidence) mapping
1.5  Densify: for each integer i in [0, max_frame_index], if no track entry exists → set (NaN, NaN, 0.0)
1.6  Align: tracks[i].timestamp = sync.timestamps_ms[i] / 1000.0  (seconds)
1.7  Load scale_px_per_mm and scale_unc_px_per_mm from cam0_intrinsics.json
```

**Step 2: Convert to metric**

```
2.1  For each ball b, for each frame i with non-NaN x_px:
       x_m[i] = x_px[i] / scale_px_per_mm / 1000.0
       y_m[i] = y_px[i] / scale_px_per_mm / 1000.0
2.2  sigma_x_m[i] = sqrt( (0.3/scale_px_per_mm/1000)^2
                        + (x_px[i]*scale_unc_px_per_mm / scale_px_per_mm^2 / 1000)^2 )
2.3  Project to 1D: use x_m if primary motion is along x-axis, else rotate.
     For now, use the axis with maximum variance: axis = argmax(var(x_m), var(y_m)).
     Document assumption: motion is approximately 1D in the chosen axis. (For 2D generalisation see §14.)
```

**Step 3: Detect collision**

```
3.1  Take primary track (ball_id=0); compute rolling velocity over window_frames=5:
       v_roll[i] = (x_m[i+5] - x_m[i-5]) / (t_s[i+5] - t_s[i-5])  for i in [5, N-6]
3.2  Compute MAD-based std: rolling_std = 1.4826 * median(|v_roll - median(v_roll)|)
3.3  Compute frame-to-frame velocity jumps: delta_v[i] = |v_roll[i] - v_roll[i-1]|
3.4  Find all i where delta_v[i] > 3.0 * rolling_std → collision_candidates
3.5  collision_frame = candidate with maximum delta_v[i]
3.6  pre window: [collision_frame - 7, collision_frame - 1] inclusive
3.7  post window: [collision_frame + 1, collision_frame + 7] inclusive
3.8  Clamp windows to valid frame range; verify >= 4 frames each
```

**Step 4: Fit velocity (pre-collision)**

```
4.1  Extract t_pre = t_s[pre_start:pre_end], x_pre = x_m[pre_start:pre_end]
4.2  Drop NaN frames from both arrays simultaneously (must remain aligned)
4.3  Verify M = len(t_pre) >= 4
4.4  t_rel = t_pre - t_pre[0]  (time-centre for numerical stability)
4.5  p0 = [x_pre[0], (x_pre[-1]-x_pre[0])/(t_rel[-1]-t_rel[0]), 0.0]
4.6  popt, pcov = curve_fit(kinematic_model, t_rel, x_pre,
                            p0=p0, sigma=sigma_x_pre, absolute_sigma=True, method='lm')
4.7  x0_u, v0_u, a_u = correlated_values(popt, pcov)
     → v0_pre = v0_u  (ufloat, m/s)
     → a_pre  = a_u   (ufloat, m/s² — negative = deceleration = friction)
4.8  chi2_pre = sum((residuals/sigma)^2) / (M-3)
```

**Step 5: Friction compensation (if FrictionMode == COMPENSATE)**

```
5.1  friction_a = a_pre.nominal_value   (scalar, m/s²)
5.2  Project v_before to collision instant:
       dt = t_s[collision_frame] - t_pre[0]
       v_at_collision_before = x0_u + v0_u*dt + 0.5*a_u*dt^2  ← ufloat, fully correlated
     (This is the extrapolated velocity at the moment of collision — more accurate
      than v0 alone when the pre-window starts well before the collision.)
5.3  In IGNORE mode: v_at_collision_before = v0_pre (no compensation)
```

**Step 6: Fit velocity (post-collision)**

```
6.1  Same procedure as Step 4, applied to post-collision window
6.2  v_at_collision_after = extrapolated velocity at collision_frame
```

**Step 7: Build mass ufloats**

```
7.1  For each ball i:
       mass_kg = ufloat(request.masses[i].mass_g / 1000.0,
                        request.masses[i].uncertainty_g / 1000.0)
```

**Step 8: Compute physics**

```
8.1  p_before[i] = mass_kg[i] * v_before[i]
8.2  p_after[i]  = mass_kg[i] * v_after[i]
8.3  ke_before[i] = 0.7 * mass_kg[i] * v_before[i]**2
8.4  ke_after[i]  = 0.7 * mass_kg[i] * v_after[i]**2
8.5  p_before_total = sum(p_before)
8.6  p_after_total  = sum(p_after)
8.7  conservation_pct = (p_after_total / p_before_total - 1.0) * 100.0
8.8  cor = (v_after[1] - v_after[0]) / (v_before[0] - v_before[1])  [2-ball case]
```

**Step 9: Serialise**

```
9.1  Write velocities.json and momentum.json to experiments/{id}/results/
9.2  Build PhysicsResult protobuf message
9.3  Return via gRPC streaming response (single message for this module)
```

---

## 5. Execution Model

**Invocation type:** Synchronous, called once per experiment after tracking completes.

**Trigger:** gRPC `ComputePhysics(PhysicsRequest)` call from Node.js after:

1. `TrackBalls` has completed and `tracks.json` written
2. Sync pipeline has completed and `sync.json` written
3. Scale calibration confirmed and `cam0_intrinsics.json` written

**Concurrency model:** Single-threaded within the physics computation. The FastAPI/gRPC server may handle multiple experiments concurrently at the process level (uvicorn worker pool), but each individual `ComputePhysics` call processes one experiment in a single thread. No shared mutable state between calls.

**Timing model:** No real-time constraints. A typical execution (2 balls, 300 frames) completes in < 200 ms on any modern CPU. `curve_fit` with M=7 data points and 3 parameters converges in < 1 ms.

**No streaming required:** Physics computation is not iterative. The result is returned as a single protobuf message. gRPC server-side streaming is not needed for this RPC (can use unary `ComputePhysics(PhysicsRequest) returns (PhysicsResult)`).

---

## 6. State & Data Flow

```
[disk] sync.json          ──┐
[disk] tracks.json         ├──► loader.py ──► [RAM] List[LoadedTrack]
[disk] cam0_intrinsics.json─┘
                                                    │
                                                    ▼
                                           converter.py ──► List[MetricTrack]
                                                    │
                                                    ▼
                                           collision.py ──► CollisionResult
                                             (uses ball_id=0 track only)
                                                    │
                                     ┌──────────────┴─────────────┐
                                     ▼                             ▼
                              fit pre-window                 fit post-window
                              per ball                       per ball
                              (fitting.py)                   (fitting.py)
                                     │                             │
                                     └──────────────┬─────────────┘
                                                    ▼
                                           List[FitResult] (before + after per ball)
                                                    │
                                                    ▼
                                           momentum.py ──► PhysicsOutput
                                                    │
                                     ┌──────────────┴─────────────┐
                                     ▼                             ▼
                              [disk] velocities.json     [gRPC] PhysicsResult
                              [disk] momentum.json
```

**What is retained (written to disk):** `velocities.json`, `momentum.json`

**What is discarded:** All intermediate numpy arrays (RAM-only, not persisted). `MetricTrack`, `CollisionResult`, `FitResult` objects are created and garbage-collected within the call.

**What is recalculated on re-run:** Everything. There is no caching — re-running `ComputePhysics` always re-reads from `tracks.json` and `sync.json` and overwrites the output files. This is safe because all inputs are immutable by the time physics runs.

---

## 7. Integration Points

### 7.1 Entry point: Node.js → gRPC → `ComputePhysics`

**Call sequence:**

```
1. Node.js grpc-client.ts: calls stub.ComputePhysics(request) after TrackBalls completes
2. grpc_server.py: receives PhysicsRequest; validates experiment_id exists on disk
3. grpc_server.py: calls physics_pipeline.run(request) → PhysicsResult
4. grpc_server.py: returns PhysicsResult to Node.js
5. Node.js: receives result; persists to SQLite via better-sqlite3
6. Node.js: relays result to frontend via WebSocket
```

### 7.2 Exit point: gRPC response → Node → React

The `PhysicsResult` is returned immediately after computation (unary RPC). Node.js is responsible for writing the JSON files (`velocities.json`, `momentum.json`) — or this can be done in the Python service before returning; this boundary must be agreed at integration time.

**Recommendation:** Python writes JSON files, then returns gRPC result. Node.js reads from JSON for the React frontend (avoids double-serialisation). Python should confirm file write before returning gRPC response.

### 7.3 Error propagation

| Error condition       | Python raises           | gRPC status code      | Node.js action                                            |
| --------------------- | ----------------------- | --------------------- | --------------------------------------------------------- |
| `sync.json` missing   | `FileNotFoundError`     | `NOT_FOUND`           | UI shows "Sync data missing"                              |
| `tracks.json` missing | `FileNotFoundError`     | `NOT_FOUND`           | UI shows "Tracking data missing"                          |
| Insufficient frames   | `InsufficientDataError` | `FAILED_PRECONDITION` | UI shows "Not enough frames in window"                    |
| Fit diverged          | `FitDivergenceError`    | `INTERNAL`            | UI shows "Curve fit failed — try adjusting windows"       |
| No collision detected | (not an error)          | `OK`                  | UI shows single-window results with no before/after split |

### 7.4 No retry logic at this level

Physics computation is deterministic. If it fails, the root cause must be corrected (e.g. bad tracking data, insufficient window). Retrying without change is pointless. The UI exposes a "Re-run Physics" button with adjustable window parameters.

---

## 8. Edge Cases & Failure Handling

| Scenario                                                 | Detection                       | Recovery                                                                                                                                                                  |
| -------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------- |
| No collision in experiment (single ball, free roll)      | `collision_frame == -1`         | Fit single window over all frames; skip before/after split; `v_after = None`; CoR = N/A                                                                                   |
| Ball leaves frame before collision                       | Many NaN in `x_m`               | Count non-NaN frames in window; if < 4, raise `InsufficientWindowError` and expand window or abort                                                                        |
| Very short video (< 20 frames)                           | Detected in loader              | Raise `InsufficientDataError` immediately                                                                                                                                 |
| Two balls collide but one was not tracked                | Only one track in `tracks.json` | Proceed with single-ball mode; CoR still computable if wall collision                                                                                                     |
| `p_before ≈ 0` (ball nearly stationary before collision) | `                               | p_before.nominal_value                                                                                                                                                    | < 1e-6` | Set `conservation_pct = NaN`; log WARNING |
| `chi2_reduced >> 1` (poor fit)                           | Threshold: > 5.0                | Log WARNING with window indices; include flag in diagnostics JSON; do NOT suppress result                                                                                 |
| `pcov` contains `inf`                                    | Check after `curve_fit`         | Raise `FitDivergenceError`; log full diagnostic including `t_rel`, `x_m`, `sigma_x_m`                                                                                     |
| 3-ball experiment — multiple collision events            | Multiple peaks in `delta_v`     | Detect all; fit pre/between/post windows for each sequential collision; this is an extension (see §14) — for now, detect first collision only and warn if second detected |
| User enters mass = 0                                     | Validation in gRPC handler      | Reject request with `INVALID_ARGUMENT` before physics runs                                                                                                                |

**How to simulate:**

- No collision: use a synthetic track with constant velocity (zero delta_v)
- Poor fit: inject 20% Gaussian noise to `x_m` in unit test
- Diverged fit: provide only 2 data points (M < 4)
- Near-zero momentum: set `v_before = 0.001` m/s in unit test

---

## 9. Accuracy & Error Sources

### 9.1 Error budget (end-to-end, single camera, 30 fps, 1080p)

| Source                                       | Magnitude                                           | Where introduced                                             |
| -------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| Position tracking (SAM2 + Gaussian centroid) | ±0.3 px = ±0.095 mm at 3.14 px/mm                   | `converter.py` — `sigma_px_tracking = 0.3`                   |
| Scale calibration                            | ±0.008 px/mm (0.25%)                                | `converter.py` — quadrature addition                         |
| Timestamp sync                               | < 0.5 ms                                            | `loader.py` — inherits from sync module                      |
| Curve fit noise rejection                    | Reduces position noise by √M (M = frames in window) | `fitting.py` — using 7 frames: σ_fit ≈ σ_pos / √7 ≈ 0.036 mm |
| **Effective velocity uncertainty**           | **~1–2% at 1 m/s**                                  | Derived from fit covariance                                  |
| Mass measurement                             | ±1 g / 50 g = ±2%                                   | `momentum.py` — ufloat                                       |
| **Effective momentum uncertainty**           | **~2–3%**                                           | Quadrature sum of velocity + mass errors                     |

### 9.2 Error propagation chain

```
σ_px = 0.3 px
  → σ_x_m  (converter.py, eq above)
    → popt, pcov  (fitting.py, curve_fit with absolute_sigma=True)
      → v0_u = ufloat via correlated_values(popt, pcov)
        → p = m * v0_u   (momentum.py)
          → conservation_pct = (p_after/p_before - 1)*100
            → final displayed uncertainty
```

Every step is handled automatically by the `uncertainties` library. No manual partial-derivative formulae are required after `correlated_values` wraps the covariance matrix.

### 9.3 Why `absolute_sigma=True` is critical for accuracy

With `absolute_sigma=False` (scipy default), the covariance matrix is scaled by the residual variance: `pcov_scaled = pcov * chi2 / dof`. This is appropriate when sigma values are only relative weights (i.e., you don't know the true measurement uncertainty). In this module, sigma values ARE calibrated absolute uncertainties (±0.3 px converted to metres). Using `absolute_sigma=True` ensures the reported uncertainty is correct regardless of how well the model fits — a good fit (small residuals) does not artificially shrink the uncertainty.

### 9.4 Timestamp error impact on velocity

A timing error of Δt = 0.5 ms at t = 33 ms (1 frame interval) gives:

```
Δv / v = Δt / t_window
       = 0.5 ms / (7 frames × 33 ms/frame)
       = 0.5 / 231 = 0.22%
```

Timestamp error is negligible compared to position noise. It is not a separate term in the uncertainty budget.

---

## 10. Testing Strategy

### 10.1 Unit tests — per subcomponent

#### `test_loader.py`

```python
def test_load_valid_experiment():
    # Write minimal sync.json + tracks.json to tmp dir
    # Call load_experiment_data(tmp_dir)
    # Assert track.timestamps_ms.shape == (N,)
    # Assert no NaN in timestamps

def test_load_missing_sync_file():
    # Remove sync.json
    # Assert FileNotFoundError raised

def test_dense_frame_filling():
    # tracks.json has frames [0, 2, 4] (gaps at 1, 3)
    # Assert loaded track has NaN at indices 1, 3
    # Assert shape is (5,) not (3,)
```

#### `test_converter.py`

```python
def test_px_to_metric_conversion():
    # Known scale: 3.0 px/mm
    # x_px = [300.0, 600.0]
    # Expected x_m = [0.1, 0.2]
    # Assert np.allclose(x_m, [0.1, 0.2])

def test_sigma_propagation():
    # scale = ufloat(3.0, 0.01) px/mm
    # x_px = 300.0 px, sigma_px = 0.3
    # Expected sigma_x_mm = sqrt((0.3/3.0)^2 + (300*0.01/9)^2)
    # Assert computed sigma matches expected to 6 decimal places
```

#### `test_collision.py`

```python
def test_detects_known_collision():
    # Synthetic track: constant v=1.0 m/s for 20 frames,
    # then sudden v=0.2 m/s for 20 frames (collision at frame 20)
    # Assert collision_frame == 20 (± 1 frame tolerance)
    # Assert pre_window contains frames 13–19
    # Assert post_window contains frames 21–27

def test_no_collision_single_ball():
    # Constant velocity track
    # Assert collision_frame == -1

def test_insufficient_frames_raises():
    # Track with only 10 frames
    # Assert InsufficientDataError
```

#### `test_fitting.py`

```python
def test_perfect_constant_velocity():
    # t = [0, 1/30, 2/30, ..., 6/30]
    # x = 0.5 * t  (v0 = 0.5 m/s exact, a = 0)
    # sigma = [0.0001, ...]  (very small uncertainty)
    # Assert v0.nominal_value ≈ 0.5 within 1e-4
    # Assert v0.std_dev > 0

def test_velocity_uncertainty_scales_with_sigma():
    # Run fit with sigma = 0.001 m vs sigma = 0.01 m
    # Assert uncertainty with sigma=0.01 is ~10× larger

def test_fit_recovers_known_deceleration():
    # x(t) = 0 + 1.0*t - 0.5*0.1*t^2  (a = -0.1 m/s²)
    # Assert a.nominal_value ≈ -0.1 within 0.01

def test_absolute_sigma_flag_effect():
    # Verify that using absolute_sigma=True gives larger uncertainty
    # than absolute_sigma=False when residuals are very small
    # (This is the critical correctness check for the pcov usage)

def test_insufficient_points_raises():
    # M = 3 points
    # Assert InsufficientDataError
```

#### `test_momentum.py`

```python
def test_momentum_conservation_perfect():
    # m1 = ufloat(0.05, 0.001), m2 = ufloat(0.05, 0.001)
    # v1_before = ufloat(1.0, 0.01), v2_before = ufloat(0.0, 0.01)
    # v1_after  = ufloat(0.0, 0.01), v2_after  = ufloat(1.0, 0.01)
    # Assert p_before ≈ p_after within uncertainty
    # Assert conservation_pct.nominal_value ≈ 0.0

def test_ke_rolling_sphere_factor():
    # m = ufloat(0.1, 0.001), v = ufloat(2.0, 0.01)
    # Expected KE = 0.7 * 0.1 * 4.0 = 0.28 J
    # Assert ke.nominal_value ≈ 0.28

def test_cor_elastic():
    # v1_before=1.0, v2_before=0.0, v1_after=0.0, v2_after=1.0 (elastic, equal masses)
    # Assert cor.nominal_value ≈ 1.0

def test_uncertainty_propagation_non_zero():
    # Any standard inputs — verify all output .std_dev > 0
    # This catches accidental use of plain floats instead of ufloats
```

### 10.2 Integration test

```python
def test_full_pipeline_synthetic():
    """End-to-end: write sync.json + tracks.json → run pipeline → check outputs."""
    # Generate synthetic data:
    # Ball 0: v=1.2 m/s for frames 0–19, collision at frame 20, v=0.2 m/s for frames 21–40
    # Ball 1: v=0.0 m/s for frames 0–19, v=0.9 m/s for frames 21–40
    # masses: m1=50g, m2=50g, uncertainty=1g
    # Write to tmp experiment dir
    # Run ComputePhysics via gRPC
    # Assert collision_frame == 20
    # Assert |conservation_pct.nominal_value| < 5%  (synthetic data has exact conservation)
    # Assert cor between 0.8 and 1.0 (synthetic elastic collision)
    # Assert all output .std_dev > 0
    # Assert velocities.json + momentum.json written to disk
```

### 10.3 Regression test

Store a frozen `tracks.json` / `sync.json` from a real experiment (lab recording). Run physics pipeline. Assert outputs match stored expected values to 4 decimal places. This catches regressions from scipy/uncertainties version upgrades.

### 10.4 Tolerances

| Quantity                                   | Tolerance            |
| ------------------------------------------ | -------------------- |
| `collision_frame` detection                | ± 1 frame            |
| `v0.nominal_value` (synthetic exact input) | < 0.001 m/s absolute |
| `conservation_pct` (synthetic exact)       | < 0.1%               |
| `cor` (synthetic elastic)                  | < 0.01 absolute      |
| `chi2_reduced` (perfect fit)               | < 1.5                |

---

## 11. Implementation Plan (Step-by-Step)

Each step produces a directly testable output.

**Step 1 — Scaffold module structure (no logic)**

```
packages/cv-service/physics/
  __init__.py
  loader.py         (stub: raises NotImplementedError)
  converter.py      (stub)
  collision.py      (stub)
  fitting.py        (stub)
  momentum.py       (stub)
  exceptions.py     (InsufficientDataError, FitDivergenceError, InsufficientWindowError)
  pipeline.py       (orchestrator: calls all stubs in order)
tests/physics/
  test_loader.py
  test_converter.py
  test_collision.py
  test_fitting.py
  test_momentum.py
  test_integration.py
  fixtures/         (synthetic tracks.json, sync.json)
```

Observable output: `pytest tests/physics/` runs with all tests failing (not erroring).

**Step 2 — Implement `loader.py` + pass its tests**

- Read `sync.json` and `tracks.json`
- Build dense `LoadedTrack` arrays with NaN filling
- Observable: `test_loader.py` green

**Step 3 — Implement `converter.py` + pass its tests**

- px → mm → m conversion with sigma propagation
- Observable: `test_converter.py` green; print sample MetricTrack to confirm units

**Step 4 — Implement `fitting.py` + pass its tests**

- `curve_fit` with `absolute_sigma=True`, `correlated_values`, time-centring
- Observable: `test_fitting.py` green; manually verify uncertainty is non-zero and sensible on synthetic data

**Step 5 — Implement `collision.py` + pass its tests**

- Rolling velocity + MAD-based threshold + window extraction
- Observable: `test_collision.py` green; plot `rolling_velocities` for synthetic tracks to visual-confirm

**Step 6 — Implement `momentum.py` + pass its tests**

- All physics quantities as ufloat operations
- Observable: `test_momentum.py` green

**Step 7 — Implement `pipeline.py` (orchestrator)**

- Wire all subcomponents together
- Handle `collision_frame == -1` (single-window mode)
- Handle 1, 2, 3 ball cases
- Write `velocities.json` and `momentum.json`
- Observable: `test_integration.py` green; inspect output JSON files manually

**Step 8 — Wire to gRPC server**

- Add `ComputePhysics` handler to `grpc_server.py`
- Update `physics.proto` with `UncertainValue` type
- Map `PhysicsOutput` → `PhysicsResult` protobuf
- Observable: Call via `grpcurl` from command line; receive `PhysicsResult`

**Step 9 — Wire to Node.js**

- Update `grpc-client.ts` to call `ComputePhysics` after tracking job completes
- Forward result to React via WebSocket
- Observable: Full end-to-end flow with real experiment data; Results screen populates

**Step 10 — Real-world validation**

- Run experiment with known masses, known velocity (measured by ruler + stopwatch independently)
- Compare physics output to hand calculation
- Target: velocity within 2%, momentum within 3%

---

## 12. Performance Considerations

**Time complexity:** O(N) for loading and converting, O(M) for fitting (M ≤ 15 frames per window). `curve_fit` on M=15 with 3 parameters is essentially instant (< 1 ms). Total pipeline: < 100 ms for a 300-frame experiment.

**Memory:** Peak usage is proportional to number of frames × number of balls × 2 cameras. At 300 frames, 3 balls: ~50 KB of float64 arrays. Entirely negligible.

**Bottlenecks:** None within this module. The dominant processing time in the whole system is SAM2 tracking (~200 ms/frame). Physics is 4 orders of magnitude faster.

**`uncertainties` library overhead:** Each `ufloat` operation creates a lightweight derivative-tracking object. For the number of operations here (< 50 arithmetic operations per ball), this is completely negligible in both time and memory.

---

## 13. Observability

### 13.1 Logging

All logging via Python `logging` module, structured as JSON (use `python-json-logger`):

```python
logger.info("physics.collision_detected", extra={
    "experiment_id": experiment_id,
    "collision_frame": collision_frame,
    "delta_v_peak": float(delta_v_peak),
    "threshold": float(threshold)
})

logger.info("physics.fit_complete", extra={
    "experiment_id": experiment_id,
    "ball_id": ball_id,
    "window": "pre",
    "v0_mps": float(v0.nominal_value),
    "v0_unc_mps": float(v0.std_dev),
    "chi2_reduced": float(chi2_reduced),
    "n_frames": M
})

logger.warning("physics.poor_fit", extra={
    "experiment_id": experiment_id,
    "ball_id": ball_id,
    "window": "post",
    "chi2_reduced": float(chi2_reduced)
})

logger.error("physics.fit_diverged", extra={
    "experiment_id": experiment_id,
    "ball_id": ball_id,
    "window": "pre",
    "t_rel": t_rel.tolist(),
    "x_m": x_m.tolist(),
    "sigma_x_m": sigma_x_m.tolist()
})
```

### 13.2 Diagnostics in output JSON

The `fit_diagnostics` block in `velocities.json` includes:

- `pre_window_frames`: `[start, end]`
- `post_window_frames`: `[start, end]`
- `pre_chi2_reduced`: float
- `post_chi2_reduced`: float
- `pre_dof`: int
- `post_dof`: int
- `pre_n_frames_used`: int (after NaN removal)
- `post_n_frames_used`: int

These are forwarded to the React Results screen and displayed as a collapsible "Advanced" section — giving the user visibility into fit quality without cluttering the primary output.

### 13.3 Debug hook: position vs fit plot

For development, `fitting.py` includes a conditional matplotlib export:

```python
if os.environ.get("PHYSICS_DEBUG_PLOTS"):
    fig, ax = plt.subplots()
    ax.errorbar(t_rel, x_m, yerr=sigma_x_m, fmt='o', label='tracked')
    ax.plot(t_rel, kinematic_model(t_rel, *popt), label='fit')
    ax.set_xlabel("t (s)"); ax.set_ylabel("x (m)")
    fig.savefig(f"debug_fit_{ball_id}_{window}.png")
```

Set `PHYSICS_DEBUG_PLOTS=1` during development; not enabled in production container.

---

## 14. Future Improvements

| Limitation now                                        | Future upgrade                                                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Motion projected to 1D (axis of max variance)         | Full 2D / 3D velocity vector fitting; report speed as magnitude with directional component                  |
| First collision only in multi-ball 3-body scenarios   | Sequential collision detection: find all peaks in `delta_v`, define windows between each pair               |
| Friction assumed constant (linear deceleration model) | Non-linear friction model: viscous `a ∝ v` or Coulomb `a = μg` with iterative fitting                       |
| No inelastic deformation energy                       | Add plastic deformation term: `KE_loss = KE_before - KE_after - W_plastic` (user-entered deformation depth) |
| `cor` only computed for 2-ball case                   | Generalise to 3-ball by computing pairwise relative velocities at collision frames                          |
| Window size fixed at 7 frames                         | Expose as UI slider with live re-computation; store as part of experiment parameters                        |
| No outlier rejection within fit window                | Add iterative sigma-clipping: refit after removing frames with residual > 3σ                                |
| Single-axis position only                             | 2D velocity vector: `(vx, vy)` from simultaneous fit on both axes; total speed = `sqrt(vx^2 + vy^2)`        |

```

```
