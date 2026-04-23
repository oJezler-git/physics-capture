import shutil
from pathlib import Path
from PIL import Image
import numpy as np

try:
    from tqdm import tqdm
except ImportError:
    class tqdm:  # minimal fallback progress bar
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

# ── Configuration ─────────────────────────────────────────────────────────────
EXP_NAME        = "synthetic-chaotic-collision"
WIDTH, HEIGHT   = 1280, 720
TOTAL_FRAMES    = 240
FPS             = 60
BALL_RADIUS     = 22
PEG_RADIUS      = 12          # static obstacle radius
NUM_PEGS        = 10
RESTITUTION     = 0.82        # ball-ball / ball-peg energy kept
WALL_RESTITUTION= 0.75        # wall bounce (slightly lossier)
AIR_DRAG        = 0.9995      # per-frame velocity multiplier
GRAVITY         = 0.18        # pixels/frame^2 downward
SPIN_TRANSFER   = 0.12        # fraction of tangential velocity → angular
MOTION_BLUR_N   = 4
ANGULAR_DRAG    = 0.97        # spin decay per frame


# ── Reproducible RNG for peg layout ───────────────────────────────────────────
_rng = np.random.default_rng(7)


def _place_pegs(n, w, h, r, ball_r, margin=90):
    """Scatter static pegs, avoiding spawn zones and each other."""
    forbidden_left  = 180   # keep left lane clear for ball entry
    forbidden_right = w - 180
    pegs = []
    attempts = 0
    while len(pegs) < n and attempts < 10_000:
        attempts += 1
        x = _rng.uniform(forbidden_left, forbidden_right)
        y = _rng.uniform(margin, h - margin)
        # avoid clustering
        too_close = any(np.hypot(x - px, y - py) < (r + ball_r) * 2.6
                        for px, py in pegs)
        if not too_close:
            pegs.append((x, y))
    return pegs


# ── Rendering helpers ──────────────────────────────────────────────────────────

def _felt_background(width, height):
    arr = np.zeros((height, width, 3), dtype=np.float32)
    arr[:, :] = [18, 58, 30]
    rng2 = np.random.default_rng(42)
    grain = rng2.normal(0, 4, (height, width, 3)).astype(np.float32)
    arr = np.clip(arr + grain, 0, 255)
    ys, xs = np.ogrid[0:height, 0:width]
    cx, cy = width / 2, height / 2
    vign = np.sqrt(((xs - cx) / cx) ** 2 + ((ys - cy) / cy) ** 2)
    vign = np.clip(vign, 0, 1) ** 1.6 * 40
    arr = np.clip(arr - vign[:, :, None], 0, 255)
    return arr.astype(np.uint8)


def _draw_ball(arr, cx, cy, radius, base_rgb, angle=0.0):
    """Ball with radial gradient, specular highlights, soft shadow, and a
    spin indicator stripe so rotation is visually obvious."""
    H, W = arr.shape[:2]
    ys, xs = np.ogrid[0:H, 0:W]
    dx = xs - cx;  dy = ys - cy
    dist2 = dx * dx + dy * dy
    r2    = radius * radius
    mask  = dist2 <= r2
    dist  = np.sqrt(dist2.astype(np.float32))

    # Shadow
    shadow_cx, shadow_cy = cx, cy + radius + 6
    sw, sh = radius * 1.05, radius * 0.26
    sdx = xs - shadow_cx
    sdy = (ys - shadow_cy) / (sh / sw + 1e-6)
    s_dist  = np.sqrt(sdx * sdx + sdy * sdy)
    s_alpha = np.clip(1 - s_dist / sw, 0, 1) ** 1.5 * 0.55
    for c in range(3):
        arr[:, :, c] = np.where(
            s_alpha > 0,
            (arr[:, :, c] * (1 - s_alpha)).astype(np.uint8),
            arr[:, :, c]
        )

    # Body gradient
    norm        = np.where(mask, dist / radius, 1.0)
    grad        = 1.0 - norm * 0.50
    r0 = base_rgb[0] / 255.0
    g0 = base_rgb[1] / 255.0
    b0 = base_rgb[2] / 255.0

    # Specular
    spec_cx = cx - radius * 0.30;  spec_cy = cy - radius * 0.36
    spec_r  = radius * 0.50
    s_dist2 = (xs - spec_cx) ** 2 + (ys - spec_cy) ** 2
    spec_lobe = np.clip(1 - np.sqrt(s_dist2) / spec_r, 0, 1) ** 2.0 * 0.80
    hot_cx = cx - radius * 0.26;   hot_cy = cy - radius * 0.31
    hot_r  = radius * 0.17
    h_dist2 = (xs - hot_cx) ** 2 + (ys - hot_cy) ** 2
    hotspot  = np.clip(1 - np.sqrt(h_dist2) / hot_r, 0, 1) ** 3.0 * 0.65
    combined_spec = np.clip(spec_lobe + hotspot, 0, 1)

    ball_r = np.clip((r0 * grad + combined_spec) * 255, 0, 255)
    ball_g = np.clip((g0 * grad + combined_spec) * 255, 0, 255)
    ball_b = np.clip((b0 * grad + combined_spec) * 255, 0, 255)

    arr[:, :, 0] = np.where(mask, ball_r, arr[:, :, 0]).astype(np.uint8)
    arr[:, :, 1] = np.where(mask, ball_g, arr[:, :, 1]).astype(np.uint8)
    arr[:, :, 2] = np.where(mask, ball_b, arr[:, :, 2]).astype(np.uint8)

    # Spin stripe — a diameter line rotated by `angle`
    stripe_dx = np.cos(angle)
    stripe_dy = np.sin(angle)
    # project each ball-pixel onto the stripe axis
    proj = dx * stripe_dy - dy * stripe_dx   # signed distance from stripe axis
    stripe_mask = mask & (np.abs(proj) < radius * 0.18)
    stripe_alpha = 0.50
    for c in range(3):
        arr[:, :, c] = np.where(
            stripe_mask,
            np.clip(arr[:, :, c] * (1 - stripe_alpha), 0, 255),
            arr[:, :, c]
        ).astype(np.uint8)

    # Rim
    rim_inner = (radius - 1.2) ** 2
    rim_outer = (radius + 0.5) ** 2
    rim_mask  = (dist2 >= rim_inner) & (dist2 <= rim_outer)
    rim_alpha = 0.35
    for c in range(3):
        arr[:, :, c] = np.where(
            rim_mask,
            np.clip(arr[:, :, c] * (1 - rim_alpha) + 255 * rim_alpha, 0, 255),
            arr[:, :, c]
        ).astype(np.uint8)

    return arr


def _draw_peg(arr, cx, cy, radius):
    """Static ivory-coloured obstacle peg."""
    H, W = arr.shape[:2]
    ys, xs = np.ogrid[0:H, 0:W]
    dx = xs - cx;  dy = ys - cy
    dist2 = dx * dx + dy * dy
    r2    = radius * radius
    mask  = dist2 <= r2
    dist  = np.sqrt(dist2.astype(np.float32))

    norm  = np.where(mask, dist / radius, 1.0)
    grad  = 1.0 - norm * 0.45
    ivory = np.array([220, 205, 170], dtype=np.float32) / 255.0

    spec_cx = cx - radius * 0.28;  spec_cy = cy - radius * 0.32
    spec_r  = radius * 0.40
    s_dist2 = (xs - spec_cx) ** 2 + (ys - spec_cy) ** 2
    spec    = np.clip(1 - np.sqrt(s_dist2) / spec_r, 0, 1) ** 2.5 * 0.70

    for c in range(3):
        val = np.clip((ivory[c] * grad + spec) * 255, 0, 255)
        arr[:, :, c] = np.where(mask, val, arr[:, :, c]).astype(np.uint8)

    rim_inner = (radius - 1.0) ** 2
    rim_outer = (radius + 0.5) ** 2
    rim_mask  = (dist2 >= rim_inner) & (dist2 <= rim_outer)
    for c in range(3):
        arr[:, :, c] = np.where(
            rim_mask,
            np.clip(arr[:, :, c] * 0.65 + 255 * 0.35, 0, 255),
            arr[:, :, c]
        ).astype(np.uint8)

    return arr


def _draw_motion_blur(arr, trail, radius, base_rgb):
    n = len(trail)
    H, W = arr.shape[:2]
    ys, xs = np.ogrid[0:H, 0:W]
    for k, (px, py) in enumerate(reversed(trail)):
        alpha = 0.20 * (k + 1) / n
        mask  = ((xs - px) ** 2 + (ys - py) ** 2) <= radius ** 2
        for c, base in enumerate(base_rgb):
            arr[:, :, c] = np.where(
                mask,
                np.clip(arr[:, :, c] * (1 - alpha) + base * alpha, 0, 255),
                arr[:, :, c]
            ).astype(np.uint8)
    return arr


# ── Physics ────────────────────────────────────────────────────────────────────

def _ccd(p1, p2, v1, v2, r1, r2):
    """CCD between two circles of (possibly different) radii."""
    dp = p2 - p1
    dv = v2 - v1
    a  = np.dot(dv, dv)
    b  = 2 * np.dot(dp, dv)
    c  = np.dot(dp, dp) - (r1 + r2) ** 2
    if a < 1e-10:
        return None
    disc = b * b - 4 * a * c
    if disc < 0:
        return None
    t = (-b - np.sqrt(disc)) / (2 * a)
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
    imp = (1 + e) * dot / 2
    return v1 - imp * n, v2 + imp * n


def _resolve_ball_peg(v, ball_pos, peg_pos, omega, e=RESTITUTION):
    """Reflect ball velocity off a static peg; transfer tangential component
    to spin."""
    n    = ball_pos - peg_pos
    dist = np.linalg.norm(n)
    if dist < 1e-8:
        return v, omega
    n   /= dist
    dot  = np.dot(v, n)
    if dot >= 0:          # already separating
        return v, omega
    # tangential component (for spin)
    t    = np.array([-n[1], n[0]])
    v_t  = np.dot(v, t)
    # reflect normal component
    v_new = v - (1 + e) * dot * n
    # spin from tangential impact
    omega_new = omega + SPIN_TRANSFER * v_t / BALL_RADIUS
    return v_new, omega_new


def _wall_bounce(p, v, r, w, h, e=WALL_RESTITUTION):
    if p[0] - r < 0:       p[0] = r;     v[0] =  abs(v[0]) * e
    if p[0] + r > w:       p[0] = w - r; v[0] = -abs(v[0]) * e
    if p[1] - r < 0:       p[1] = r;     v[1] =  abs(v[1]) * e
    if p[1] + r > h:       p[1] = h - r; v[1] = -abs(v[1]) * e


def _separate(p1, p2, r1, r2):
    """Push apart overlapping circles so they don't tunnel."""
    d  = p2 - p1
    dist = np.linalg.norm(d)
    overlap = (r1 + r2) - dist
    if overlap > 0 and dist > 1e-8:
        push = d / dist * (overlap / 2 + 0.5)
        p1 -= push
        p2 += push


def _separate_peg(ball_pos, peg_pos, ball_r, peg_r):
    d    = ball_pos - peg_pos
    dist = np.linalg.norm(d)
    overlap = (ball_r + peg_r) - dist
    if overlap > 0 and dist > 1e-8:
        ball_pos += d / dist * (overlap + 0.5)


# ── Main ───────────────────────────────────────────────────────────────────────

def generate():
    # Resolve project root (3 levels up from scripts/synthetic-frame-generator/)
    project_root = Path(__file__).resolve().parent.parent.parent
    base_dir     = project_root / "packages" / "experiments" / EXP_NAME
    frames_dir   = base_dir / "frames" / "cam0"
    if base_dir.exists():
        shutil.rmtree(base_dir)
    frames_dir.mkdir(parents=True)

    print(f"Generating {TOTAL_FRAMES} frames -> {frames_dir}")

    felt = _felt_background(WIDTH, HEIGHT)
    pegs = _place_pegs(NUM_PEGS, WIDTH, HEIGHT, PEG_RADIUS, BALL_RADIUS)

    # ── High-energy angled launch ──────────────────────────────────────────────
    # Ball 1: fast, angled downward-right
    p1 = np.array([80.0,  HEIGHT * 0.30])
    v1 = np.array([13.5,  5.0])
    # Ball 2: fast, angled upward-right from bottom
    p2 = np.array([90.0,  HEIGHT * 0.75])
    v2 = np.array([12.0, -6.5])

    omega1 = 0.0   # angular velocity (rad/frame)
    omega2 = 0.0
    angle1 = 0.0   # cumulative rotation for stripe
    angle2 = 0.0

    col1 = (76,  195, 255)   # blue
    col2 = (220, 100,  80)   # red-orange (easier to distinguish from green pegs)

    trail1, trail2 = [], []
    collisions = 0

    with tqdm(range(TOTAL_FRAMES), desc="Rendering", unit="frame") as pbar:
        for i in pbar:
            arr = felt.copy()

            # Draw pegs first (background layer)
            for (px, py) in pegs:
                arr = _draw_peg(arr, px, py, PEG_RADIUS)

            # Motion blur ghosts
            if trail1:
                arr = _draw_motion_blur(arr, trail1[-MOTION_BLUR_N:], BALL_RADIUS, col1)
            if trail2:
                arr = _draw_motion_blur(arr, trail2[-MOTION_BLUR_N:], BALL_RADIUS, col2)

            arr = _draw_ball(arr, int(p1[0]), int(p1[1]), BALL_RADIUS, col1, angle1)
            arr = _draw_ball(arr, int(p2[0]), int(p2[1]), BALL_RADIUS, col2, angle2)

            Image.fromarray(arr).save(frames_dir / f"{i+1:06d}.jpg", quality=95)

            # ── Physics step ──────────────────────────────────────────────────

            # Gravity
            v1[1] += GRAVITY
            v2[1] += GRAVITY

            # Ball–ball CCD
            t_bb = _ccd(p1, p2, v1, v2, BALL_RADIUS, BALL_RADIUS)
            if t_bb is not None:
                p1 += v1 * t_bb
                p2 += v2 * t_bb
                v1, v2 = _resolve_ball_ball(v1, v2, p1, p2)
                # spin from tangential impact
                n   = (p2 - p1) / (np.linalg.norm(p2 - p1) + 1e-8)
                t   = np.array([-n[1], n[0]])
                omega1 += SPIN_TRANSFER * np.dot(v1, t) / BALL_RADIUS
                omega2 += SPIN_TRANSFER * np.dot(v2, t) / BALL_RADIUS
                p1 += v1 * (1 - t_bb)
                p2 += v2 * (1 - t_bb)
                _separate(p1, p2, BALL_RADIUS, BALL_RADIUS)
                collisions += 1
                pbar.set_postfix_str(f"collisions={collisions} [ball-ball @ frame {i+1}]")
            else:
                p1 += v1
                p2 += v2

            # Ball–peg collisions
            for (px, py) in pegs:
                pp = np.array([px, py])
                for ball_pos, ball_v, ball_omega_ref, ball_idx in [
                    (p1, v1, [omega1], 1), (p2, v2, [omega2], 2)
                ]:
                    t_bp = _ccd(ball_pos, pp,
                                ball_v,  np.zeros(2),
                                BALL_RADIUS, PEG_RADIUS)
                    if t_bp is not None:
                        ball_pos += ball_v * t_bp
                        new_v, new_omega = _resolve_ball_peg(
                            ball_v, ball_pos, pp, ball_omega_ref[0]
                        )
                        ball_v[:]          = new_v
                        ball_omega_ref[0]  = new_omega
                        ball_pos += ball_v * (1 - t_bp)
                        _separate_peg(ball_pos, pp, BALL_RADIUS, PEG_RADIUS)
                        collisions += 1
                        pbar.set_postfix_str(f"collisions={collisions} [ball{ball_idx}-peg @ frame {i+1}]")
                    else:
                        # soft overlap correction (missed by CCD at high speed)
                        d = ball_pos - pp
                        dist = np.linalg.norm(d)
                        if dist < BALL_RADIUS + PEG_RADIUS:
                            new_v, new_omega = _resolve_ball_peg(
                                ball_v, ball_pos, pp, ball_omega_ref[0]
                            )
                            ball_v[:]         = new_v
                            ball_omega_ref[0] = new_omega
                            _separate_peg(ball_pos, pp, BALL_RADIUS, PEG_RADIUS)

            # write back mutable omegas
            # (already updated in-place via the list trick above)

            # drag + spin decay
            v1 *= AIR_DRAG
            v2 *= AIR_DRAG
            omega1 *= ANGULAR_DRAG
            omega2 *= ANGULAR_DRAG

            # wall bounce
            _wall_bounce(p1, v1, BALL_RADIUS, WIDTH, HEIGHT)
            _wall_bounce(p2, v2, BALL_RADIUS, WIDTH, HEIGHT)

            # accumulate rotation angle for stripe rendering
            angle1 += omega1
            angle2 += omega2

            trail1.append(tuple(p1.copy()))
            trail2.append(tuple(p2.copy()))

    print(f"\nDone - {collisions} total collisions. Load {EXP_NAME} in the Debug Lab.")


if __name__ == "__main__":
    generate()