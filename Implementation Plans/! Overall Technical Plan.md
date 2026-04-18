## 0. Design Philosophy

**Accuracy over speed. Always.**

Since this is post-processing (not real-time), we make zero compromises for performance.
Every algorithm choice below prioritises measurement accuracy. Processing time is irrelevant.
A single experiment can take 10 seconds or 10 minutes to process — the result must be correct.

---

## 1. System Overview

```
┌──────────────────────────────────────────────────────────┐
│                        FIELD                             │
│                                                          │
│   iPhone 1 (overhead)     iPhone 2 (side-on)            │
│        │                        │                        │
│        └──────────┬─────────────┘                        │
│               WebRTC stream                              │
│               (local WiFi)                               │
└──────────────────┼───────────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────────┐
│                     PC MASTER                            │
│                                                          │
│   React + Vite (UI)                                      │
│        │                                                 │
│   Node.js (signaling, file storage, ffmpeg extraction)   │
│        │ gRPC                                            │
│   Python FastAPI (CV pipeline, physics engine)           │
│        ├── SAM2 tracker (PyTorch)                        │
│        ├── OpenCV (calibration, stereo reconstruction)   │
│        └── SciPy (physics fitting, uncertainty)          │
└──────────────────────────────────────────────────────────┘
```

---

## 2. Synchronisation

### Method: Continuous Visual Kinematic Sync (The Visual Metronome)

Rather than relying on network time protocols or hardware triggers, PhysicsCapture uses a
purely optical synchronisation strategy. No special hardware, network configuration, or
browser permissions are required.

**Setup:**
- The laptop screen displays a high-contrast white dot moving horizontally at a constant,
  known speed across a black background.
- The phones record this dot for **3 seconds before** the ball roll and **3 seconds after** it ends.
- The sync dot is always visible in the corner or edge of the physical scene captured by
  both cameras throughout the recording.

**Python CV Sync Analysis:**
- After upload and frame extraction, the Python pipeline runs SAM2 to track the sync dot
  across both camera sequences independently.
- For each camera, the dot's X-position vs. frame-index is fitted to a linear model:
  `x = m·n + c`
- This line fit gives two pieces of information per camera:
  1. **Sub-frame phase offset** — the fractional frame offset between the two cameras'
     shutters, bypassing shutter mismatch entirely.
  2. **True exact FPS** — the slope of the line encodes the camera's real frame rate,
     solving clock drift over the recording duration.
- Python generates a **master timestamp array**: a mapping from every integer frame index
  to a true synchronised millisecond timestamp, accounting for both phase offset and
  per-device clock drift.

**Physics Engine Integration:**
- All velocity fitting and physics calculations evaluate positions using **true timestamps**
  from the master timestamp array — never raw frame indices.
- This eliminates the two dominant sources of multi-camera timing error: shutter phase
  mismatch and per-device clock drift.

**Estimated sync accuracy:** sub-frame (< 0.5ms equivalent at 30fps), derived from the
residuals of the linear fit to the sync dot trajectory.

---

## 3. Camera Configuration

### Phone Web App Settings (getUserMedia)
```javascript
{
  video: {
    facingMode: 'environment',        // rear camera — higher resolution
    width: { ideal: 3840 },           // request max, iOS will cap but try
    height: { ideal: 2160 },
    frameRate: { ideal: 60, max: 60 }, // iOS Safari caps at 30fps (PWA limitation — acceptable)
    resizeMode: 'none'                 // no software scaling
  }
}
```

> **Note:** The phone client is a PWA (browser-based). iOS Safari caps `getUserMedia` at 30fps.
> This is the baseline assumption in the accuracy budget and is sufficient — 30fps yields ~1–2%
> velocity uncertainty, well below typical lab equipment. A native iOS app is not being pursued.

### Recommended Physical Setup
- **Camera 1 (primary):** Side-on, perpendicular to ball travel axis, at ball height
- **Camera 2 (overhead):** Directly above, captures X-Z plane
- Together: full 3D position reconstruction without parallax ambiguity

### Recording Format
- The phone web app uses the native **`MediaRecorder` API** to capture video locally
  on the device during the experiment at a massive constant bitrate:
  ```javascript
  new MediaRecorder(stream, {
    mimeType: 'video/webm;codecs=vp9',  // avc1 fallback on iOS
    videoBitsPerSecond: 100_000_000      // 100 Mbps
  })
  ```
  At 100 Mbps, inter-frame compression artefacts are negligible for physics tracking purposes.
- Recording happens entirely on the phone — **no network transfer occurs during capture**.
- When recording stops, the phone uploads the single `.webm` / `.mp4` file to the
  Node.js backend via a standard HTTP multipart POST.
- Node.js invokes `ffmpeg` (via `child_process`) to extract the video into a **lossless,
  zero-padded PNG sequence** locally on the server:
  ```bash
  ffmpeg -i input.webm -vsync 0 frames/cam0/frame_%06d.png
  ```
- Each PNG is then available to the Python pipeline. No lossy compression exists
  anywhere in the final frame sequence.

---

## 4. Frontend (React + Vite + TypeScript)

### Stack
| Concern | Library | Reason |
|---|---|---|
| Framework | React 18 + Vite | You know it, fast HMR |
| Language | TypeScript strict mode | Catch unit/type bugs early |
| Styling | Tailwind CSS | Fast layout |
| State | Zustand | Lightweight, no boilerplate |
| WebRTC | Native browser API + simple-peer | Peer connection abstraction |
| WebSocket | Native + `ws` types | Signaling + control messages |
| Canvas | Native Canvas2D API | Direct pixel access, no abstraction overhead |
| Video | HTML5 `<video>` + `MediaStream` | |
| Graphing | Recharts | Velocity/momentum output charts |
| Protocol buffers | `protobufjs` | Type-safe gRPC messages |

### Key UI Screens

#### 1. Session Setup
- Add camera devices (PC webcam or linked phones via QR code/room code)
- Camera preview with live feed from all devices
- Position guidance: ensure the laptop screen's sync dot is visible in all camera frames
- **Ball configuration:** number of balls (1–3), mass per ball in grams, mass uncertainty (default ±1g)

#### 2. Calibration
- User places calibration board (checkerboard) in frame
- System detects corners automatically (OpenCV via backend)
- Intrinsic calibration per camera (focal length, distortion coefficients)
- Extrinsic calibration between cameras (rotation matrix, translation vector)
- Calibration quality score shown (reprojection error in pixels)

#### 3. Experiment Recording
- Laptop screen displays the Visual Metronome (moving sync dot) automatically
- Live preview from all cameras simultaneously (via WebRTC)
- Press record → all phones begin `MediaRecorder` local capture
- Sync dot recorded for 3 seconds before and after the ball roll
- Stop recording → phones upload single video file to server → `ffmpeg` extracts PNG frames

#### 4. Ball Selection & Tracking
- Frame scrubber per camera
- User clicks/draws bounding box around each ball on frame 0 (up to **3 balls**)
- "Track" button triggers SAM2 pipeline on backend — all balls tracked simultaneously in one pass
- Tracked path overlaid on video as coloured trajectory line (distinct colour per ball)
- Confidence score per frame — low confidence frames flagged for manual correction
- Manual point adjustment: drag any tracked point to correct it
- **Single-camera mode:** motion treated as planar; ruler calibration used for px→mm scale

#### 5. Results
- Velocity vs time graph per ball (with error bars)
- Pre/post collision velocity table
- Momentum before/after (each ball + total system)
- Kinetic energy before/after
- % momentum conserved
- Coefficient of restitution
- All values shown with **uncertainty estimates** (not just point values)
- Export: CSV, JSON, PDF report

---

## 5. Node.js Backend (Signaling + Coordination)

### Role
Node is **not** the compute layer. It is the coordinator:
- WebRTC signaling (ICE candidates, SDP exchange) and live preview relay
- File storage coordination (receives post-recording video files from phones)
- Video frame extraction: invokes `ffmpeg` via `child_process` to unpack `.webm`/`.mp4`
  into lossless PNG sequences (`ffmpeg` is a required system dependency)
- Job queue for Python CV pipeline
- WebSocket relay for UI ↔ Python status updates

### Stack
```
Node.js 20 LTS
Express 5
ws (WebSocket)
@grpc/grpc-js + @grpc/proto-loader  (→ Python service)
multer  (video file upload handling)
better-sqlite3  (experiment database)
ffmpeg  (system dependency — frame extraction from uploaded video)
```

### File Storage
```
/experiments/
  {experimentId}/
    metadata.json         ← session info, camera params, sync data
    calibration/
      cam0_intrinsics.json
      cam1_intrinsics.json
      stereo_extrinsics.json
    raw/
      cam0.webm            ← original uploaded video file from phone
      cam1.webm
    frames/
      cam0/
        frame_000001.png   ← extracted by ffmpeg (lossless, zero-padded)
        frame_000002.png
        ...
      cam1/
        ...
    results/
      sync.json             ← master timestamp array (frame index → true ms)
      tracks.json           ← ball positions per frame per camera
      velocities.json       ← fitted velocities with uncertainty
      momentum.json         ← final physics output
```

---

## 6. Python CV & Physics Service (FastAPI + gRPC)

### Why Python here, not C++

The critical tracking step uses **SAM2** (Meta's Segment Anything Model 2).
SAM2 is PyTorch-native. Running it from C++ via ONNX introduces:
- Quantisation loss
- Architecture compromises
- Maintenance burden

Since accuracy > speed, we run SAM2 natively in Python with PyTorch.
Everything else (OpenCV calibration, stereo reconstruction, physics fitting)
is equally capable in Python — OpenCV's Python bindings call the same C++ code.

**If C++ is needed later** (e.g. embedded deployment), the Python service can be
replaced module by module with a C++ gRPC service without touching the rest of the system.

### Stack
```
Python 3.11
FastAPI + uvicorn          (REST API + WebSocket status)
grpcio + grpcio-tools      (gRPC server for Node ↔ Python)
torch + torchvision        (SAM2 runtime)
segment-anything-2         (Meta SAM2 — pip install)
opencv-python-headless     (camera calibration, stereo, image ops)
numpy                      (array math)
scipy                      (curve fitting, optimization, statistics)
matplotlib                 (optional: debug visualisations)
uncertainties              (automatic error propagation through all physics calcs)
```

---

## 7. Computer Vision Pipeline

### Step 1: Camera Intrinsic Calibration
```
Tool: OpenCV calibrateCamera()
Input: 20+ images of 9×7 checkerboard from each camera
Output per camera:
  - Camera matrix K (focal length fx, fy, principal point cx, cy)
  - Distortion coefficients (k1, k2, p1, p2, k3)
  - Reprojection error target: < 0.3 pixels RMS

Applied to all captured frames before any tracking:
  undistorted_frame = cv2.undistort(frame, K, dist)
```

### Step 2: Stereo Calibration (Multi-Camera)
```
Tool: OpenCV stereoCalibrate()
Input: Simultaneous checkerboard images from both cameras
Output:
  - Rotation matrix R (camera 0 → camera 1)
  - Translation vector T
  - Essential matrix E
  - Fundamental matrix F
  - Stereo reprojection error target: < 0.5 pixels RMS

This gives us the precise 3D relationship between camera positions.
```

### Step 3: Ball Tracking with SAM2

**What SAM2 is:**
Meta's Segment Anything Model 2 is a foundation model for visual segmentation
in images and video. Given an initial prompt (click or bounding box), it tracks
the target object through an entire video sequence. It handles:
- Texture-less objects (a yellow tennis ball is actually easy)
- Partial occlusion
- Motion blur
- Lighting changes
- Objects temporarily leaving and re-entering frame

**Why it's the right choice:**
It is currently the most accurate general-purpose video object tracker available.
It was specifically designed for the "user selects object, model locks on" use case.
It runs offline (post-processing), so its ~200ms/frame processing time is irrelevant.

```python
from sam2.build_sam import build_sam2_video_predictor

predictor = build_sam2_video_predictor("sam2_hiera_large.pt")  # largest = most accurate

# User provides initial click on ball
inference_state = predictor.init_state(video_path=frame_dir)
predictor.add_new_points(
    inference_state,
    frame_idx=0,
    obj_id=1,
    points=[[cx, cy]],  # user click coordinates
    labels=[1]           # 1 = foreground
)

# Propagate through all frames
for frame_idx, obj_ids, masks in predictor.propagate_in_video(inference_state):
    # masks[0] is a binary segmentation mask for the ball
    # Extract centroid with sub-pixel accuracy
    centroid = get_subpixel_centroid(masks[0])
    tracks[frame_idx] = centroid
```

**Sub-pixel centroid extraction:**
```python
def get_subpixel_centroid(mask, frame):
    # Use mask as region of interest
    # Fit 2D Gaussian to pixel intensity within mask region
    # Centroid of Gaussian = sub-pixel ball centre
    # Accuracy: ~0.1–0.3 pixel = sub-mm at typical distances
    from scipy.optimize import curve_fit
    ...
```

**Confidence & fallback:**
- SAM2 outputs mask confidence per frame
- Frames below threshold (< 0.7) are flagged
- User is prompted to manually correct flagged frames in UI
- After correction, SAM2 is re-propagated from corrected keyframe

**Bi-directional tracking:**
For maximum accuracy, track forward AND backward through the video,
then take weighted average of both passes (weighted by confidence score).
This is standard practice in research and significantly reduces drift.

### Step 4: 3D Reconstruction *(multi-camera only — optional)*

Single-camera experiments use the planar assumption: 2D pixel coordinates are converted
directly to real-world distances using the ruler scale factor. No stereo reconstruction needed.

For multi-camera setups, stereo triangulation gives full 3D positions:

```python
# For each frame, we have 2D position in each camera: p0, p1
# Use stereo triangulation to get 3D world position

def triangulate_position(p0, p1, P0, P1):
    """
    p0, p1: 2D undistorted pixel coordinates in cam0, cam1
    P0, P1: 3x4 projection matrices
    Returns: 3D world coordinate (X, Y, Z) in metres
    """
    point_4d = cv2.triangulatePoints(P0, P1, p0, p1)
    point_3d = point_4d[:3] / point_4d[3]
    return point_3d

# Reprojection error as quality check:
# Project 3D point back to each camera, compare to tracked 2D position
# Target: < 1 pixel reprojection error per frame
```

### Step 5: Scale Calibration
- User marks two points of known distance in frame (e.g. ends of a 1m ruler)
- Pixel-to-metre scale factor computed per camera
- Applied to all position measurements
- For 3D: physical world coordinates derived from stereo geometry (no ruler needed)

---

## 8. Physics Engine

### Velocity Fitting (NOT frame-differencing)

**Never compute velocity as (x2-x1)/dt directly.** This amplifies noise.

Instead, fit a physical model to the position data:

```python
from scipy.optimize import curve_fit
from uncertainties import ufloat, correlated_values

def fit_velocity_segment(times, positions):
    """
    Fit constant velocity model to a window of frames.
    Returns velocity with uncertainty.
    
    For rolling ball: v = v0 + a*t (allow small deceleration for friction)
    """
    def linear_model(t, x0, v0, a):
        return x0 + v0*t + 0.5*a*t**2
    
    popt, pcov = curve_fit(linear_model, times, positions, 
                            sigma=position_uncertainties,
                            absolute_sigma=True)
    
    # pcov is the covariance matrix → extract uncertainties
    x0, v0, a = correlated_values(popt, pcov)
    return v0  # ufloat with automatic uncertainty propagation
```

### Collision Frame Detection
```
1. Compute rolling velocity estimate over window of 5 frames
2. Monitor for sudden velocity change > threshold
3. Flag frame range as collision zone
4. Pre-collision window: 5–10 frames before collision
5. Post-collision window: 5–10 frames after collision
6. Fit separate velocity models to pre and post windows
```

### Momentum & Energy Calculations
```python
# All calculations use `uncertainties` library
# Uncertainty propagates automatically through every operation
# Supports 1–3 balls; masses entered manually by user in Session Setup

m1 = ufloat(mass1_kg, mass1_uncertainty)
m2 = ufloat(mass2_kg, mass2_uncertainty)
# m3 = ufloat(mass3_kg, mass3_uncertainty)  # if 3-ball experiment

v1_before = fit_velocity(pre_collision_frames, ball=1)
v2_before = fit_velocity(pre_collision_frames, ball=2)
v1_after  = fit_velocity(post_collision_frames, ball=1)
v2_after  = fit_velocity(post_collision_frames, ball=2)

p_before = m1 * v1_before + m2 * v2_before
p_after  = m1 * v1_after  + m2 * v2_after

# KE for a solid rolling sphere = translational + rotational = (1/2 + 1/5)mv² = 0.7mv²
ke_before = 0.7*m1*v1_before**2 + 0.7*m2*v2_before**2
ke_after  = 0.7*m1*v1_after**2  + 0.7*m2*v2_after**2

e_restitution = abs(v2_after - v1_after) / abs(v1_before - v2_before)

conservation_error = (p_after - p_before) / p_before * 100  # % with uncertainty
```

Every output value has an **automatic uncertainty estimate** derived from
position tracking accuracy, calibration error, and mass measurement error.
Results display as e.g. `v = 1.34 ± 0.02 m/s` not just `v = 1.34 m/s`.

### Friction Compensation (optional)
If surface friction is measurable (from pre-collision deceleration),
it can be subtracted from the model. The fitting function already includes
an acceleration term `a` — if this is consistent across pre-collision frames,
it's friction. The model can compensate automatically.

---

## 9. gRPC Interface (Node ↔ Python)

```protobuf
// physics.proto

service PhysicsCapture {
  rpc RunCalibration(CalibrationRequest) returns (stream CalibrationStatus);
  rpc TrackBalls(TrackingRequest) returns (stream TrackingStatus);
  rpc ComputePhysics(PhysicsRequest) returns (PhysicsResult);
}

message TrackingRequest {
  string experiment_id = 1;
  repeated BallSeed seeds = 2;    // user-provided initial clicks per ball per camera
}

message BallSeed {
  int32 camera_id = 1;
  int32 frame_idx = 2;
  float x = 3;
  float y = 4;
}

message TrackingStatus {
  int32 frame = 1;
  float progress = 2;
  repeated TrackedPoint points = 3;
  float confidence = 4;
}

message PhysicsResult {
  repeated BallResult balls = 1;
  SystemResult system = 2;
}

message BallResult {
  float v_before = 1;
  float v_before_uncertainty = 2;
  float v_after = 3;
  float v_after_uncertainty = 4;
  float momentum_before = 5;
  float momentum_after = 6;
}
```

---

## 10. Full Dependency List

### Node.js Service
```json
{
  "dependencies": {
    "express": "^5.0",
    "ws": "^8.0",
    "better-sqlite3": "^9.0",
    "@grpc/grpc-js": "^1.10",
    "@grpc/proto-loader": "^0.7",
    "multer": "^1.4",
    "simple-peer": "^9.11",
    "uuid": "^9.0"
  }
}
```
> **System dependency:** `ffmpeg` must be installed and on `PATH`.
> Used via `child_process.spawn` for video → PNG frame extraction.

### Python Service
```
torch>=2.3
torchvision
segment-anything-2      # pip install git+https://github.com/facebookresearch/sam2
opencv-python-headless>=4.9
numpy>=1.26
scipy>=1.12
fastapi>=0.110
uvicorn[standard]
grpcio>=1.62
grpcio-tools
protobuf
uncertainties>=3.1
Pillow
```

### Frontend
```json
{
  "dependencies": {
    "react": "^18",
    "react-dom": "^18",
    "typescript": "^5",
    "vite": "^5",
    "zustand": "^4",
    "recharts": "^2",
    "tailwindcss": "^3",
    "simple-peer": "^9.11",
    "protobufjs": "^7"
  }
}
```

---

## 11. Accuracy Budget

Expected end-to-end accuracy for a typical rolling ball experiment
(1m field of view, 30fps, 1080p):

| Error Source | Magnitude | Mitigation |
|---|---|---|
| Frame timestamp sync | < 0.5ms | Visual Metronome — sync dot linear fit, sub-frame accuracy |
| Ball position (single camera) | ±0.3px → ±0.3mm | SAM2 + Gaussian sub-pixel fit |
| Ball position (stereo 3D) | ±0.5mm | Stereo triangulation |
| Lens distortion | <0.1px after correction | Checkerboard calibration |
| Scale calibration | ±0.5mm/m | Physical ruler, multiple samples |
| Velocity fit | ±0.005–0.02 m/s | Multi-frame polynomial fit + covariance |
| **Total velocity uncertainty** | **~1–2%** | All above combined via propagation |
| **Total momentum uncertainty** | **~2–3%** | Includes mass measurement error |

For comparison: typical undergraduate lab equipment achieves 5–15% momentum error.

---

## 12. Build Order

### Sprint 1 — Core Infrastructure
- [ ] Repo setup: monorepo (Node + Python + React in `/packages`)
- [ ] WebRTC signaling: phone → PC connection (one phone, for live preview only)
- [ ] `MediaRecorder` local capture on phone PWA (100 Mbps, webm/mp4)
- [ ] Post-recording video upload (HTTP multipart POST to Node.js)
- [ ] `ffmpeg` frame extraction pipeline on Node.js server → PNG sequence
- [ ] Basic React UI: camera preview, record button, upload progress indicator

### Sprint 2 — Single Camera Tracking ✦ *First working tool*
- [ ] SAM2 service running locally
- [ ] gRPC interface Node ↔ Python
- [ ] User clicks up to 3 balls on frame 0 → tracking runs → paths overlaid on video
- [ ] Manual correction of tracked points in UI
- [ ] Scale calibration (two-point ruler marking)
- [ ] Mass input form in Session Setup (per ball, with uncertainty)
- [ ] Velocity fitting + momentum output (single camera, planar, up to 3 balls)

> After Sprint 2 the system is usable end-to-end for planar experiments.
> Sprints 3–4 add sync accuracy and 3D reconstruction but are not blocking.

### Sprint 3 — Synchronisation
- [ ] Visual Metronome: laptop screen displays moving sync dot (constant-speed, high-contrast)
- [ ] Phone PWA: ensure sync dot is framed at start/end of every recording (3s pre/post)
- [ ] Python: SAM2 sync dot tracking on both camera sequences post-extraction
- [ ] Python: linear fit to dot X-position → sub-frame phase offset + true FPS per camera
- [ ] Python: master timestamp array generation (`frame_index → true_ms`) → `sync.json`
- [ ] Physics Engine: all calculations consume true timestamps, not raw frame indices
- [ ] Multi-camera UI: side-by-side synchronised scrubbing

### Sprint 4 — Multi-Camera Calibration & 3D *(optional — not required for planar experiments)*
- [ ] Checkerboard calibration flow (UI + OpenCV backend)
- [ ] Stereo extrinsic calibration
- [ ] 3D triangulation pipeline
- [ ] 3D trajectory visualisation in UI (Three.js or simple canvas projection)

### Sprint 5 — Physics Polish
- [ ] Full uncertainty propagation throughout
- [ ] Friction compensation
- [ ] Coefficient of restitution
- [ ] Collision frame auto-detection
- [ ] Results export (CSV, JSON)

### Sprint 6 — Hardening
- [ ] Experiment database (save, reload, compare)
- [ ] Calibration profiles (save per venue/setup)
- [ ] Error reporting + manual override flows
- [ ] Performance profiling (tracking pipeline speed)

---

## 13. Repository Structure

```
physicscapture/
├── packages/
│   ├── frontend/          ← React + Vite
│   │   ├── src/
│   │   │   ├── components/
│   │   │   ├── stores/        ← Zustand stores
│   │   │   ├── hooks/
│   │   │   ├── pages/
│   │   │   └── lib/
│   │   │       ├── webrtc.ts
│   │   │       ├── mediaRecorder.ts
│   │   │       └── canvas.ts
│   │   └── vite.config.ts
│   │
│   ├── signaling/         ← Node.js
│   │   ├── src/
│   │   │   ├── server.ts
│   │   │   ├── ffmpeg.ts      ← video → PNG frame extraction
│   │   │   ├── storage.ts
│   │   │   └── grpc-client.ts
│   │   └── package.json
│   │
│   └── cv-service/        ← Python
│       ├── main.py            ← FastAPI app
│       ├── grpc_server.py
│       ├── sync/
│       │   ├── dot_tracker.py     ← SAM2 sync dot tracking
│       │   └── timestamp_array.py ← master frame→ms mapping
│       ├── tracking/
│       │   ├── sam2_tracker.py
│       │   └── centroid.py
│       ├── calibration/
│       │   ├── intrinsic.py
│       │   └── stereo.py
│       ├── physics/
│       │   ├── fitting.py
│       │   └── momentum.py
│       └── requirements.txt
│
├── proto/
│   └── physics.proto      ← shared gRPC definitions
│
├── experiments/           ← data storage (gitignored)
└── docker-compose.yml     ← starts all three services locally (recommended deployment)
```

### Local Deployment

The system runs entirely on the lab laptop. No internet connection or user accounts required.

```bash
# Start all services
docker-compose up

# Phones connect to: http://<laptop-ip>:3000
# Recommended: laptop hotspot → all devices guaranteed on same subnet
# Laptop IP on hotspot: typically 192.168.137.1 (Windows) or 192.168.2.1 (macOS)
```

---

## 14. Decisions

All open questions resolved:

1. **Ball mass input: Manual entry.**
   User enters mass (in grams) per ball in the Session Setup screen before running an experiment.
   A user-specified uncertainty (default ±1g) propagates automatically through all momentum calculations
   via the `uncertainties` library. No load-cell integration needed.

2. **Single-camera mode: Planar motion assumed.**
   For single-camera experiments, motion is assumed to be confined to the plane of the camera's field of view.
   This is valid for table/floor setups and eliminates the need for stereo reconstruction in the common case.
   Two-point ruler calibration gives the px→mm scale factor. The full 3D pipeline (Sprint 4) is additive,
   not required for a working tool.

3. **Multiple balls: Maximum 3.**
   SAM2 tracks up to 3 balls simultaneously. The UI supports up to 3 click-to-seed interactions per camera.
   The Results screen shows per-ball and system-level momentum for all combinations up to 3 balls.
   Supporting more than 3 is not a goal — occlusion and collision complexity grows rapidly beyond this.

4. **Phone client: PWA only. No native app.**
   The PWA approach (getUserMedia in mobile browser) caps at 30fps on iOS, which is acceptable —
   30fps is the baseline in the accuracy budget and already beats typical lab equipment by 3–5×.
   A native iOS app would unlock 120fps via AVCaptureSession, but introduces a separate Swift codebase,
   Xcode builds, and provisioning overhead. The "open a URL on any phone" workflow is more valuable
   for a small-group lab setting. If 120fps becomes necessary in future, the phone client can be
   replaced without touching the rest of the system.

5. **Deployment: Local only.**
   The entire system runs on a single laptop. Phones connect over local WiFi (or laptop hotspot).
   No authentication, no user accounts, no cloud. `docker-compose up` starts all three services.
   Data is stored locally under `/experiments/`. A phone hotspot from the laptop is recommended
   if venue WiFi is unreliable or puts devices on separate subnets.

6. **Frame capture: `MediaRecorder` (not live WebRTC frame streaming).**
   The original design streamed raw `ImageBitmap` frames over WebRTC and uploaded PNGs in real
   time during capture. This was a RAM and network bottleneck. The new approach uses the phone's
   native `MediaRecorder` API to record locally at 100 Mbps — network is only used once, after
   the experiment, to upload a single video file. Node.js then uses `ffmpeg` to extract a lossless
   PNG sequence. This is simpler, more reliable, and places no bandwidth constraint on the
   recording quality.

7. **Synchronisation: Visual Metronome (not PTP/IEEE 1588).**
   PTP over a browser required tunnelling UDP through WebRTC data channels (`node-ptpd` + custom
   client), adding significant complexity with uncertain cross-browser behaviour. The LED flash
   verification step also assumed precise frame-detection latency. The Visual Metronome (a
   constant-speed dot on the laptop screen, recorded by all cameras) solves both sub-frame phase
   offset and per-device clock drift purely through post-processing — no network protocol, no
   special hardware, no browser permissions. Sync quality is directly measurable from the fit
   residuals.

8. **Kinetic energy: 0.7·mv² for solid rolling spheres.**
   A solid rolling sphere has both translational KE (½mv²) and rotational KE (⅕mv²), giving a
   total of 0.7·mv². Using 0.5·mv² (pure translational) underestimates KE by ~30% and would
   produce a systematic error in energy conservation calculations.

---

*Plan version 1.2 — MediaRecorder migration, Visual Metronome sync, rolling KE correction*
