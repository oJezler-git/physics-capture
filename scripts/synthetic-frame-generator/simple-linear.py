import shutil
from pathlib import Path
from PIL import Image, ImageDraw
import numpy as np

try:
    from tqdm import tqdm
except ImportError:
    class tqdm:  # minimal fallback progress bar
        def __init__(self, iterable=None, total=None, desc="", unit="", **kwargs):
            self._it      = iter(iterable) if iterable is not None else None
            self._total   = total or (len(iterable) if iterable is not None else "?")
            self._desc    = desc
            self._n       = 0
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
EXP_NAME        = "synthetic-simple-linear-collision"
WIDTH, HEIGHT   = 1280, 720
TOTAL_FRAMES    = 120
FPS             = 60
BALL_RADIUS     = 30
RESTITUTION     = 0.88      # energy kept on collision/wall bounce
AIR_DRAG        = 0.998     # velocity multiplier per frame
MOTION_BLUR_N   = 3         # ghost positions for motion blur


# ── Rendering helpers (numpy – no PIL blur, no RGBA compositing artifacts) ────

def _felt_background(width, height):
    """Render a snooker-felt surface once; stamp every frame."""
    arr = np.zeros((height, width, 3), dtype=np.float32)
    arr[:, :] = [18, 58, 30]

    # Subtle fabric grain
    rng = np.random.default_rng(42)
    grain = rng.normal(0, 4, (height, width, 3)).astype(np.float32)
    arr = np.clip(arr + grain, 0, 255)

    # Soft vignette
    ys, xs = np.ogrid[0:height, 0:width]
    cx, cy = width / 2, height / 2
    vign = np.sqrt(((xs - cx) / cx) ** 2 + ((ys - cy) / cy) ** 2)
    vign = np.clip(vign, 0, 1) ** 1.6 * 35
    arr = np.clip(arr - vign[:, :, None], 0, 255)

    return arr.astype(np.uint8)


def _draw_ball(arr, cx, cy, radius, base_rgb):
    """Paint a ball with radial gradient + specular highlights + soft shadow."""
    H, W = arr.shape[:2]
    ys, xs = np.ogrid[0:H, 0:W]
    dx = xs - cx
    dy = ys - cy
    dist2 = dx * dx + dy * dy
    r2    = radius * radius
    mask  = dist2 <= r2
    dist  = np.sqrt(dist2.astype(np.float32))

    # ── Ground shadow (soft ellipse, no compositing tricks) ──────────────────
    shadow_cx, shadow_cy = cx, cy + radius + 7
    sw, sh = radius * 1.05, radius * 0.26
    sdx = xs - shadow_cx
    sdy = (ys - shadow_cy) / (sh / sw + 1e-6)
    s_dist = np.sqrt(sdx * sdx + sdy * sdy)
    s_alpha = np.clip(1 - s_dist / sw, 0, 1) ** 1.5 * 0.55
    for c in range(3):
        arr[:, :, c] = np.where(
            s_alpha > 0,
            (arr[:, :, c] * (1 - s_alpha)).astype(np.uint8),
            arr[:, :, c]
        )

    # ── Ball body (radial gradient, base -> dark edge) ─────────────────────────
    norm = np.where(mask, dist / radius, 1.0)
    dark_factor = 0.50
    grad = 1.0 - norm * (1.0 - dark_factor)

    r0, g0, b0 = base_rgb[0] / 255.0, base_rgb[1] / 255.0, base_rgb[2] / 255.0

    # ── Large soft specular lobe (top-left) ───────────────────────────────────
    spec_cx = cx - radius * 0.30
    spec_cy = cy - radius * 0.36
    spec_r  = radius * 0.50
    s_dist2 = (xs - spec_cx) ** 2 + (ys - spec_cy) ** 2
    spec_lobe = np.clip(1 - np.sqrt(s_dist2) / spec_r, 0, 1) ** 2.0 * 0.80

    # ── Sharp hotspot (small, bright) ─────────────────────────────────────────
    hot_cx = cx - radius * 0.26
    hot_cy = cy - radius * 0.31
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

    # ── Thin rim outline (anti-alias approximation) ───────────────────────────
    rim_inner = (radius - 1.2) ** 2
    rim_outer = (radius + 0.5) ** 2
    rim_mask  = (dist2 >= rim_inner) & (dist2 <= rim_outer)
    rim_alpha = np.where(rim_mask, 0.35, 0.0)
    for c in range(3):
        arr[:, :, c] = np.where(
            rim_mask,
            np.clip(arr[:, :, c] * (1 - rim_alpha) + 255 * rim_alpha, 0, 255),
            arr[:, :, c]
        ).astype(np.uint8)

    return arr


def _draw_motion_blur(arr, trail, radius, base_rgb):
    """Blend ghost frames behind the ball for motion blur."""
    n = len(trail)
    for k, (px, py) in enumerate(reversed(trail)):
        alpha = 0.22 * (k + 1) / n
        H, W = arr.shape[:2]
        ys, xs = np.ogrid[0:H, 0:W]
        mask = ((xs - px) ** 2 + (ys - py) ** 2) <= radius ** 2
        r0, g0, b0 = base_rgb
        for c, base in enumerate([r0, g0, b0]):
            arr[:, :, c] = np.where(
                mask,
                np.clip(arr[:, :, c] * (1 - alpha) + base * alpha, 0, 255),
                arr[:, :, c]
            ).astype(np.uint8)
    return arr


# ── Physics ────────────────────────────────────────────────────────────────────

def _ccd(p1, p2, v1, v2, r):
    """Continuous collision detection: fraction t in [0,1] of first contact."""
    dp = p2 - p1
    dv = v2 - v1
    a  = np.dot(dv, dv)
    b  = 2 * np.dot(dp, dv)
    c  = np.dot(dp, dp) - (2 * r) ** 2
    if a < 1e-10:
        return None
    disc = b * b - 4 * a * c
    if disc < 0:
        return None
    t = (-b - np.sqrt(disc)) / (2 * a)
    return float(t) if 0.0 <= t <= 1.0 else None


def _resolve(v1, v2, p1, p2, e=RESTITUTION):
    """Elastic collision with restitution along the contact normal."""
    n    = p2 - p1
    dist = np.linalg.norm(n)
    if dist < 1e-8:
        return v1, v2
    n   /= dist
    dot  = np.dot(v1 - v2, n)
    if dot <= 0:
        return v1, v2
    imp = (1 + e) * dot / 2       # equal masses
    return v1 - imp * n, v2 + imp * n


def _wall_bounce(p, v, r, w, h, e=RESTITUTION):
    if p[0] - r < 0:       p[0] = r;     v[0] =  abs(v[0]) * e
    if p[0] + r > w:       p[0] = w - r; v[0] = -abs(v[0]) * e
    if p[1] - r < 0:       p[1] = r;     v[1] =  abs(v[1]) * e
    if p[1] + r > h:       p[1] = h - r; v[1] = -abs(v[1]) * e


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

    p1 = np.array([100.0, HEIGHT / 2])
    p2 = np.array([WIDTH / 2, HEIGHT / 2])
    v1 = np.array([8.0, 0.0])
    v2 = np.array([0.0, 0.0])

    col1 = (76, 195, 255)    # blue
    col2 = (154, 212, 111)   # green

    trail1, trail2 = [], []

    collisions = 0

    with tqdm(range(TOTAL_FRAMES), desc="Rendering", unit="frame") as pbar:
        for i in pbar:
            arr = felt.copy()

            # Motion blur ghosts (drawn before balls so they sit behind)
            if trail1:
                arr = _draw_motion_blur(arr, trail1[-MOTION_BLUR_N:], BALL_RADIUS, col1)
            if trail2:
                arr = _draw_motion_blur(arr, trail2[-MOTION_BLUR_N:], BALL_RADIUS, col2)

            arr = _draw_ball(arr, p1[0], p1[1], BALL_RADIUS, col1)
            arr = _draw_ball(arr, p2[0], p2[1], BALL_RADIUS, col2)

            Image.fromarray(arr).save(frames_dir / f"{i+1:06d}.jpg", quality=95)

            # ── Physics step ──────────────────────────────────────────────────
            t = _ccd(p1, p2, v1, v2, BALL_RADIUS)
            if t is not None:
                p1 += v1 * t
                p2 += v2 * t
                v1, v2 = _resolve(v1, v2, p1, p2)
                p1 += v1 * (1 - t)
                p2 += v2 * (1 - t)
                collisions += 1
                pbar.set_postfix_str(f"collisions={collisions} [CCD @ frame {i+1}, t={t:.3f}]")
            else:
                p1 += v1
                p2 += v2

            v1 *= AIR_DRAG
            v2 *= AIR_DRAG
            _wall_bounce(p1, v1, BALL_RADIUS, WIDTH, HEIGHT)
            _wall_bounce(p2, v2, BALL_RADIUS, WIDTH, HEIGHT)

            trail1.append(tuple(p1.copy()))
            trail2.append(tuple(p2.copy()))

    print("\nDone - load", EXP_NAME, "in the Debug Lab.")


if __name__ == "__main__":
    generate()