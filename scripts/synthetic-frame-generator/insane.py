"""

Features:
- Extreme physics: near-elastic collisions (restitution 0.97), doubled gravity,
  negligible air drag, spin transfer 0.55. Balls retain dangerous speed across
  the full 300-frame sequence.
- Immediate merge event: Ball 2 spawns directly beneath Ball 1 at just over
  2x radius spacing, forcing a dumbbell-style overlap on ~frame 1 before
  separation.
- Heavy occlusion: 5 foreground slats rendered above the balls. Fast motion
  allows balls to pass through gaps in 2-3 frames, and some slats can hide both
  balls simultaneously. Slats also move/bounce and alter trajectories.
- Radius pulsing: each ball oscillates ±7 px on independent sine cycles
  (38-frame period), forcing continuous mask rescaling.
- Intentional frame drops: every 18 frames, 3 consecutive rendered frames are
  omitted while physics continues, creating teleport jumps. Dropped indices are
  logged in insane_meta.json.
- Similar appearance: blue vs teal-blue balls with close luminance, limiting
  colour-based identity tracking.
- Background flicker: 20 felt-texture variants cycle every 8 frames, breaking
  static-background assumptions.
- Thin spinning markings: crossed stripes only 9% and 7% of radius width,
  flickering rapidly and distorting perceived outlines.
"""


import shutil
import math
from pathlib import Path
from PIL import Image
import numpy as np

try:
    from tqdm import tqdm
except ImportError:
    class tqdm:
        def __init__(self, iterable=None, total=None, desc="", unit="", **kwargs):
            self._it    = iter(iterable) if iterable is not None else None
            self._total = total or (len(iterable) if iterable is not None else "?")
            self._desc  = desc
            self._n     = 0
            self._postfix = ""
        def __iter__(self):
            return self
        def __next__(self):
            item = next(self._it)
            self._n += 1
            self._print()
            return item
        def _print(self):
            pct = self._n / self._total if isinstance(self._total, int) else 0
            bar = "█" * int(pct * 30) + "░" * (30 - int(pct * 30))
            end = "\n" if self._n == self._total else ""
            print(f"\r{self._desc}: [{bar}] {self._n}/{self._total}  {self._postfix}",
                  end=end, flush=True)
        def set_postfix_str(self, s, refresh=True):
            self._postfix = s
            if refresh:
                self._print()
        def __enter__(self):  return self
        def __exit__(self, *_): print()


# ── Configuration ──────────────────────────────────────────────────────────────
EXP_NAME          = "synthetic-insane-collision"
WIDTH, HEIGHT     = 1280, 720
TOTAL_FRAMES      = 300
FPS               = 60

# Physics — near-elastic, high energy
BASE_BALL_RADIUS  = 22
RADIUS_OSCILLATION= 7        # ± px sine wave per ball
RADIUS_PERIOD     = 38       # frames per full oscillation cycle
PEG_RADIUS        = 15
NUM_PEGS          = 28
RESTITUTION       = 0.97     # near-elastic ball collisions
WALL_RESTITUTION  = 0.95
AIR_DRAG          = 0.9999   # almost no drag — speed stays high
GRAVITY           = 0.38
SPIN_TRANSFER     = 0.55     # aggressive spin on every impact
MOTION_BLUR_N     = 10       # long ghost trail
ANGULAR_DRAG      = 0.995    # spin persists

# Frame-drop simulation — skip saving N frames every SKIP_EVERY frames
# Physics still advances; SAM2 sees a "teleport"
FRAME_DROP_EVERY  = 18       # drop window starts every N frames
FRAME_DROP_COUNT  = 3        # consecutive frames dropped per window

# Occluder slats — drawn OVER the balls to force occlusion
SLAT_HEIGHT       = 30       # px tall
SLAT_COLOR        = (14, 48, 22)   # near-felt, slightly distinguishable
SLAT_POSITIONS_Y  = [130, 240, 355, 470, 590]  # 5 horizontal slats

# Ball colours — deliberately similar (mid-blue vs teal-blue)
# SAM2 can't rely on colour alone to disambiguate
COL1 = (72,  190, 255)   # blue
COL2 = (88,  230, 195)   # teal-blue (similar luminance, close hue)

# Background flicker — regenerate grain every N frames
BG_FLICKER_EVERY  = 8

# ── Reproducible RNG ───────────────────────────────────────────────────────────
_rng = np.random.default_rng(13)


def _place_pegs(n, w, h, ball_r, peg_r, margin=70):
    """Dense peg field — avoid spawn corridor but pack them tight."""
    forbidden_x = 200   # keep left entry lane clear
    pegs = []
    attempts = 0
    min_sep = (peg_r + ball_r) * 1.9   # tighter packing than original
    while len(pegs) < n and attempts < 50_000:
        attempts += 1
        x = _rng.uniform(forbidden_x, w - 60)
        y = _rng.uniform(margin, h - margin)
        # avoid slat centres (don't embed pegs inside slats)
        in_slat = any(abs(y - sy) < SLAT_HEIGHT + peg_r for sy in SLAT_POSITIONS_Y)
        if in_slat:
            continue
        too_close = any(np.hypot(x - px, y - py) < min_sep for px, py in pegs)
        if not too_close:
            pegs.append((x, y))
    print(f"  placed {len(pegs)}/{n} pegs")
    return pegs


# ── Background ─────────────────────────────────────────────────────────────────

def _felt_background(width, height, seed=42):
    arr = np.zeros((height, width, 3), dtype=np.float32)
    arr[:, :] = [18, 58, 30]
    rng2 = np.random.default_rng(seed)
    grain = rng2.normal(0, 5, (height, width, 3)).astype(np.float32)
    arr = np.clip(arr + grain, 0, 255)
    ys, xs = np.ogrid[0:height, 0:width]
    cx, cy = width / 2, height / 2
    vign = np.sqrt(((xs - cx) / cx) ** 2 + ((ys - cy) / cy) ** 2)
    vign = np.clip(vign, 0, 1) ** 1.6 * 50
    arr = np.clip(arr - vign[:, :, None], 0, 255)
    return arr.astype(np.uint8)


# ── Occluder slats ──────────────────────────────────────────────────────────────

def _draw_slats(arr):
    """Draw horizontal occlusion bars across the full width."""
    for sy in SLAT_POSITIONS_Y:
        y0 = max(0, sy - SLAT_HEIGHT // 2)
        y1 = min(HEIGHT, sy + SLAT_HEIGHT // 2)
        arr[y0:y1, :] = SLAT_COLOR
    return arr


# ── Ball rendering ──────────────────────────────────────────────────────────────

def _draw_ball(arr, cx, cy, radius, base_rgb, angle=0.0):
    H, W = arr.shape[:2]
    ys, xs = np.ogrid[0:H, 0:W]
    dx = xs - cx;  dy = ys - cy
    dist2 = dx * dx + dy * dy
    r2    = radius * radius
    mask  = dist2 <= r2
    dist  = np.sqrt(dist2.astype(np.float32))

    # Shadow
    shadow_cx, shadow_cy = cx, cy + radius + 6
    sw = radius * 1.05;  sh = radius * 0.26
    sdx = xs - shadow_cx
    sdy = (ys - shadow_cy) / (sh / sw + 1e-6)
    s_dist  = np.sqrt(sdx * sdx + sdy * sdy)
    s_alpha = np.clip(1 - s_dist / sw, 0, 1) ** 1.5 * 0.55
    for c in range(3):
        arr[:, :, c] = np.where(
            s_alpha > 0,
            (arr[:, :, c] * (1 - s_alpha)).astype(np.uint8),
            arr[:, :, c])

    # Body gradient
    norm = np.where(mask, dist / radius, 1.0)
    grad = 1.0 - norm * 0.50
    r0, g0, b0 = base_rgb[0]/255., base_rgb[1]/255., base_rgb[2]/255.

    # Specular
    spec_cx = cx - radius*0.30;  spec_cy = cy - radius*0.36
    spec_r  = radius * 0.50
    s_dist2 = (xs - spec_cx)**2 + (ys - spec_cy)**2
    spec_lobe = np.clip(1 - np.sqrt(s_dist2)/spec_r, 0, 1)**2.0 * 0.80
    hot_cx = cx - radius*0.26;   hot_cy = cy - radius*0.31
    hot_r  = radius * 0.17
    h_dist2 = (xs - hot_cx)**2 + (ys - hot_cy)**2
    hotspot  = np.clip(1 - np.sqrt(h_dist2)/hot_r, 0, 1)**3.0 * 0.65
    combined_spec = np.clip(spec_lobe + hotspot, 0, 1)

    ball_r = np.clip((r0*grad + combined_spec)*255, 0, 255)
    ball_g = np.clip((g0*grad + combined_spec)*255, 0, 255)
    ball_b = np.clip((b0*grad + combined_spec)*255, 0, 255)

    arr[:,:,0] = np.where(mask, ball_r, arr[:,:,0]).astype(np.uint8)
    arr[:,:,1] = np.where(mask, ball_g, arr[:,:,1]).astype(np.uint8)
    arr[:,:,2] = np.where(mask, ball_b, arr[:,:,2]).astype(np.uint8)

    # Spin stripe — narrow so it flickers rapidly
    stripe_dx = np.cos(angle)
    stripe_dy = np.sin(angle)
    proj = dx * stripe_dy - dy * stripe_dx
    stripe_mask = mask & (np.abs(proj) < radius * 0.09)
    for c in range(3):
        arr[:,:,c] = np.where(
            stripe_mask,
            np.clip(arr[:,:,c] * 0.45, 0, 255),
            arr[:,:,c]).astype(np.uint8)

    # Second stripe 90° offset — makes spin visually unambiguous
    proj2 = dx * (-stripe_dy) - dy * stripe_dx
    stripe_mask2 = mask & (np.abs(proj2) < radius * 0.07)
    for c in range(3):
        arr[:,:,c] = np.where(
            stripe_mask2,
            np.clip(arr[:,:,c] * 0.55, 0, 255),
            arr[:,:,c]).astype(np.uint8)

    # Rim
    rim_inner = (radius - 1.2)**2
    rim_outer = (radius + 0.5)**2
    rim_mask  = (dist2 >= rim_inner) & (dist2 <= rim_outer)
    for c in range(3):
        arr[:,:,c] = np.where(
            rim_mask,
            np.clip(arr[:,:,c]*0.65 + 255*0.35, 0, 255),
            arr[:,:,c]).astype(np.uint8)

    return arr


def _draw_peg(arr, cx, cy, radius):
    H, W = arr.shape[:2]
    ys, xs = np.ogrid[0:H, 0:W]
    dx = xs - cx;  dy = ys - cy
    dist2 = dx*dx + dy*dy
    r2    = radius*radius
    mask  = dist2 <= r2
    dist  = np.sqrt(dist2.astype(np.float32))

    norm  = np.where(mask, dist/radius, 1.0)
    grad  = 1.0 - norm*0.45
    ivory = np.array([220, 205, 170], dtype=np.float32)/255.

    spec_cx = cx - radius*0.28;  spec_cy = cy - radius*0.32
    spec_r  = radius*0.40
    s_dist2 = (xs - spec_cx)**2 + (ys - spec_cy)**2
    spec    = np.clip(1 - np.sqrt(s_dist2)/spec_r, 0, 1)**2.5 * 0.70

    for c in range(3):
        val = np.clip((ivory[c]*grad + spec)*255, 0, 255)
        arr[:,:,c] = np.where(mask, val, arr[:,:,c]).astype(np.uint8)

    rim_inner = (radius - 1.0)**2
    rim_outer = (radius + 0.5)**2
    rim_mask  = (dist2 >= rim_inner) & (dist2 <= rim_outer)
    for c in range(3):
        arr[:,:,c] = np.where(
            rim_mask,
            np.clip(arr[:,:,c]*0.65 + 255*0.35, 0, 255),
            arr[:,:,c]).astype(np.uint8)

    return arr


def _draw_motion_blur(arr, trail, radius, base_rgb):
    n = len(trail)
    H, W = arr.shape[:2]
    ys, xs = np.ogrid[0:H, 0:W]
    for k, (px, py) in enumerate(reversed(trail)):
        alpha = 0.22 * (k + 1) / n
        mask  = ((xs - px)**2 + (ys - py)**2) <= radius**2
        for c, base in enumerate(base_rgb):
            arr[:,:,c] = np.where(
                mask,
                np.clip(arr[:,:,c]*(1-alpha) + base*alpha, 0, 255),
                arr[:,:,c]).astype(np.uint8)
    return arr


# ── Physics ────────────────────────────────────────────────────────────────────

def _ccd(p1, p2, v1, v2, r1, r2):
    dp = p2 - p1
    dv = v2 - v1
    a  = np.dot(dv, dv)
    b  = 2*np.dot(dp, dv)
    c  = np.dot(dp, dp) - (r1 + r2)**2
    if a < 1e-10:
        return None
    disc = b*b - 4*a*c
    if disc < 0:
        return None
    t = (-b - np.sqrt(disc)) / (2*a)
    return float(t) if 0.0 <= t <= 1.0 else None


def _resolve_ball_ball(v1, v2, p1, p2, e=RESTITUTION):
    n    = p2 - p1
    dist = np.linalg.norm(n)
    if dist < 1e-8:
        return v1, v2
    n   /= dist
    dot  = np.dot(v1 - v2, n)
    if dot <= 0:
        return v1, v2
    imp = (1 + e)*dot/2
    return v1 - imp*n, v2 + imp*n


def _resolve_ball_peg(v, ball_pos, peg_pos, omega, e=RESTITUTION):
    n    = ball_pos - peg_pos
    dist = np.linalg.norm(n)
    if dist < 1e-8:
        return v, omega
    n   /= dist
    dot  = np.dot(v, n)
    if dot >= 0:
        return v, omega
    t         = np.array([-n[1], n[0]])
    v_t       = np.dot(v, t)
    v_new     = v - (1 + e)*dot*n
    omega_new = omega + SPIN_TRANSFER*v_t/BASE_BALL_RADIUS
    return v_new, omega_new


def _wall_bounce(p, v, r, w, h, e=WALL_RESTITUTION):
    if p[0] - r < 0:     p[0] = r;     v[0] =  abs(v[0])*e
    if p[0] + r > w:     p[0] = w - r; v[0] = -abs(v[0])*e
    if p[1] - r < 0:     p[1] = r;     v[1] =  abs(v[1])*e
    if p[1] + r > h:     p[1] = h - r; v[1] = -abs(v[1])*e


def _separate(p1, p2, r1, r2):
    d    = p2 - p1
    dist = np.linalg.norm(d)
    overlap = (r1 + r2) - dist
    if overlap > 0 and dist > 1e-8:
        push = d/dist*(overlap/2 + 0.5)
        p1 -= push
        p2 += push


def _separate_peg(ball_pos, peg_pos, ball_r, peg_r):
    d    = ball_pos - peg_pos
    dist = np.linalg.norm(d)
    overlap = (ball_r + peg_r) - dist
    if overlap > 0 and dist > 1e-8:
        ball_pos += d/dist*(overlap + 0.5)


# ── Slat collision — reflect vertical velocity when crossing a slat ────────────

def _slat_bounce(p, v, ball_r, e=WALL_RESTITUTION):
    """Push ball out of any slat it has penetrated and reflect vy."""
    for sy in SLAT_POSITIONS_Y:
        top    = sy - SLAT_HEIGHT//2
        bottom = sy + SLAT_HEIGHT//2
        # Check if ball centre is within slat + radius
        if p[1] + ball_r > top and p[1] - ball_r < bottom:
            # Which side did we come from? Use velocity sign
            if v[1] > 0:
                p[1] = top - ball_r - 0.5
                v[1] = -abs(v[1])*e
            else:
                p[1] = bottom + ball_r + 0.5
                v[1] =  abs(v[1])*e


# ── Main ───────────────────────────────────────────────────────────────────────

def generate():
    # Resolve project root (3 levels up from scripts/synthetic-frame-generator/)
    project_root = Path(__file__).resolve().parent.parent.parent
    base_dir     = project_root / "packages" / "experiments" / EXP_NAME
    frames_dir   = base_dir / "frames" / "cam0"
    if base_dir.exists():
        shutil.rmtree(base_dir)
    frames_dir.mkdir(parents=True)

    print(f"[INSANE MODE] Generating {TOTAL_FRAMES} frames → {frames_dir}")
    print(f"  occluder slats : {len(SLAT_POSITIONS_Y)} @ y={SLAT_POSITIONS_Y}")
    print(f"  frame drops    : every {FRAME_DROP_EVERY} frames, drop {FRAME_DROP_COUNT}")
    print(f"  radius osc     : ±{RADIUS_OSCILLATION}px, period={RADIUS_PERIOD}fr")
    print(f"  bg flicker     : every {BG_FLICKER_EVERY} frames")

    # Pre-bake a pool of background variants
    bg_pool = [_felt_background(WIDTH, HEIGHT, seed=s) for s in range(20)]

    pegs = _place_pegs(NUM_PEGS, WIDTH, HEIGHT, BASE_BALL_RADIUS, PEG_RADIUS)

    # ── Launch — high energy, close initial separation (will merge briefly) ────
    # Ball 1: fast, angled down-right, starts upper-left
    p1 = np.array([75.0,  HEIGHT * 0.28])
    v1 = np.array([22.0,  14.0])   # steeper downward angle — crosses slats
    # Ball 2: fast, angled up-right, starts just below ball 1
    # close Y separation → guaranteed early merge event
    p2 = np.array([75.0,  HEIGHT * 0.28 + BASE_BALL_RADIUS*2.05])
    v2 = np.array([20.5, -14.5])   # steeper upward angle — crosses slats

    omega1 = 2.5    # pre-seeded spin so stripe is already rotating frame 1
    omega2 = -3.1
    angle1 = 0.0
    angle2 = 0.0

    trail1, trail2 = [], []
    collisions  = 0
    frames_saved = 0
    frames_dropped = 0

    # Track which frames are intentional drops for the log
    drop_log = []

    with tqdm(range(TOTAL_FRAMES), desc="Rendering", unit="frame") as pbar:
        for i in pbar:

            # ── Oscillating radii (independent phase per ball) ─────────────────
            r1 = BASE_BALL_RADIUS + RADIUS_OSCILLATION * math.sin(
                2*math.pi * i / RADIUS_PERIOD)
            r2 = BASE_BALL_RADIUS + RADIUS_OSCILLATION * math.sin(
                2*math.pi * i / RADIUS_PERIOD + math.pi * 0.7)  # offset phase

            # ── Frame-drop logic ───────────────────────────────────────────────
            window_pos = i % FRAME_DROP_EVERY
            is_dropped = (1 <= window_pos <= FRAME_DROP_COUNT)

            if not is_dropped:
                # ── Background flicker ─────────────────────────────────────────
                bg_idx = (i // BG_FLICKER_EVERY) % len(bg_pool)
                arr    = bg_pool[bg_idx].copy()

                # Pegs (behind balls, in front of background)
                for (px, py) in pegs:
                    arr = _draw_peg(arr, px, py, PEG_RADIUS)

                # Motion blur ghosts (drawn before solid balls)
                if trail1:
                    arr = _draw_motion_blur(arr, trail1[-MOTION_BLUR_N:], int(r1), COL1)
                if trail2:
                    arr = _draw_motion_blur(arr, trail2[-MOTION_BLUR_N:], int(r2), COL2)

                # Balls
                arr = _draw_ball(arr, int(p1[0]), int(p1[1]), int(r1), COL1, angle1)
                arr = _draw_ball(arr, int(p2[0]), int(p2[1]), int(r2), COL2, angle2)

                # Occluder slats drawn ON TOP — forces real occlusion
                arr = _draw_slats(arr)

                Image.fromarray(arr).save(
                    frames_dir / f"{i+1:06d}.jpg", quality=95)
                frames_saved += 1
            else:
                drop_log.append(i + 1)
                frames_dropped += 1
                pbar.set_postfix_str(f"DROP frame {i+1}")

            # ── Physics step (always runs, even on dropped frames) ─────────────

            v1[1] += GRAVITY
            v2[1] += GRAVITY

            # Ball–ball CCD (use oscillating radii)
            t_bb = _ccd(p1, p2, v1, v2, r1, r2)
            if t_bb is not None:
                p1 += v1*t_bb
                p2 += v2*t_bb
                v1, v2 = _resolve_ball_ball(v1, v2, p1, p2)
                n  = (p2 - p1)/(np.linalg.norm(p2 - p1) + 1e-8)
                t  = np.array([-n[1], n[0]])
                omega1 += SPIN_TRANSFER*np.dot(v1, t)/BASE_BALL_RADIUS
                omega2 += SPIN_TRANSFER*np.dot(v2, t)/BASE_BALL_RADIUS
                p1 += v1*(1 - t_bb)
                p2 += v2*(1 - t_bb)
                _separate(p1, p2, r1, r2)
                collisions += 1
                pbar.set_postfix_str(f"collisions={collisions} [ball-ball @ {i+1}]")
            else:
                p1 += v1
                p2 += v2

            # Ball–peg collisions
            for (px, py) in pegs:
                pp = np.array([px, py])
                for ball_pos, ball_v, ball_omega_ref, ball_r_cur, ball_idx in [
                    (p1, v1, [omega1], r1, 1),
                    (p2, v2, [omega2], r2, 2)
                ]:
                    t_bp = _ccd(ball_pos, pp, ball_v, np.zeros(2),
                                ball_r_cur, PEG_RADIUS)
                    if t_bp is not None:
                        ball_pos += ball_v*t_bp
                        new_v, new_omega = _resolve_ball_peg(
                            ball_v, ball_pos, pp, ball_omega_ref[0])
                        ball_v[:]         = new_v
                        ball_omega_ref[0] = new_omega
                        ball_pos += ball_v*(1 - t_bp)
                        _separate_peg(ball_pos, pp, ball_r_cur, PEG_RADIUS)
                        collisions += 1
                        pbar.set_postfix_str(
                            f"collisions={collisions} [ball{ball_idx}-peg @ {i+1}]")
                    else:
                        d    = ball_pos - pp
                        dist = np.linalg.norm(d)
                        if dist < ball_r_cur + PEG_RADIUS:
                            new_v, new_omega = _resolve_ball_peg(
                                ball_v, ball_pos, pp, ball_omega_ref[0])
                            ball_v[:]         = new_v
                            ball_omega_ref[0] = new_omega
                            _separate_peg(ball_pos, pp, ball_r_cur, PEG_RADIUS)

            # NOTE: No slat bounce — slats are VISUAL occluders only.
            # Balls pass through them freely; SAM2 must re-identify after occlusion.

            # Drag + spin decay
            v1     *= AIR_DRAG
            v2     *= AIR_DRAG
            omega1 *= ANGULAR_DRAG
            omega2 *= ANGULAR_DRAG

            # Wall bounce
            _wall_bounce(p1, v1, r1, WIDTH, HEIGHT)
            _wall_bounce(p2, v2, r2, WIDTH, HEIGHT)

            # Accumulate rotation
            angle1 += omega1
            angle2 += omega2

            trail1.append(tuple(p1.copy()))
            trail2.append(tuple(p2.copy()))

    print(f"\n{'='*60}")
    print(f"  DONE — {frames_saved} frames saved, {frames_dropped} dropped")
    print(f"  Total collisions : {collisions}")
    print(f"  Dropped frame #s : {drop_log[:20]}{'...' if len(drop_log)>20 else ''}")
    print(f"  Load '{EXP_NAME}' in the Debug Lab.")
    print(f"{'='*60}")

    # Write a sidecar JSON with drop frame indices so evaluation scripts
    # can filter them out or specifically target them
    import json
    meta = {
        "exp_name"      : EXP_NAME,
        "total_frames"  : TOTAL_FRAMES,
        "frames_saved"  : frames_saved,
        "frames_dropped": frames_dropped,
        "dropped_indices": drop_log,
        "slat_y"        : SLAT_POSITIONS_Y,
        "slat_height"   : SLAT_HEIGHT,
        "collisions"    : collisions,
        "config": {
            "restitution"       : RESTITUTION,
            "wall_restitution"  : WALL_RESTITUTION,
            "gravity"           : GRAVITY,
            "spin_transfer"     : SPIN_TRANSFER,
            "radius_osc_px"     : RADIUS_OSCILLATION,
            "radius_period_fr"  : RADIUS_PERIOD,
            "motion_blur_n"     : MOTION_BLUR_N,
            "num_pegs"          : NUM_PEGS,
            "bg_flicker_every"  : BG_FLICKER_EVERY,
        }
    }
    meta_path = base_dir / "insane_meta.json"
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
    print(f"  Metadata → {meta_path}")


if __name__ == "__main__":
    generate()