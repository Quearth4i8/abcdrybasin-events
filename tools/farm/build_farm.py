"""
Procedural farm for Blender (4.2+ / 5.x) -> realistic glTF scene for Three.js.

What it builds
  * Tileable PBR textures generated from code (color, roughness/metal, normal):
    painted barn planks, lap siding, asphalt shingles, rusty corrugated roofing,
    galvanised silo panels, field stone, brick, bark, straw, grass, dirt, plowed soil,
    leaf clusters, corn leaves ... (no image files needed, everything is generated).
  * Blender materials wired from those textures (exportable to glTF as-is).
  * Terrain with rolling hills, a pond and painted masks for paths / fields.
  * Barn (gambrel roof, sliding doors, hayloft, cupola), silo, farmhouse with porch,
    windmill, paddock fence, hay bales, barrels, crates, trough, corn field,
    trees, bushes, reeds and rocks.
  * Sun + sky, camera, optional Cycles preview render, and a .glb export.

Run headless (recommended):
    blender -b -P tools/farm/build_farm.py -- --out public/farm --render tools/farm/out/preview.png
or with the `bpy` pip module:
    python tools/farm/build_farm.py --out public/farm
or open Blender > Scripting tab > open this file > Run Script (it rebuilds the current scene).

Options (after `--` when run through blender):
    --out DIR        where farm.glb is written (default: <repo>/public/farm)
    --tex N          main texture resolution (default 1024)
    --render PATH    also render a Cycles preview to PATH
    --samples N      Cycles samples for the preview (default 64)
    --blend PATH     also save the .blend file
    --no-export      skip the glTF export
    --seed N         random seed for the layout (default 7)
"""

import math
import os
import random
import shutil
import subprocess
import sys
import time

import bpy  # noqa: I001 - must come first: it makes bmesh/mathutils importable
import bmesh
import numpy as np
from mathutils import Matrix, Vector
from mathutils import noise as mnoise

# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() and __file__ else os.getcwd()
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))


def parse_args():
    argv = sys.argv
    if "--" in argv:  # blender -b -P build_farm.py -- <options>
        argv = argv[argv.index("--") + 1:]
    elif argv and argv[0].endswith(".py"):  # python build_farm.py <options> (bpy module)
        argv = argv[1:]
    else:  # Blender UI "Run Script": defaults
        argv = []
    opts = {"out": os.path.join(REPO, "public", "farm"), "tex": 1024, "render": None, "samples": 64,
            "blend": None, "export": True, "seed": 7}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--out":
            opts["out"] = os.path.abspath(argv[i + 1]); i += 1
        elif a == "--tex":
            opts["tex"] = int(argv[i + 1]); i += 1
        elif a == "--render":
            opts["render"] = os.path.abspath(argv[i + 1]); i += 1
        elif a == "--samples":
            opts["samples"] = int(argv[i + 1]); i += 1
        elif a == "--blend":
            opts["blend"] = os.path.abspath(argv[i + 1]); i += 1
        elif a == "--no-export":
            opts["export"] = False
        elif a == "--seed":
            opts["seed"] = int(argv[i + 1]); i += 1
        i += 1
    return opts


OPT = parse_args()
TEX_N = OPT["tex"]
TEX_DIR = os.path.join(HERE, "out", "textures")
random.seed(OPT["seed"])

T0 = time.time()


def log(msg):
    print(f"[farm {time.time() - T0:6.1f}s] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Small math helpers
# ---------------------------------------------------------------------------

def smoothstep(e0, e1, x):
    t = min(max((x - e0) / (e1 - e0), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def sstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def mix(a, b, t):
    a = np.asarray(a, np.float32)
    b = np.asarray(b, np.float32)
    t = np.asarray(t, np.float32)[..., None]
    return a * (1 - t) + b * t


def V(*a):
    return Vector(a[0] if len(a) == 1 else a)


# ---------------------------------------------------------------------------
# Texture generation (numpy, all tileable)
# ---------------------------------------------------------------------------

def fnoise(n, beta=2.0, seed=0, ax=1.0, ay=1.0, angle=0.0, fmin=1.0, fmax=None):
    """Periodic fractal noise via FFT, normalised to mean 0 / std 1.
    ax/ay > 1 squash frequencies on that axis, i.e. stretch features along it."""
    rng = np.random.default_rng(seed)
    f = np.fft.fftfreq(n) * n
    fx = f[None, :]
    fy = f[:, None]
    if angle:
        c, s = math.cos(angle), math.sin(angle)
        fx, fy = fx * c + fy * s, -fx * s + fy * c
    r = np.sqrt((fx * ax) ** 2 + (fy * ay) ** 2)
    r[0, 0] = 1.0
    amp = r ** (-beta / 2.0)
    amp[np.sqrt(fx ** 2 + fy ** 2) < fmin] = 0.0
    if fmax:
        amp[r > fmax] = 0.0
    amp[0, 0] = 0.0
    img = np.fft.ifft2(amp * np.exp(2j * np.pi * rng.random((n, n)))).real
    return ((img - img.mean()) / (img.std() + 1e-9)).astype(np.float32)


def grid(n):
    u = (np.arange(n, dtype=np.float32) + 0.5) / n
    return np.meshgrid(u, u)  # U varies along columns, V along rows (row 0 = bottom)


def worley(n, count, seed):
    """Periodic Worley noise: returns F1, F2 distances and nearest cell id."""
    rng = np.random.default_rng(seed)
    pts = rng.random((count, 2)).astype(np.float32)
    U, Vv = grid(n)
    f1 = np.full((n, n), 9.0, np.float32)
    f2 = np.full((n, n), 9.0, np.float32)
    idx = np.zeros((n, n), np.int32)
    for k, (px, py) in enumerate(pts):
        dx = np.abs(U - px)
        dx = np.minimum(dx, 1 - dx)
        dy = np.abs(Vv - py)
        dy = np.minimum(dy, 1 - dy)
        d = np.sqrt(dx * dx + dy * dy)
        closer = d < f1
        f2 = np.where(closer, f1, np.minimum(f2, d))
        idx = np.where(closer, k, idx)
        f1 = np.where(closer, d, f1)
    return f1, f2, idx


def height_to_normal(h, strength):
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5 * strength
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5 * strength
    l = np.sqrt(dx * dx + dy * dy + 1.0)
    return np.stack([-dx / l, -dy / l, 1.0 / l], -1) * 0.5 + 0.5


def save_image(name, rgb, alpha=None, data=False):
    h, w = rgb.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=alpha is not None)
    px = np.ones((h, w, 4), np.float32)
    px[..., :3] = np.clip(rgb, 0, 1)
    if alpha is not None:
        px[..., 3] = np.clip(alpha, 0, 1)
    img.pixels.foreach_set(px.ravel())
    os.makedirs(TEX_DIR, exist_ok=True)
    img.filepath_raw = os.path.join(TEX_DIR, name + ".png")
    img.file_format = "PNG"
    img.save()
    if data:
        img.colorspace_settings.name = "Non-Color"
    return img


class Tex:
    """A generated PBR texture set."""

    def __init__(self, key, color, rough, metal, height, strength, alpha=None, normal=None):
        self.key = key
        n = color.shape[0]
        self.color = save_image(f"{key}_color", color, alpha)
        orm = np.stack([np.ones_like(rough), rough, metal * np.ones_like(rough)], -1)
        self.orm = save_image(f"{key}_orm", orm, data=True)
        nrm = normal if normal is not None else height_to_normal(height, strength * n / 1024.0)
        self.normal = save_image(f"{key}_normal", nrm, data=True)
        self.alpha = alpha is not None


def wood_grain(n, seed, stretch=14.0):
    g = fnoise(n, 2.6, seed, ax=1.0, ay=stretch)
    fine = fnoise(n, 1.4, seed + 1, ax=1.0, ay=stretch * 2)
    return g, fine


def tex_barn_wood(n):
    """Vertical red-painted barn planks, weathered with small paint chips. Tile = 3 m, 12 planks."""
    U, Vv = grid(n)
    planks = 12
    pu = U * planks
    pid = np.floor(pu).astype(int)
    fu = pu - pid
    rng = np.random.default_rng(11)
    tone = rng.uniform(-1, 1, planks)[pid]
    g, fine = wood_grain(n, 3)
    groove = sstep(0.0, 0.04, fu) * sstep(0.0, 0.04, 1 - fu)
    weather = fnoise(n, 2.0, 5)
    chips = fnoise(n, 1.5, 7, ax=1, ay=3)
    streaks = fnoise(n, 2.0, 6, ax=1, ay=10)
    # small chips, a bit more frequent near plank edges, never large blotches
    edge_wear = 1 - sstep(0.0, 0.12, np.minimum(fu, 1 - fu))
    peel = sstep(1.55, 1.9, chips * 0.75 + weather * 0.3 + g * 0.25 + edge_wear * 0.6)
    wood = mix([0.47, 0.44, 0.40], [0.33, 0.30, 0.27], sstep(-1.5, 1.5, g + tone * 0.6))
    wood *= (0.9 + 0.1 * fine)[..., None]
    paint = mix([0.55, 0.13, 0.09], [0.43, 0.09, 0.07], sstep(-2, 2, streaks * 0.8 + tone * 0.7))
    paint = mix(paint, [0.60, 0.22, 0.17], sstep(0.0, 2.5, weather) * 0.35)  # sun bleaching
    paint *= (0.95 + 0.03 * fine + 0.03 * g)[..., None]
    col = mix(paint, wood, peel)
    col *= (0.35 + 0.65 * groove)[..., None]
    # two nails per plank per 1.5 m
    nv = (Vv * 2) % 1.0
    px = n / planks
    nails = ((fu - 0.5) * px) ** 2 + ((nv - 0.2) * n / 2) ** 2 < (n / 1024 * 2.2) ** 2
    col[nails] = [0.16, 0.13, 0.12]
    rough = np.where(peel > 0.5, 0.86, 0.62) + 0.06 * fine
    height = groove * 0.6 + (1 - peel) * 0.12 + g * 0.04 + fine * 0.015 + nails * 0.2
    return Tex("barn_wood", col, rough, 0.0, height, 10)


def tex_siding(n):
    """White horizontal lap siding. Tile = 1.6 m, 8 boards."""
    U, Vv = grid(n)
    boards = 8
    pv = Vv * boards
    bid = np.floor(pv).astype(int)
    fv = pv - bid
    g, fine = wood_grain(n, 21, stretch=1.0)
    g = fnoise(n, 2.4, 22, ax=14, ay=1)
    dirt = fnoise(n, 1.7, 23)
    chips = fnoise(n, 1.3, 25, ax=3, ay=1)
    rng = np.random.default_rng(24)
    tone = rng.uniform(-1, 1, boards)[bid]
    col = mix([0.86, 0.85, 0.80], [0.77, 0.75, 0.70], sstep(0.0, 2.5, dirt) * 0.5)
    col *= (0.97 + 0.015 * tone + 0.012 * g)[..., None]
    shadow = sstep(0.0, 0.08, fv)  # dark lip under each board
    col *= (0.45 + 0.55 * shadow)[..., None]
    peel = sstep(2.3, 2.6, chips + 0.3 * g + 0.6 * (fv < 0.12))
    col = mix(col, [0.52, 0.50, 0.46], peel * 0.8)
    rough = 0.55 + 0.1 * sstep(0, 2, dirt) + 0.2 * peel
    height = fv * 0.8 + g * 0.01
    return Tex("siding", col, rough, 0.0, height, 18)


def tex_painted(n, key, color, seed):
    """Painted wood board, grain along V (for trim, doors, shutters, porch posts)."""
    g, fine = wood_grain(n, seed)
    wear = fnoise(n, 2.2, seed + 2)
    c = np.asarray(color, np.float32)
    col = mix(c, c * 0.86, sstep(-1, 2, g * 0.5 + wear * 0.6) * 0.5)
    chips = fnoise(n, 1.4, seed + 3)
    col = mix(col, [0.50, 0.47, 0.42], sstep(2.1, 2.5, chips + 0.3 * wear) * 0.8)
    rough = 0.5 + 0.1 * sstep(-1, 2, wear)
    return Tex(key, col, rough, 0.0, g * 0.03 + fine * 0.01, 6)


def tex_weathered_wood(n, key="old_wood", base=(0.45, 0.41, 0.36), seed=31):
    """Unpainted, sun-greyed wood with grain and cracks. Grain along V. Tile = 1 m."""
    g, fine = wood_grain(n, seed)
    ridged = 1 - np.abs(fnoise(n, 2.0, seed + 1, ax=1, ay=20))
    cracks = sstep(0.93, 0.99, ridged)
    b = np.asarray(base, np.float32)
    col = mix(b * 1.08, b * 0.72, sstep(-1.5, 1.5, g))
    col *= (0.93 + 0.06 * fine)[..., None]
    col *= (1 - 0.6 * cracks)[..., None]
    rough = 0.8 + 0.08 * fine
    height = g * 0.1 + fine * 0.03 - cracks * 0.3
    return Tex(key, col, rough, 0.0, height, 8)


def tex_corrugated(n, key, base, rust_amt, axis="u", waves=16, seed=41, metal=0.75):
    """Corrugated sheet metal with rust streaks. Tile = 1 m."""
    U, Vv = grid(n)
    t = U if axis == "u" else Vv
    wave = 0.5 + 0.5 * np.sin(2 * np.pi * waves * t)
    streak = fnoise(n, 1.7, seed, ax=1, ay=12)
    blot = fnoise(n, 1.9, seed + 1)
    fine = fnoise(n, 1.2, seed + 2)
    rust = sstep(1.3, 2.0, streak * 0.7 + blot * 0.45 + (1 - wave) * 0.35) * rust_amt
    b = np.asarray(base, np.float32)
    col = mix(b, b * 0.88, sstep(-2, 2, blot) * 0.6)
    col *= (0.97 + 0.03 * fine)[..., None]
    rust_col = mix([0.45, 0.22, 0.10], [0.28, 0.14, 0.07], sstep(-1, 1, fine))
    col = mix(col, rust_col, rust)
    if axis == "v":  # vertical panel seams with bolts on the silo
        seam = np.abs(((U * 2) % 1.0) - 0.5) < 0.002
        col[seam] *= 0.7
        bolts = (np.abs(((U * 2) % 1.0) - 0.5) < 0.004) & (np.abs(((Vv * waves) % 1.0) - 0.5) < 0.05)
        col[bolts] = b * 0.6
    rough = 0.38 + 0.15 * sstep(-1, 2, blot) + 0.45 * rust
    metalness = metal * (1 - rust)
    height = wave + rust * 0.05 + fine * 0.01
    return Tex(key, col, rough, metalness, height, 7)


def tex_shingles(n):
    """Asphalt shingles. Tile = 2 m, 8 rows, staggered tabs."""
    U, Vv = grid(n)
    rows = 8
    pv = Vv * rows
    rid = np.floor(pv).astype(int)
    fv = pv - rid
    tabs = 6
    pu = U * tabs + (rid % 2) * 0.5
    tid = np.floor(pu).astype(int) % tabs + rid * tabs
    fu = pu - np.floor(pu)
    rng = np.random.default_rng(51)
    tone = rng.uniform(-1, 1, rows * tabs)[tid]
    gran = fnoise(n, 0.6, 52)
    blot = fnoise(n, 2.4, 53)
    col = mix([0.27, 0.25, 0.24], [0.19, 0.18, 0.18], sstep(-1, 1, tone * 0.8 + blot * 0.3))
    col = mix(col, [0.36, 0.30, 0.24], sstep(1.2, 2.5, blot) * 0.5)  # moss / weathering
    col *= (0.9 + 0.1 * np.clip(gran, -2, 2))[..., None]
    slot = (np.abs(fu - 0.0) < 0.012) | (np.abs(fu - 1.0) < 0.012)
    exposed = fv < 0.55
    edge = sstep(0.0, 0.06, fv)
    col *= (0.4 + 0.6 * edge)[..., None]
    col[slot & exposed] *= 0.35
    rough = 0.9 + 0.05 * gran.clip(-1, 1)
    height = fv * 0.5 + gran * 0.03 - (slot & exposed) * 0.3
    return Tex("shingles", col, rough, 0.0, height, 12)


def tex_stone(n):
    """Field-stone masonry. Tile = 2 m."""
    f1, f2, idx = worley(n, 70, 61)
    edge = (f2 - f1) * n
    stone = sstep(2.0, 7.0, edge)
    rng = np.random.default_rng(62)
    tone = rng.uniform(0, 1, 70)[idx]
    hue = rng.uniform(0, 1, 70)[idx]
    fine = fnoise(n, 1.4, 63)
    blot = fnoise(n, 2.5, 64)
    base = mix([0.50, 0.48, 0.45], [0.55, 0.47, 0.38], hue)
    base = mix(base, base * 0.62, tone)
    base *= (0.9 + 0.07 * fine + 0.05 * blot)[..., None]
    mortar = mix([0.58, 0.56, 0.52], [0.42, 0.40, 0.37], sstep(-1, 1, fine))
    col = mix(mortar, base, stone)
    dome = np.sqrt(np.clip(edge / 30.0, 0, 1))
    rough = 0.85 - 0.1 * stone * tone
    height = stone * (0.4 + 0.6 * dome) + fine * 0.05 + blot * 0.05
    return Tex("stone", col, rough, 0.0, height, 14)


def tex_brick(n):
    """Running-bond brick. Tile = 1 m, 12 courses, 4 bricks per course."""
    U, Vv = grid(n)
    rows = 12
    pv = Vv * rows
    rid = np.floor(pv).astype(int)
    fv = pv - rid
    pu = U * 4 + (rid % 2) * 0.5
    bid = (np.floor(pu).astype(int) % 4) + rid * 4
    fu = pu - np.floor(pu)
    mortar = 1 - sstep(0.0, 0.04, fu) * sstep(0.0, 0.04, 1 - fu) * sstep(0.0, 0.1, fv) * sstep(0.0, 0.1, 1 - fv)
    rng = np.random.default_rng(71)
    tone = rng.uniform(0, 1, rows * 4)[bid]
    fine = fnoise(n, 1.3, 72)
    soot = fnoise(n, 2.4, 73)
    brick = mix([0.52, 0.22, 0.15], [0.36, 0.15, 0.11], tone)
    brick = mix(brick, [0.2, 0.17, 0.16], sstep(0.8, 2.2, soot) * 0.6)
    brick *= (0.92 + 0.08 * fine)[..., None]
    col = mix(brick, [0.6, 0.57, 0.52], mortar)
    rough = 0.85 + 0.05 * fine
    height = (1 - mortar) * 0.5 + fine * 0.04
    return Tex("brick", col, rough, 0.0, height, 14)


def tex_grass(n):
    """Meadow ground (seen between grass blades). Tile = 3 m."""
    big = fnoise(n, 2.6, 81)
    mid = fnoise(n, 1.9, 82)
    fine = fnoise(n, 0.8, 83)
    blades = fnoise(n, 1.0, 84, ax=1, ay=3, angle=0.6) + fnoise(n, 1.0, 85, ax=1, ay=3, angle=-0.9)
    col = mix([0.20, 0.30, 0.09], [0.31, 0.40, 0.13], sstep(-2, 2, big + 0.5 * mid))
    col = mix(col, [0.47, 0.45, 0.22], sstep(1.0, 2.4, mid + 0.3 * big) * 0.7)  # dry patches
    col *= (0.82 + 0.18 * sstep(-2, 2, blades))[..., None]
    soil = sstep(1.9, 2.6, fine * 0.8 + mid * 0.5)
    col = mix(col, [0.28, 0.22, 0.16], soil)
    rough = 0.92 + 0.04 * fine.clip(-1, 1)
    height = blades * 0.08 + fine * 0.05 - soil * 0.2
    return Tex("grass", col, rough, 0.0, height, 6)


def tex_dirt(n):
    """Packed dirt track with pebbles. Tile = 3 m."""
    big = fnoise(n, 2.5, 91)
    fine = fnoise(n, 1.2, 92)
    f1, f2, idx = worley(n, 160, 93)
    rng = np.random.default_rng(94)
    sel = rng.random(160)[idx] < 0.55
    peb_r = rng.uniform(0.004, 0.012, 160)[idx]
    peb = sel & (f1 < peb_r)
    col = mix([0.47, 0.39, 0.29], [0.33, 0.26, 0.19], sstep(-2, 2, big + 0.4 * fine))
    col *= (0.9 + 0.1 * fine)[..., None]
    ptone = rng.uniform(0.35, 0.7, 160)[idx]
    col[peb] = (np.stack([ptone, ptone * 0.95, ptone * 0.88], -1))[peb]
    rough = np.where(peb, 0.7, 0.95)
    height = big * 0.08 + fine * 0.06 + peb * np.clip(1 - f1 / peb_r, 0, 1) * 0.6
    return Tex("dirt", col, rough, 0.0, height, 10)


def tex_soil(n):
    """Plowed soil, furrows run along V. Tile = 3.2 m with 4 furrows (0.8 m rows)."""
    U, Vv = grid(n)
    warp = fnoise(n, 2.6, 101) * 0.012
    ridge = 0.5 + 0.5 * np.cos(2 * np.pi * (U * 4 + warp))
    clods = fnoise(n, 1.1, 102)
    big = fnoise(n, 2.4, 103)
    col = mix([0.20, 0.14, 0.10], [0.36, 0.28, 0.20], sstep(0.35, 1.0, ridge) * 0.9)
    col *= (0.88 + 0.12 * sstep(-2, 2, clods + big * 0.5))[..., None]
    rough = 0.95 - 0.08 * (1 - ridge)
    height = ridge * 1.0 + clods * 0.1
    return Tex("soil", col, rough, 0.0, height, 8)


def tex_straw(n, key="straw", seed=111, base=(0.78, 0.63, 0.34)):
    """Straw / hay fibres in many directions. Tile = 1 m."""
    acc = np.zeros((n, n), np.float32)
    for k in range(6):
        acc += fnoise(n, 1.4, seed + k, ax=1, ay=18, angle=k * 0.53 + 0.2)
    acc /= 2.4
    blot = fnoise(n, 2.3, seed + 9)
    b = np.asarray(base, np.float32)
    col = mix(b * 0.55, b * 1.05, sstep(-1.8, 1.8, acc))
    col = mix(col, [0.52, 0.50, 0.38], sstep(0.8, 2.2, blot) * 0.4)  # grey weathered
    rough = 0.85
    return Tex(key, col, rough * np.ones_like(acc), 0.0, acc * 0.25, 10)


def tex_hay_end(n):
    """End face of a round bale: rolled spiral of straw. Not tileable, UV 0..1."""
    U, Vv = grid(n)
    x, y = U - 0.5, Vv - 0.5
    r = np.sqrt(x * x + y * y) * 2
    th = np.arctan2(y, x)
    fib = fnoise(n, 1.3, 121, ax=1, ay=6) * 0.5 + fnoise(n, 1.3, 122, ax=6, ay=1) * 0.5
    spiral = 0.5 + 0.5 * np.sin(2 * np.pi * (r * 14 + th / (2 * np.pi)) + fib * 0.6)
    col = mix([0.45, 0.35, 0.18], [0.80, 0.66, 0.38], sstep(0.1, 0.9, spiral) * (0.7 + 0.3 * sstep(-1, 1, fib)))
    col *= (0.75 + 0.25 * (1 - r.clip(0, 1) ** 4))[..., None]
    return Tex("hay_end", col, 0.88 * np.ones_like(r), 0.0, spiral * 0.6 + fib * 0.1, 8)


def tex_bark(n):
    """Rough tree bark, ridges along V. Tile = 1 m."""
    ridged = 1 - np.abs(fnoise(n, 2.2, 131, ax=1, ay=7))
    fine = fnoise(n, 1.2, 132)
    lichen = sstep(1.6, 2.4, fnoise(n, 2.2, 133))
    col = mix([0.16, 0.13, 0.11], [0.40, 0.36, 0.31], sstep(0.2, 0.95, ridged))
    col *= (0.88 + 0.12 * fine)[..., None]
    col = mix(col, [0.46, 0.50, 0.36], lichen * 0.7)
    rough = 0.92 * np.ones_like(fine)
    height = ridged * 0.9 + fine * 0.08
    return Tex("bark", col, rough, 0.0, height, 14)


def tex_rock(n):
    big = fnoise(n, 2.4, 141)
    fine = fnoise(n, 1.2, 142)
    lichen = sstep(1.3, 2.0, fnoise(n, 2.1, 143))
    col = mix([0.50, 0.49, 0.46], [0.32, 0.31, 0.30], sstep(-2, 2, big + fine * 0.5))
    col = mix(col, [0.58, 0.58, 0.42], lichen * 0.6)
    return Tex("rock", col, 0.8 + 0.1 * np.clip(fine, -1, 1), 0.0, big * 0.3 + fine * 0.1, 10)


def tex_concrete(n):
    big = fnoise(n, 2.4, 151)
    fine = fnoise(n, 0.9, 152)
    col = mix([0.62, 0.61, 0.58], [0.48, 0.47, 0.45], sstep(-2, 2, big + fine * 0.3))
    return Tex("concrete", col, 0.88 + 0.05 * np.clip(fine, -1, 1), 0.0, fine * 0.05 + big * 0.05, 6)


def tex_galv(n):
    """Plain galvanised steel (windmill, trough, ladder, bands)."""
    U, Vv = grid(n)
    spang = fnoise(n, 2.0, 161)
    fine = fnoise(n, 0.8, 162)
    rust = sstep(1.6, 2.4, fnoise(n, 2.3, 163))
    col = mix([0.62, 0.63, 0.63], [0.52, 0.53, 0.54], sstep(-2, 2, spang))
    col = mix(col, [0.40, 0.21, 0.10], rust)
    rough = 0.35 + 0.1 * sstep(-2, 2, spang) + 0.5 * rust
    return Tex("galv", col, rough, 0.85 * (1 - rust), fine * 0.02, 4)


def tex_leaves(n):
    """Cluster of leaves on transparent background for foliage cards. UV 0..1."""
    rng = np.random.default_rng(171)
    U, Vv = grid(n)
    alpha = np.zeros((n, n), np.float32)
    col = np.zeros((n, n, 3), np.float32)
    height = np.zeros((n, n), np.float32)
    fine = fnoise(n, 1.2, 172)
    count = 46
    for k in range(count):
        cx, cy = rng.uniform(0.12, 0.88, 2)
        ang = rng.uniform(0, 2 * np.pi)
        L = rng.uniform(0.09, 0.15)
        W = L * rng.uniform(0.38, 0.5)
        dx, dy = U - cx, Vv - cy
        a = dx * math.cos(ang) + dy * math.sin(ang)
        b = -dx * math.sin(ang) + dy * math.cos(ang)
        t = a / L  # -1..1 along leaf
        width = W * np.sqrt(np.clip(1 - t * t, 0, 1)) * (1 - 0.35 * np.clip(t, 0, 1))
        inside = (np.abs(t) < 1) & (np.abs(b) < width)
        stem = (t < -0.9) & (t > -1.35) & (np.abs(b) < 0.0025)
        shade = rng.uniform(0, 1)
        lc = mix([0.16, 0.30, 0.07], [0.32, 0.45, 0.12], np.full((n, n), shade, np.float32))
        if rng.random() < 0.12:
            lc = mix(lc, [0.55, 0.50, 0.15], np.full((n, n), 0.6, np.float32))
        vein = np.abs(b) < 0.0022
        lc = lc * (0.85 + 0.15 * (1 - np.abs(b) / (W + 1e-6)))[..., None]
        lc[vein] *= 1.25
        m = inside | stem
        col[m] = lc[m]
        alpha[m] = 1.0
        height[m] = (1 - np.abs(b) / (W + 1e-6))[m] * 0.5 - vein[m] * 0.2
    avg = col[alpha > 0.5].mean(0)
    col[alpha < 0.5] = avg  # avoid dark fringes when mip-mapping
    col *= (0.92 + 0.08 * fine)[..., None]
    rough = 0.6 * np.ones_like(fine)
    return Tex("leaves", col, rough, 0.0, height, 6, alpha=alpha)


def tex_corn_leaf(n):
    """Long grass-like leaf strip: U across the leaf, V from base (0) to tip (1)."""
    U, Vv = grid(n)
    width = (1 - Vv ** 1.7) * (0.75 + 0.25 * sstep(0.0, 0.15, Vv))
    inside = np.abs(U - 0.5) < 0.5 * width
    veins = 0.5 + 0.5 * np.cos(2 * np.pi * U * 34)
    midrib = np.abs(U - 0.5) < 0.035
    fine = fnoise(n, 1.4, 181, ax=8, ay=1)
    col = mix([0.20, 0.38, 0.09], [0.36, 0.50, 0.16], sstep(-2, 2, fine))
    col = mix(col, [0.62, 0.58, 0.30], sstep(0.75, 1.0, Vv) * 0.8)  # drying tip
    col *= (0.9 + 0.1 * veins)[..., None]
    col[midrib] = mix(col, [0.66, 0.72, 0.42], np.ones_like(U))[midrib]
    alpha = inside.astype(np.float32)
    rough = 0.55 * np.ones_like(U)
    height = veins * 0.15 + midrib * 0.4
    return Tex("corn_leaf", col, rough, 0.0, height, 6, alpha=alpha)


def tex_water_normal(n):
    h = fnoise(n, 2.2, 191, fmin=3) * 0.6 + fnoise(n, 1.6, 192, fmin=8) * 0.4
    col = np.full((n, n, 3), 0.1, np.float32)
    return Tex("water", col, 0.05 * np.ones_like(h), 0.0, h, 3)


def make_textures():
    N = TEX_N
    H = max(256, N // 2)
    T = {}
    jobs = [
        ("barn_wood", lambda: tex_barn_wood(N)),
        ("siding", lambda: tex_siding(N)),
        ("trim", lambda: tex_painted(H, "trim", (0.88, 0.87, 0.83), 201)),
        ("shutter", lambda: tex_painted(H, "shutter", (0.16, 0.27, 0.19), 205)),
        ("door_paint", lambda: tex_painted(H, "door_paint", (0.36, 0.13, 0.10), 209)),
        ("old_wood", lambda: tex_weathered_wood(H)),
        ("crate_wood", lambda: tex_weathered_wood(H, "crate_wood", (0.62, 0.50, 0.35), 37)),
        ("dark_wood", lambda: tex_weathered_wood(H, "dark_wood", (0.33, 0.24, 0.17), 39)),
        ("roof_metal", lambda: tex_corrugated(N, "roof_metal", (0.43, 0.45, 0.44), 0.8, "u", 32, 41)),
        ("silo_metal", lambda: tex_corrugated(N, "silo_metal", (0.70, 0.71, 0.70), 0.2, "v", 24, 45, 0.85)),
        ("shingles", lambda: tex_shingles(N)),
        ("stone", lambda: tex_stone(H)),
        ("brick", lambda: tex_brick(H)),
        ("grass", lambda: tex_grass(N)),
        ("dirt", lambda: tex_dirt(N)),
        ("soil", lambda: tex_soil(N)),
        ("straw", lambda: tex_straw(H)),
        ("hay_end", lambda: tex_hay_end(H)),
        ("bark", lambda: tex_bark(H)),
        ("rock", lambda: tex_rock(H)),
        ("concrete", lambda: tex_concrete(H)),
        ("galv", lambda: tex_galv(H // 2)),
        ("leaves", lambda: tex_leaves(N)),
        ("corn_leaf", lambda: tex_corn_leaf(H)),
        ("water", lambda: tex_water_normal(H)),
    ]
    for key, fn in jobs:
        T[key] = fn()
        log(f"texture {key}")
    return T


# ---------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------

# metres covered by one repeat of each texture (planar/box UV mapping)
TILE = {
    "barn_wood": 3.0, "siding": 1.6, "trim": 1.0, "shutter": 1.0, "door_paint": 1.0,
    "old_wood": 1.0, "crate_wood": 1.0, "dark_wood": 1.0, "roof_metal": 2.0, "silo_metal": 2.0,
    "shingles": 2.0, "stone": 2.0, "brick": 1.0, "grass": 3.0, "dirt": 3.0, "soil": 3.2,
    "straw": 1.0, "hay_end": 1.0, "bark": 1.0, "rock": 1.5, "concrete": 2.0, "galv": 1.0,
    "leaves": 1.0, "corn_leaf": 1.0, "water": 6.0, "glass": 1.0, "dark_metal": 1.0,
}

MAT = {}


def node_tree(mat):
    if mat.node_tree is None:
        mat.use_nodes = True
    return mat.node_tree


def principled(nt):
    return next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")


def make_pbr_material(key, tex, alpha_clip=False, double=False):
    mat = bpy.data.materials.new(key)
    nt = node_tree(mat)
    nodes, links = nt.nodes, nt.links
    bsdf = principled(nt)
    bsdf.location = (300, 0)
    c = nodes.new("ShaderNodeTexImage")
    c.image = tex.color
    c.location = (-400, 300)
    links.new(c.outputs["Color"], bsdf.inputs["Base Color"])
    if alpha_clip:
        lt = nodes.new("ShaderNodeMath")
        lt.operation = "LESS_THAN"
        lt.inputs[1].default_value = 0.5
        lt.location = (-100, 150)
        sub = nodes.new("ShaderNodeMath")
        sub.operation = "SUBTRACT"
        sub.inputs[0].default_value = 1.0
        sub.location = (80, 150)
        links.new(c.outputs["Alpha"], lt.inputs[0])
        links.new(lt.outputs[0], sub.inputs[1])
        links.new(sub.outputs[0], bsdf.inputs["Alpha"])
        if hasattr(mat, "surface_render_method"):
            mat.surface_render_method = "DITHERED"
        if hasattr(mat, "blend_method"):
            try:
                mat.blend_method = "CLIP"
            except TypeError:
                pass
    o = nodes.new("ShaderNodeTexImage")
    o.image = tex.orm
    o.location = (-400, 0)
    sep = nodes.new("ShaderNodeSeparateColor")
    sep.location = (-100, 0)
    links.new(o.outputs["Color"], sep.inputs["Color"])
    links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    nm_img = nodes.new("ShaderNodeTexImage")
    nm_img.image = tex.normal
    nm_img.location = (-400, -300)
    nm = nodes.new("ShaderNodeNormalMap")
    nm.location = (-100, -300)
    links.new(nm_img.outputs["Color"], nm.inputs["Color"])
    links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    mat.use_backface_culling = not double
    return mat


def make_flat_material(key, color, rough, metal=0.0, ior_level=0.5):
    mat = bpy.data.materials.new(key)
    nt = node_tree(mat)
    bsdf = principled(nt)
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = ior_level
    mat.use_backface_culling = True
    return mat


def make_terrain_material(T):
    """Blender-side splat of grass / dirt / soil by the 'Col' attribute (R = dirt, G = soil).
    The web viewer rebuilds the same blend in a shader from the helper materials."""
    mat = bpy.data.materials.new("terrain")
    nt = node_tree(mat)
    nodes, links = nt.nodes, nt.links
    bsdf = principled(nt)
    attr = nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    sep = nodes.new("ShaderNodeSeparateColor")
    links.new(attr.outputs["Color"], sep.inputs["Color"])

    def layer(key, scale):
        uv = nodes.new("ShaderNodeTexCoord")
        mp = nodes.new("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = (scale, scale, 1)
        links.new(uv.outputs["UV"], mp.inputs["Vector"])
        out = {}
        for m in ("color", "orm", "normal"):
            n = nodes.new("ShaderNodeTexImage")
            n.image = getattr(T[key], m)
            links.new(mp.outputs["Vector"], n.inputs["Vector"])
            out[m] = n.outputs["Color"]
        return out

    g, d, s = layer("grass", 1.0), layer("dirt", 1.0), layer("soil", TILE["grass"] / TILE["soil"])

    def blend(a, b, c, socket_type="RGBA"):
        m1 = nodes.new("ShaderNodeMix")
        m1.data_type = socket_type
        links.new(sep.outputs["Red"], m1.inputs["Factor"])
        links.new(a, m1.inputs[6])
        links.new(b, m1.inputs[7])
        m2 = nodes.new("ShaderNodeMix")
        m2.data_type = socket_type
        links.new(sep.outputs["Green"], m2.inputs["Factor"])
        links.new(m1.outputs[2], m2.inputs[6])
        links.new(c, m2.inputs[7])
        return m2.outputs[2]

    links.new(blend(g["color"], d["color"], s["color"]), bsdf.inputs["Base Color"])
    orm = nodes.new("ShaderNodeSeparateColor")
    links.new(blend(g["orm"], d["orm"], s["orm"]), orm.inputs["Color"])
    links.new(orm.outputs["Green"], bsdf.inputs["Roughness"])
    nm = nodes.new("ShaderNodeNormalMap")
    links.new(blend(g["normal"], d["normal"], s["normal"]), nm.inputs["Color"])
    links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


def make_materials(T):
    for key, tex in T.items():
        MAT[key] = make_pbr_material(key, tex, alpha_clip=tex.alpha, double=tex.alpha)
    MAT["glass"] = make_flat_material("glass", (0.05, 0.07, 0.08), 0.04, 0.0, 1.0)
    MAT["dark_metal"] = make_flat_material("dark_metal", (0.07, 0.07, 0.07), 0.45, 0.9)
    water = make_flat_material("pond_water", (0.06, 0.10, 0.08), 0.03, 0.0, 1.0)
    nt = water.node_tree
    nm_img = nt.nodes.new("ShaderNodeTexImage")
    nm_img.image = T["water"].normal
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nm.inputs["Strength"].default_value = 0.4
    nt.links.new(nm_img.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], principled(nt).inputs["Normal"])
    MAT["pond_water"] = water
    MAT["terrain"] = make_terrain_material(T)


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

COLL = {}


def collection(name, parent=None):
    c = bpy.data.collections.new(name)
    (parent or bpy.context.scene.collection).children.link(c)
    COLL[name] = c
    return c


def newell(pts):
    n = Vector((0, 0, 0))
    for i, a in enumerate(pts):
        b = pts[(i + 1) % len(pts)]
        n.x += (a.y - b.y) * (a.z + b.z)
        n.y += (a.z - b.z) * (a.x + b.x)
        n.z += (a.x - b.x) * (a.y + b.y)
    return n.normalized() if n.length > 1e-12 else Vector((0, 0, 1))


def planar_uv(pts, tile, off=(0.0, 0.0)):
    n = newell(pts)
    if abs(n.z) > 0.999:
        t = Vector((1, 0, 0))
    else:
        t = Vector((0, 0, 1)).cross(n).normalized()
    b = n.cross(t)
    return [(p.dot(t) / tile + off[0], p.dot(b) / tile + off[1]) for p in pts]


def frame(x, up=Vector((0, 0, 1))):
    """Rotation matrix whose X axis is `x` and Z axis is as close to `up` as possible."""
    x = x.normalized()
    if abs(x.dot(up)) > 0.999:
        up = Vector((0, 1, 0)) if abs(x.y) < 0.9 else Vector((1, 0, 0))
    y = up.cross(x).normalized()
    z = x.cross(y)
    return Matrix((x, y, z)).transposed()


class MB:
    """Mesh builder: accumulates faces with per-face material keys and UVs."""

    def __init__(self):
        self.bm = bmesh.new()
        self.uvl = self.bm.loops.layers.uv.new("UVMap")
        self.keys = []

    def mi(self, key):
        if key not in self.keys:
            self.keys.append(key)
        return self.keys.index(key)

    def face(self, pts, key, uvs=None, smooth=False):
        pts = [Vector(p) for p in pts]
        vs = [self.bm.verts.new(p) for p in pts]
        try:
            f = self.bm.faces.new(vs)
        except ValueError:
            return None
        f.material_index = self.mi(key)
        f.smooth = smooth
        if uvs is None:
            uvs = planar_uv(pts, TILE.get(key, 1.0))
        for l, uv in zip(f.loops, uvs):
            l[self.uvl].uv = uv
        return f

    # -- primitives --------------------------------------------------------
    def box(self, M, size, key, grain=False, faces="xXyYzZ", uv_off=None):
        """Box centred on M's origin. grain=True maps texture V along the longest edge
        of each face in box space (wood grain along boards)."""
        sx, sy, sz = size[0] / 2, size[1] / 2, size[2] / 2
        F = {
            "X": [(sx, -sy, -sz), (sx, sy, -sz), (sx, sy, sz), (sx, -sy, sz)],
            "x": [(-sx, sy, -sz), (-sx, -sy, -sz), (-sx, -sy, sz), (-sx, sy, sz)],
            "Y": [(sx, sy, -sz), (-sx, sy, -sz), (-sx, sy, sz), (sx, sy, sz)],
            "y": [(-sx, -sy, -sz), (sx, -sy, -sz), (sx, -sy, sz), (-sx, -sy, sz)],
            "Z": [(-sx, -sy, sz), (sx, -sy, sz), (sx, sy, sz), (-sx, sy, sz)],
            "z": [(-sx, sy, -sz), (sx, sy, -sz), (sx, -sy, -sz), (-sx, -sy, -sz)],
        }
        tile = TILE.get(key, 1.0)
        if uv_off is None:
            uv_off = (random.random(), random.random()) if grain else (0.0, 0.0)
        dims = {"x": size[0], "y": size[1], "z": size[2]}
        for f in faces:
            loc = [Vector(p) for p in F[f]]
            pts = [M @ p for p in loc]
            if grain:
                axes = [a for a in "xyz" if a != f.lower()]
                ua, va = (axes[0], axes[1]) if dims[axes[1]] >= dims[axes[0]] else (axes[1], axes[0])
                ui, vi = "xyz".index(ua), "xyz".index(va)
                uvs = [(p[ui] / tile + uv_off[0], p[vi] / tile + uv_off[1]) for p in loc]
            else:
                uvs = planar_uv(pts, tile, uv_off)
            self.face(pts, key, uvs)

    def beam(self, p1, p2, w, h, key, up=Vector((0, 0, 1)), grain=True, ext=0.0):
        p1, p2 = Vector(p1), Vector(p2)
        d = p2 - p1
        L = d.length + 2 * ext
        R = frame(d, up).to_4x4()
        M = Matrix.Translation((p1 + p2) / 2) @ R
        self.box(M, (L, w, h), key, grain=grain)

    def lathe(self, M, prof, seg, key, smooth=True, cap0=False, cap1=False, cap_key=None,
              cap_uv=None, a0=0.0, a1=2 * math.pi):
        """Revolve a (r, z) profile around local Z."""
        tile = TILE.get(key, 1.0)
        full = abs(a1 - a0 - 2 * math.pi) < 1e-6
        rref = max(sum(r for r, _ in prof) / len(prof), 1e-3)
        reps = max(1, round((a1 - a0) * rref / tile))
        vlen = [0.0]
        for i in range(1, len(prof)):
            vlen.append(vlen[-1] + math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]))

        def P(i, j):
            a = a0 + (a1 - a0) * j / seg
            r, z = prof[i]
            return M @ Vector((r * math.cos(a), r * math.sin(a), z))

        for i in range(len(prof) - 1):
            for j in range(seg):
                q = [P(i, j), P(i, j + 1), P(i + 1, j + 1), P(i + 1, j)]
                u0, u1 = j / seg * reps, (j + 1) / seg * reps
                v0, v1 = vlen[i] / tile, vlen[i + 1] / tile
                uv = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
                if prof[i][0] < 1e-6:
                    q, uv = [q[0], q[2], q[3]], [uv[0], uv[2], uv[3]]
                elif prof[i + 1][0] < 1e-6:
                    q, uv = q[:3], uv[:3]
                self.face(q, key, uv, smooth)
        ck = cap_key or key
        for which, flag in ((0, cap0), (len(prof) - 1, cap1)):
            if not flag or prof[which][0] < 1e-6:
                continue
            r, z = prof[which]
            ring = list(range(seg)) if full else list(range(seg + 1))
            pts = [P(which, j) for j in ring]
            loc = [Vector((r * math.cos(a0 + (a1 - a0) * j / seg), r * math.sin(a0 + (a1 - a0) * j / seg), z)) for j in ring]
            if which == 0:
                pts.reverse()
                loc.reverse()
            if cap_uv == "disc":
                uvs = [(p.x / (2 * r) + 0.5, p.y / (2 * r) + 0.5) for p in loc]
            else:
                uvs = [(p.x / TILE.get(ck, 1.0), p.y / TILE.get(ck, 1.0)) for p in loc]
            self.face(pts, ck, uvs)

    def tube(self, pts, radii, sides, key, smooth=True, uv_off=0.0):
        """Generalised cylinder along a polyline (branches, stalks)."""
        tile = TILE.get(key, 1.0)
        pts = [Vector(p) for p in pts]
        rings = []
        ref = Vector((0.31, 0.77, 0.55)).normalized()
        prev_n = None
        for i, p in enumerate(pts):
            if i == 0:
                d = pts[1] - pts[0]
            elif i == len(pts) - 1:
                d = pts[-1] - pts[-2]
            else:
                d = (pts[i + 1] - pts[i - 1])
            d.normalize()
            n = (prev_n if prev_n is not None else ref)
            n = (n - d * n.dot(d))
            if n.length < 1e-4:
                n = Vector((1, 0, 0)) - d * d.x
            n.normalize()
            prev_n = n
            b = d.cross(n)
            rings.append([p + (n * math.cos(2 * math.pi * j / sides) + b * math.sin(2 * math.pi * j / sides)) * radii[i]
                          for j in range(sides + 1)])
        reps = max(1, round(2 * math.pi * radii[0] / tile))
        v = 0.0
        for i in range(len(pts) - 1):
            v1 = v + (pts[i + 1] - pts[i]).length / tile
            for j in range(sides):
                q = [rings[i][j], rings[i][j + 1], rings[i + 1][j + 1], rings[i + 1][j]]
                uv = [(j / sides * reps + uv_off, v), ((j + 1) / sides * reps + uv_off, v),
                      ((j + 1) / sides * reps + uv_off, v1), (j / sides * reps + uv_off, v1)]
                self.face(q, key, uv, smooth)
            v = v1

    def prism(self, M, prof, y0, y1, key, skip=(), cap=True, cap_key=None):
        """Extrude a CCW (x, z) profile along local Y from y0 to y1."""
        n = len(prof)
        for i in range(n):
            if i in skip:
                continue
            a, b = prof[i], prof[(i + 1) % n]
            q = [M @ Vector((a[0], y1, a[1])), M @ Vector((b[0], y1, b[1])),
                 M @ Vector((b[0], y0, b[1])), M @ Vector((a[0], y0, a[1]))]
            self.face(q, key)
        if cap:
            ck = cap_key or key
            front = [M @ Vector((x, y0, z)) for x, z in prof]
            back = [M @ Vector((x, y1, z)) for x, z in reversed(prof)]
            self.face(front, ck)
            self.face(back, ck)

    def card(self, c, nrm, size, key, rot=0.0, uv=((0, 0), (1, 0), (1, 1), (0, 1))):
        R = frame(nrm.orthogonal(), nrm) if False else None
        z = nrm.normalized()
        x = z.orthogonal().normalized()
        y = z.cross(x)
        cr, sr = math.cos(rot), math.sin(rot)
        x, y = x * cr + y * sr, -x * sr + y * cr
        h = size / 2
        pts = [c - x * h - y * h, c + x * h - y * h, c + x * h + y * h, c - x * h + y * h]
        return self.face(pts, key, list(uv))

    def build(self, name, coll, loc=(0, 0, 0), merge=True, parent=None):
        if merge:
            bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-4)
        me = bpy.data.meshes.new(name)
        self.bm.normal_update()
        self.bm.to_mesh(me)
        self.bm.free()
        for k in self.keys:
            me.materials.append(MAT[k])
        ob = bpy.data.objects.new(name, me)
        coll.objects.link(ob)
        ob.location = loc
        if parent:
            ob.parent = parent
        return ob


def empty(name, coll, loc=(0, 0, 0), parent=None):
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = 1.0
    coll.objects.link(e)
    e.location = loc
    if parent:
        e.parent = parent
    return e


def instance(src, name, coll, loc, rot_z=0.0, scale=1.0, parent=None):
    """Linked duplicate (shares mesh data -> becomes a GPU instance in the viewer)."""
    ob = bpy.data.objects.new(name, src.data)
    coll.objects.link(ob)
    ob.location = loc
    ob.rotation_euler = (0, 0, rot_z)
    ob.scale = (scale, scale, scale)
    if parent:
        ob.parent = parent
    return ob


T_ = Matrix.Translation


def RZ(a):
    return Matrix.Rotation(a, 4, "Z")


def RX(a):
    return Matrix.Rotation(a, 4, "X")


def RY(a):
    return Matrix.Rotation(a, 4, "Y")


# ---------------------------------------------------------------------------
# Layout: terrain function and masks
# ---------------------------------------------------------------------------

POND = (34.0, -27.0, 8.0)
CORN = (24.0, 54.0, 14.0, 42.0)          # xmin, xmax, ymin, ymax
PLOWED = (-58.0, -26.0, -56.0, -22.0)
PADDOCK = (-38.0, -14.0, -4.0, 24.0)
BARN = (-4.0, 14.0)                       # centre (front gable faces -Y)
SILO = (5.6, 19.0)
HOUSE = (23.0, -2.0)
WINDMILL = (11.0, 28.0)

PATHS = [  # (polyline, width)
    ([(14, -170), (17, -110), (12, -60), (7, -28), (3, -6)], 4.2),
    ([(-1, -3), (-4, 4.5)], 4.5),                      # yard -> barn doors
    ([(9, -3), (16, -9), (23, -10.5)], 2.0),            # yard -> porch
    ([(-6, -2), (-14, 1.5)], 3.2),                      # yard -> paddock gate
    ([(9, 2), (15, 8), (20.5, 14), (21, 44)], 3.2),     # track along the corn
    ([(10, -42), (-10, -38), (-24, -36)], 3.0),         # road -> plowed field
]
YARD = (1.0, -1.5, 13.0, 7.5)  # centre x, y, radius x, radius y


def _fbm2(x, y, octaves=4):
    s, a, f = 0.0, 1.0, 1.0
    for _ in range(octaves):
        s += a * mnoise.noise(Vector((x * f, y * f, 0.37)))
        a *= 0.5
        f *= 2.03
    return s


def terrain_h(x, y):
    r = math.hypot(x - 2, y - 2)
    near = 0.35 * math.sin(x * 0.045 + 0.5) * math.cos(y * 0.04 - 0.3) + 0.18 * math.sin(x * 0.09 + y * 0.07 + 1.1)
    h = near * (0.3 + 0.7 * smoothstep(34, 70, r))
    hills = 9.0 + 9.0 * _fbm2(x * 0.011 + 4.1, y * 0.011 - 2.3)
    h += smoothstep(75, 210, r) * hills
    h += 0.6 * _fbm2(x * 0.03, y * 0.03, 3) * smoothstep(40, 90, r)
    d = math.hypot(x - POND[0], y - POND[1])
    h -= 1.5 * (1 - smoothstep(POND[2] - 3, POND[2] + 2.5, d))
    return h


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy + 1e-9)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def rect_mask(x, y, r, soft=1.2):
    x0, x1, y0, y1 = r
    dx = max(x0 - x, 0, x - x1)
    dy = max(y0 - y, 0, y - y1)
    return 1 - smoothstep(0, soft, math.hypot(dx, dy))


def masks(x, y):
    """(dirt, soil, no_grass) in 0..1 for a ground point."""
    dirt = 0.0
    for pts, w in PATHS:
        for a, b in zip(pts, pts[1:]):
            d = seg_dist(x, y, a[0], a[1], b[0], b[1])
            dirt = max(dirt, 1 - smoothstep(w * 0.35, w * 0.65, d))
    cx, cy, rx, ry = YARD
    e = math.hypot((x - cx) / rx, (y - cy) / ry)
    dirt = max(dirt, 1 - smoothstep(0.75, 1.1, e))
    d = math.hypot(x - POND[0], y - POND[1])
    dirt = max(dirt, (1 - smoothstep(POND[2] - 1.5, POND[2] + 0.8, d)) * 0.85)  # muddy bank
    soil = max(rect_mask(x, y, CORN, 1.5), rect_mask(x, y, PLOWED, 1.5))
    nog = 0.0
    for (bx, by, hw, hd) in ((BARN[0], BARN[1], 6.8, 9.8), (HOUSE[0], HOUSE[1] - 1.2, 5.6, 5.4),
                             (SILO[0], SILO[1], 3.0, 3.0), (WINDMILL[0], WINDMILL[1], 1.8, 1.8)):
        if abs(x - bx) < hw and abs(y - by) < hd:
            nog = 1.0
    if d < POND[2] - 0.5:
        nog = 1.0
    return dirt, soil, nog


def ground(x, y):
    return terrain_h(x, y)


def footprint_base(cx, cy, hw, hd):
    pts = [(cx + sx * hw, cy + sy * hd) for sx in (-1, 0, 1) for sy in (-1, 0, 1)]
    return min(ground(px, py) for px, py in pts)


# ---------------------------------------------------------------------------
# Terrain, pond
# ---------------------------------------------------------------------------

TERRAIN_SIZE = 440.0
TERRAIN_N = 300


def build_terrain(coll):
    mb = MB()
    N, S = TERRAIN_N, TERRAIN_SIZE
    bm = mb.bm
    verts = []
    cols = []
    for j in range(N + 1):
        for i in range(N + 1):
            x = -S / 2 + S * i / N
            y = -S / 2 + S * j / N
            verts.append(bm.verts.new((x, y, ground(x, y))))
            cols.append(masks(x, y))
    bm.verts.ensure_lookup_table()
    mi = mb.mi("terrain")
    tile = TILE["grass"]
    for j in range(N):
        for i in range(N):
            a = j * (N + 1) + i
            q = [verts[a], verts[a + 1], verts[a + N + 2], verts[a + N + 1]]
            f = bm.faces.new(q)
            f.material_index = mi
            f.smooth = True
            for l in f.loops:
                co = l.vert.co
                l[mb.uvl].uv = (co.x / tile, co.y / tile)
    ob = mb.build("Terrain", coll, merge=False)
    attr = ob.data.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    flat = []
    for d, s, g in cols:
        flat += [d, s, g, 1.0]
    attr.data.foreach_set("color", flat)
    ob.data.color_attributes.active_color = attr
    ob["terrain_grid"] = N
    ob["terrain_size"] = S
    return ob


def build_pond(coll):
    mb = MB()
    cx, cy, r = POND
    z = ground(cx + r - 1.0, cy) - 0.12
    z = min(z, ground(cx, cy + r - 1.0) - 0.12, -0.45)
    seg = 48
    pts = [Vector((cx + (r + 0.4) * math.cos(2 * math.pi * k / seg), cy + (r + 0.4) * math.sin(2 * math.pi * k / seg), z))
           for k in range(seg)]
    mb.face(pts, "pond_water", [(p.x / 6, p.y / 6) for p in pts])
    ob = mb.build("Pond_Water", coll)
    return ob, z


# ---------------------------------------------------------------------------
# Windows / doors (shared by buildings)
# ---------------------------------------------------------------------------

def window(mb, M, w, h, cols=2, rows=2, frame_key="trim", shutters=None, depth=0.06):
    """Window on a wall. M: origin at the window centre on the wall surface, local Y = wall normal."""
    fw = 0.09
    mb.box(M @ T_((0, 0.005, 0)), (w, 0.01, h), "glass")
    for x in (-w / 2 - fw / 2, w / 2 + fw / 2):
        mb.box(M @ T_((x, depth / 2, 0)), (fw, depth, h + 2 * fw), frame_key, grain=True)
    mb.box(M @ T_((0, depth / 2, h / 2 + fw / 2)), (w + 2 * fw, depth, fw), frame_key, grain=True)
    mb.box(M @ T_((0, depth, -h / 2 - fw / 2)), (w + 2 * fw + 0.1, depth * 2, fw * 1.1), frame_key, grain=True)  # sill
    m = 0.035
    for c in range(1, cols):
        x = -w / 2 + w * c / cols
        mb.box(M @ T_((x, 0.02, 0)), (m, 0.03, h), frame_key, grain=True)
    for r in range(1, rows):
        z = -h / 2 + h * r / rows
        mb.box(M @ T_((0, 0.02, z)), (w, 0.03, m), frame_key, grain=True)
    if shutters:
        sw = w * 0.55
        for s in (-1, 1):
            x = s * (w / 2 + fw + sw / 2 + 0.03)
            mb.box(M @ T_((x, 0.03, 0)), (sw, 0.04, h + 0.1), shutters, grain=True)
            for k in range(4):  # louvre lines
                z = -h / 2 + (k + 0.5) * h / 4
                mb.box(M @ T_((x, 0.055, z)), (sw - 0.08, 0.015, 0.035), shutters, grain=True)


def x_door(mb, M, w, h, key="barn_wood", trim="trim", t=0.08):
    """Barn-style door with white frame and X brace. M at bottom centre, local Y = outward."""
    mb.box(M @ T_((0, t / 2, h / 2)), (w, t, h), key)
    b = 0.16
    for x in (-w / 2 + b / 2, w / 2 - b / 2):
        mb.box(M @ T_((x, t + 0.02, h / 2)), (b, 0.04, h), trim, grain=True)
    for z in (b / 2, h - b / 2, h / 2):
        mb.box(M @ T_((0, t + 0.02, z)), (w - 2 * b, 0.04, b), trim, grain=True)
    for zc in (h * 0.25 + b * 0.25, h * 0.75 - b * 0.25):
        hh = h / 2 - b * 1.5
        ww = w - 2 * b
        ang = math.atan2(hh, ww)
        L = math.hypot(ww, hh)
        for s in (1, -1):
            mb.box(M @ T_((0, t + 0.025, zc)) @ RY(-s * ang), (L, 0.035, b * 0.8), trim, grain=True)


# ---------------------------------------------------------------------------
# Buildings
# ---------------------------------------------------------------------------

def build_barn(coll):
    bx, by = BARN
    W, L = 12.0, 18.0
    z0 = footprint_base(bx, by, W / 2, L / 2)
    base_h = 0.4
    eave, knee_x, knee_z, ridge = 5.2, 4.3, 8.3, 10.0
    prof = [(-6, 0), (6, 0), (6, eave), (knee_x, knee_z), (0, ridge), (-knee_x, knee_z), (-6, eave)]
    root = empty("Barn", coll, (bx, by, z0))
    mb = MB()
    I = Matrix.Identity(4)
    # stone foundation
    mb.box(T_((0, 0, base_h / 2 - 0.35)), (W + 0.3, L + 0.3, base_h + 0.7), "stone")
    # plank walls
    M = T_((0, 0, base_h))
    mb.prism(M, prof, -L / 2, L / 2, "barn_wood", skip=(0,))
    # roof panels
    t = 0.07
    ovh_side = 0.45
    segs = [((6, eave), (knee_x, knee_z), 0.55, 0.1), ((knee_x, knee_z), (0, ridge), 0.06, 0.05),
            ((-6, eave), (-knee_x, knee_z), 0.55, 0.1), ((-knee_x, knee_z), (0, ridge), 0.06, 0.05)]
    for a, b, ext_a, ext_b in segs:
        A = Vector((a[0], 0, a[1] + base_h))
        B = Vector((b[0], 0, b[1] + base_h))
        d = (B - A).normalized()
        n = Vector((d.z, 0, -d.x)) if a[0] > 0 else Vector((-d.z, 0, d.x))
        if n.z < 0:
            n = -n
        A2 = A - d * ext_a + n * (t / 2 + 0.03)
        B2 = B + d * ext_b + n * (t / 2 + 0.03)
        Rm = Matrix((d, Vector((0, 1, 0)), n)).transposed().to_4x4()
        mb.box(T_((A2 + B2) / 2) @ Rm, ((B2 - A2).length, L + 2 * ovh_side, t), "roof_metal")
        # fascia boards along the gable edges
        for yy in (-L / 2 - ovh_side + 0.02, L / 2 + ovh_side - 0.02):
            p1 = A2 + Vector((0, yy, 0)) - n * 0.09
            p2 = B2 + Vector((0, yy, 0)) - n * 0.09
            mb.beam(p1, p2, 0.05, 0.22, "trim", up=n)
    # ridge cap
    mb.beam((0, -L / 2 - ovh_side, ridge + base_h + 0.1), (0, L / 2 + ovh_side, ridge + base_h + 0.1), 0.45, 0.08, "roof_metal", grain=False)
    # eave fascia
    for s in (-1, 1):
        x = s * (6 + 0.42)
        mb.beam((x, -L / 2 - ovh_side, eave + base_h - 0.12), (x, L / 2 + ovh_side, eave + base_h - 0.12), 0.05, 0.22, "trim")
    # corner boards
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.box(T_((sx * (6 + 0.02), sy * (L / 2 - 0.12), base_h + eave / 2)), (0.04, 0.24, eave), "trim", grain=True)
            mb.box(T_((sx * (6 - 0.12), sy * (L / 2 + 0.02), base_h + eave / 2)), (0.24, 0.04, eave), "trim", grain=True)
    # base trim board
    mb.box(T_((0, -L / 2 - 0.02, base_h + 0.1)), (W, 0.04, 0.2), "trim", grain=True)
    # front: two sliding doors + track, hayloft door + hay hood
    front = T_((0, -L / 2, base_h)) @ RZ(math.pi)
    for s in (-1, 1):
        x_door(mb, front @ T_((s * 1.15, 0, 0)), 2.3, 4.0)
    mb.box(T_((0, -L / 2 - 0.16, base_h + 4.15)), (5.6, 0.1, 0.14), "dark_metal")
    x_door(mb, front @ T_((0, 0, 6.1)), 2.0, 1.9)
    mb.beam((0, -L / 2, ridge + base_h - 0.1), (0, -L / 2 - 1.1, ridge + base_h - 0.1), 0.18, 0.18, "old_wood")
    window(mb, front @ T_((-3.6, 0, 6.2)), 0.8, 0.8, 2, 2)
    window(mb, front @ T_((3.6, 0, 6.2)), 0.8, 0.8, 2, 2)
    # back: one door
    back = T_((0, L / 2, base_h))
    x_door(mb, back @ T_((0, 0, 0)), 3.0, 3.6)
    # side windows
    for s in (-1, 1):
        side = T_((s * 6, 0, base_h)) @ RZ(-s * math.pi / 2)
        for k, yy in enumerate((-6.0, -2.0, 2.0, 6.0)):
            window(mb, side @ T_((yy * -s, 0, 2.7)), 1.0, 0.9, 3, 2)
        x_door(mb, side @ T_((7.6 * -s, 0, 0)), 1.2, 2.3)
    # cupola
    cz = ridge + base_h
    mb.box(T_((0, 0, cz + 0.55)), (1.5, 1.5, 1.4), "barn_wood")
    for s in (-1, 1):
        for axis in (0, 1):
            off = Vector((s * 0.77, 0, 0)) if axis == 0 else Vector((0, s * 0.77, 0))
            for k in range(5):
                M2 = T_(off + Vector((0, 0, cz + 0.6 + k * 0.14))) @ RZ(0 if axis else math.pi / 2)
                mb.box(M2, (1.2, 0.03, 0.05), "trim", grain=True)
    mb.box(T_((0, 0, cz + 1.3)), (1.75, 1.75, 0.08), "trim")
    apex = Vector((0, 0, cz + 2.3))
    c = [Vector((-0.95, -0.95, cz + 1.34)), Vector((0.95, -0.95, cz + 1.34)), Vector((0.95, 0.95, cz + 1.34)), Vector((-0.95, 0.95, cz + 1.34))]
    for i in range(4):
        mb.face([c[i], c[(i + 1) % 4], apex], "roof_metal")
    # weather vane rod + arrow
    mb.beam(apex, apex + Vector((0, 0, 1.0)), 0.03, 0.03, "dark_metal")
    mb.beam(apex + Vector((-0.5, 0, 0.8)), apex + Vector((0.6, 0, 0.8)), 0.02, 0.02, "dark_metal")
    mb.face([apex + Vector((0.6, 0, 0.72)), apex + Vector((0.8, 0, 0.8)), apex + Vector((0.6, 0, 0.88))], "dark_metal")
    mb.face([apex + Vector((-0.5, 0, 0.7)), apex + Vector((-0.3, 0, 0.8)), apex + Vector((-0.3, 0, 0.9)), apex + Vector((-0.5, 0, 0.92))], "dark_metal")
    mb.build("Barn_Mesh", coll, parent=root)
    return root


def build_silo(coll):
    sx, sy = SILO
    R, H = 2.5, 12.5
    z0 = footprint_base(sx, sy, R, R)
    root = empty("Silo", coll, (sx, sy, z0))
    mb = MB()
    I = Matrix.Identity(4)
    mb.lathe(I, [(R + 0.35, -0.5), (R + 0.35, 0.35), (R + 0.05, 0.42)], 40, "concrete", smooth=True)
    mb.lathe(I, [(R, 0.4), (R, H)], 48, "silo_metal")
    dome = [(R * math.cos(t) + 0.06 * (t == 0), H + 2.0 * math.sin(t)) for t in np.linspace(0, math.pi / 2 * 0.92, 9)]
    dome = [(R + 0.08, H - 0.05)] + dome
    mb.lathe(I, dome, 48, "galv", cap1=True)
    mb.lathe(T_((0, 0, H + 1.85)), [(0.35, 0), (0.35, 0.45), (0.5, 0.45), (0.0, 0.75)], 16, "galv")
    for z in np.arange(1.5, H, 2.2):  # hoops
        mb.lathe(I, [(R + 0.015, z - 0.04), (R + 0.04, z), (R + 0.015, z + 0.04)], 48, "galv")
    # ladder on the south-west side
    a = math.radians(235)
    d = Vector((math.cos(a), math.sin(a), 0))
    tng = Vector((-d.y, d.x, 0))
    base = d * (R + 0.22)
    for s in (-1, 1):
        mb.beam(base + tng * 0.22 * s + Vector((0, 0, 0.4)), base + tng * 0.22 * s + Vector((0, 0, H + 0.8)), 0.05, 0.05, "galv")
    for z in np.arange(0.8, H + 0.6, 0.32):
        mb.beam(base - tng * 0.22 + Vector((0, 0, z)), base + tng * 0.22 + Vector((0, 0, z)), 0.03, 0.03, "galv")
    for z in np.arange(3.0, H + 0.6, 0.9):  # safety cage hoops
        mb.lathe(T_(base + d * 0.25 + Vector((0, 0, z))), [(0.4, -0.015), (0.4, 0.015)], 12, "galv", smooth=False,
                 a0=math.atan2(d.y, d.x) - 1.75, a1=math.atan2(d.y, d.x) + 1.75)
    mb.build("Silo_Mesh", coll, parent=root)
    return root


def build_house(coll):
    hx, hy = HOUSE
    W, D, H = 10.0, 7.5, 5.8
    pitch = math.radians(38)
    rise = (D / 2) * math.tan(pitch)
    z0 = footprint_base(hx, hy - 1.2, W / 2 + 0.5, D / 2 + 1.6)
    root = empty("Farmhouse", coll, (hx, hy, z0))
    mb = MB()
    base_h = 0.6
    mb.box(T_((0, 0, base_h / 2 - 0.3)), (W + 0.2, D + 0.2, base_h + 0.6), "stone")
    # walls: prism with ridge along X (profile in the Y/Z plane -> rotate)
    prof = [(-D / 2, 0), (D / 2, 0), (D / 2, H), (0, H + rise), (-D / 2, H)]
    Mw = T_((0, 0, base_h)) @ RZ(-math.pi / 2)  # local x -> world -y? use rotation so extrusion runs along X
    mb.prism(Mw, prof, -W / 2, W / 2, "siding", skip=(0,))
    # roof
    t = 0.12
    ovh = 0.5
    for s in (-1, 1):
        A = Vector((0, s * D / 2, H + base_h))
        B = Vector((0, 0, H + rise + base_h))
        d = (B - A).normalized()
        n = Vector((0, s * abs(d.z), abs(d.y))).normalized()
        A2 = A - d * ovh + n * (t / 2 + 0.02)
        B2 = B + d * 0.08 + n * (t / 2 + 0.02)
        Rm = Matrix((Vector((1, 0, 0)), d, n)).transposed()
        if Rm.determinant() < 0:
            Rm = Matrix((Vector((-1, 0, 0)), d, n)).transposed()
        mb.box(T_((A2 + B2) / 2) @ Rm.to_4x4(), (W + 2 * ovh, (B2 - A2).length, t), "shingles")
        for xx in (-W / 2 - ovh + 0.03, W / 2 + ovh - 0.03):
            mb.beam(A2 + Vector((xx, 0, 0)) - n * 0.12, B2 + Vector((xx, 0, 0)) - n * 0.12, 0.06, 0.22, "trim", up=n)
        mb.beam(A2 - n * 0.12 + Vector((-W / 2 - ovh, 0, 0)), A2 - n * 0.12 + Vector((W / 2 + ovh, 0, 0)), 0.06, 0.2, "trim", up=n)
    mb.beam((-W / 2 - ovh, 0, H + rise + base_h + 0.1), (W / 2 + ovh, 0, H + rise + base_h + 0.1), 0.3, 0.1, "shingles", grain=False)
    # corner boards
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.box(T_((sx * (W / 2 + 0.02), sy * (D / 2 - 0.1), base_h + H / 2)), (0.04, 0.2, H), "trim", grain=True)
            mb.box(T_((sx * (W / 2 - 0.1), sy * (D / 2 + 0.02), base_h + H / 2)), (0.2, 0.04, H), "trim", grain=True)
    # chimney
    cx = W / 2 - 1.4
    top = H + rise + base_h + 1.0
    mb.box(T_((cx, 0.8, (top + base_h + 3) / 2)), (0.9, 0.7, top - base_h - 3), "brick")
    mb.box(T_((cx, 0.8, top + 0.06)), (1.0, 0.8, 0.12), "concrete")
    # front (-Y): door + windows
    front = T_((0, -D / 2, base_h)) @ RZ(math.pi)
    door_x = 0.0
    mb.box(front @ T_((door_x, 0.04, 1.1)), (1.0, 0.08, 2.2), "door_paint", grain=True)
    for x in (-0.55, 0.55):
        mb.box(front @ T_((x, 0.07, 1.15)), (0.12, 0.08, 2.4), "trim", grain=True)
    mb.box(front @ T_((0, 0.07, 2.35)), (1.3, 0.1, 0.14), "trim", grain=True)
    window(mb, front @ T_((0.0, 0.09, 1.5)), 0.32, 0.9, 1, 3)  # side light? keep door glass
    for x in (-3.4, -1.7, 1.7, 3.4):
        window(mb, front @ T_((x, 0, 1.6)), 0.9, 1.4, 2, 3, shutters="shutter")
    for x in (-3.0, 0.0, 3.0):
        window(mb, front @ T_((x, 0, 4.3)), 0.85, 1.2, 2, 2, shutters="shutter")
    back = T_((0, D / 2, base_h))
    for x in (-3.0, 0.0, 3.0):
        window(mb, back @ T_((x, 0, 1.6)), 0.9, 1.3, 2, 3)
        window(mb, back @ T_((x, 0, 4.3)), 0.85, 1.1, 2, 2)
    for s in (-1, 1):
        side = T_((s * W / 2, 0, base_h)) @ RZ(-s * math.pi / 2)
        for yy in (-1.6, 1.6):
            window(mb, side @ T_((yy, 0, 1.6)), 0.9, 1.3, 2, 3, shutters="shutter")
        window(mb, side @ T_((0, 0, H + 0.9)), 0.7, 0.9, 2, 2)
    # porch
    pd = 2.6
    py0 = -D / 2 - pd
    mb.box(T_((0, -D / 2 - pd / 2, base_h - 0.1)), (W, pd, 0.2), "old_wood")
    for k in range(int(W / 0.15)):
        x = -W / 2 + 0.075 + k * 0.15
        mb.box(T_((x, -D / 2 - pd / 2, base_h + 0.01)), (0.13, pd, 0.03), "old_wood", grain=True)
    mb.box(T_((0, -D / 2 - pd / 2, base_h - 0.45)), (W - 0.2, pd - 0.2, 0.7), "stone")
    posts = [-W / 2 + 0.15, -1.2, 1.2, W / 2 - 0.15]
    ph = 2.7
    for x in posts:
        mb.box(T_((x, py0 + 0.15, base_h + ph / 2)), (0.16, 0.16, ph), "trim", grain=True)
    mb.box(T_((0, py0 + 0.15, base_h + ph + 0.1)), (W, 0.2, 0.22), "trim", grain=True)
    # porch roof (shallow shed roof)
    A = Vector((0, py0 - 0.35, base_h + ph + 0.22))
    B = Vector((0, -D / 2, base_h + ph + 0.95))
    d = (B - A).normalized()
    n = Vector((0, -d.z, d.y))
    Rm = Matrix((Vector((1, 0, 0)), d, n)).transposed()
    mb.box(T_((A + B) / 2 + n * 0.05) @ Rm.to_4x4(), (W + 0.4, (B - A).length, 0.1), "shingles")
    # railings between posts, leaving the central steps open
    for x0, x1 in ((posts[0], posts[1]), (posts[2], posts[3])):
        for z in (0.12, 0.9):
            mb.box(T_(((x0 + x1) / 2, py0 + 0.15, base_h + z)), (x1 - x0 - 0.16, 0.07, 0.07), "trim", grain=True)
        for x in np.arange(x0 + 0.2, x1 - 0.1, 0.18):
            mb.box(T_((x, py0 + 0.15, base_h + 0.51)), (0.035, 0.035, 0.78), "trim", grain=True)
    for k in range(3):  # steps
        mb.box(T_((0, py0 - 0.15 - k * 0.3, base_h - 0.2 - k * 0.2)), (2.2, 0.32 + 0.0, 0.2 + 0.0), "old_wood", grain=True)
        mb.box(T_((0, py0 - 0.15 - k * 0.3, base_h - 0.6 - k * 0.2)), (2.1, 0.3, 0.6), "stone")
    mb.build("Farmhouse_Mesh", coll, parent=root)
    return root


def build_windmill(coll):
    wx, wy = WINDMILL
    z0 = ground(wx, wy)
    root = empty("Windmill", coll, (wx, wy, z0))
    mb = MB()
    H = 9.5
    b, t = 1.3, 0.28
    legs = [(sx, sy) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    for sx, sy in legs:
        mb.beam((sx * b, sy * b, -0.3), (sx * t, sy * t, H), 0.09, 0.09, "galv")
        mb.box(T_((sx * b, sy * b, -0.1)), (0.45, 0.45, 0.4), "concrete")
    levels = np.linspace(0.2, H - 0.3, 6)
    for i, z in enumerate(levels):
        f = z / H
        w = b + (t - b) * f
        for k in range(4):
            a = legs[k]
            c = legs[(k + 1) % 4]
            mb.beam((a[0] * w, a[1] * w, z), (c[0] * w, c[1] * w, z), 0.05, 0.05, "galv")
            if i < len(levels) - 1:
                z2 = levels[i + 1]
                w2 = b + (t - b) * z2 / H
                mb.beam((a[0] * w, a[1] * w, z), (c[0] * w2, c[1] * w2, z2), 0.03, 0.03, "galv")
                mb.beam((c[0] * w, c[1] * w, z), (a[0] * w2, a[1] * w2, z2), 0.03, 0.03, "galv")
    mb.box(T_((0, 0, H + 0.05)), (0.9, 0.9, 0.08), "old_wood")
    mb.lathe(T_((0, 0, H + 0.1)), [(0.12, 0), (0.12, 0.7)], 10, "galv", cap1=True)
    # pump rod + pipe + small water tank
    mb.beam((0, 0, 0), (0, 0, H), 0.04, 0.04, "galv")
    mb.lathe(T_((1.9, 0.6, 0)), [(1.1, -0.2), (1.1, 0.9)], 32, "galv", cap1=False, cap0=False)
    mb.lathe(T_((1.9, 0.6, 0)), [(0.0, 0.75), (1.06, 0.75)], 32, "pond_water", smooth=False)
    # head: gearbox + tail
    head = empty("Windmill_Head", coll, (0, 0, H + 0.8), parent=root)
    hb = MB()
    hb.box(T_((0, 0, 0.0)), (0.5, 0.9, 0.45), "galv")
    hb.beam((0, 0.2, 0.05), (0, 2.8, 0.15), 0.06, 0.06, "galv")
    hb.beam((0, 0.2, -0.05), (0, 2.8, 0.15), 0.04, 0.04, "galv")
    vane = [Vector((0, 2.0, -0.2)), Vector((0, 3.4, -0.45)), Vector((0, 3.4, 0.95)), Vector((0, 2.0, 0.5))]
    hb.face(vane, "galv")
    hb.face(list(reversed(vane)), "galv")
    hb.build("Windmill_HeadMesh", coll, parent=head)
    # rotor (spins around its local Z axis, which points into the wind)
    rotor = empty("Windmill_Rotor", coll, (0, -0.65, 0.0), parent=head)
    rotor.rotation_euler = (math.pi / 2, 0, 0)
    rb = MB()
    rb.lathe(Matrix.Identity(4), [(0.0, -0.25), (0.16, -0.15), (0.16, 0.2), (0.0, 0.25)], 14, "galv")
    nb = 18
    for k in range(nb):
        a = 2 * math.pi * k / nb
        d = Vector((math.cos(a), math.sin(a), 0))
        tg = Vector((-d.y, d.x, 0))
        pitch = math.radians(28)
        r0, r1 = 0.45, 2.3
        w0, w1 = 0.18, 0.34
        blade_y = tg * math.cos(pitch) + Vector((0, 0, math.sin(pitch)))
        R = Matrix((d, blade_y, d.cross(blade_y))).transposed().to_4x4()
        rb.box(T_(d * (r0 + r1) / 2) @ R, (r1 - r0, (w0 + w1) / 2, 0.012), "galv")
        rb.beam(d * 0.1, d * r1, 0.025, 0.025, "galv")
    for rr in (1.2, 2.2):
        rb.lathe(Matrix.Identity(4), [(rr, -0.02), (rr + 0.04, 0.0), (rr, 0.02), (rr - 0.04, 0.0), (rr, -0.02)], 48, "galv", smooth=False)
    rb.build("Windmill_RotorMesh", coll, parent=rotor)
    return root


# ---------------------------------------------------------------------------
# Fences & props
# ---------------------------------------------------------------------------

def build_fence(coll, pts, name, gate_between=None, spacing=2.6):
    mb = MB()
    prev = None
    posts = []
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        L = math.hypot(bx - ax, by - ay)
        n = max(1, round(L / spacing))
        for k in range(n + (1 if (bx, by) == pts[-1] else 0)):
            t = k / n
            posts.append((ax + (bx - ax) * t, ay + (by - ay) * t))
    for i, (x, y) in enumerate(posts):
        z = ground(x, y)
        rot = random.uniform(-0.04, 0.04)
        mb.box(T_((x, y, z + 0.6)) @ RZ(random.uniform(0, 0.3)) @ RX(rot), (0.13, 0.13, 1.6), "old_wood", grain=True)
        mb.lathe(T_((x, y, z + 1.4)), [(0.075, 0), (0.0, 0.06)], 6, "old_wood")
        if i > 0:
            if gate_between and i - 1 in gate_between:
                continue
            px, py = posts[i - 1]
            pz = ground(px, py)
            d = Vector((x - px, y - py, 0)).normalized()
            side = Vector((-d.y, d.x, 0)) * 0.085
            for h in (0.45, 0.85, 1.25):
                sag = random.uniform(-0.03, 0.03)
                mb.beam(Vector((px, py, pz + h)) + side, Vector((x, y, z + h + sag)) + side, 0.04, 0.16, "old_wood", ext=0.08)
    return mb.build(name, coll)


def build_gate(coll, a, b):
    ax, ay = a
    bx, by = b
    z = ground(ax, ay)
    mb = MB()
    L = math.hypot(bx - ax, by - ay) - 0.25
    d = Vector((bx - ax, by - ay, 0)).normalized()
    ang = math.atan2(d.y, d.x) + 0.35  # slightly open
    M = T_((ax, ay, z)) @ RZ(ang)
    for h in (0.35, 0.65, 0.95, 1.25):
        mb.box(M @ T_((L / 2 + 0.1, 0, h)), (L, 0.04, 0.12), "old_wood", grain=True)
    for x in (0.12, L + 0.05):
        mb.box(M @ T_((x, 0, 0.8)), (0.1, 0.05, 1.15), "old_wood", grain=True)
    ang2 = math.atan2(0.9, L - 0.1)
    mb.box(M @ T_((L / 2 + 0.1, 0.045, 0.8)) @ RY(-ang2), (math.hypot(L - 0.1, 0.9), 0.04, 0.11), "old_wood", grain=True)
    for h in (0.45, 1.15):
        mb.box(M @ T_((0.06, 0.03, h)), (0.22, 0.02, 0.05), "dark_metal")
    return mb.build("Paddock_Gate", coll)


def proto_round_bale(coll):
    mb = MB()
    R, Wd = 0.78, 1.25
    prof = [(R - 0.1, 0), (R - 0.02, 0.03), (R, 0.1), (R, Wd - 0.1), (R - 0.02, Wd - 0.03), (R - 0.1, Wd)]
    M = T_((0, -Wd / 2, R)) @ RX(-math.pi / 2)
    mb.lathe(M, prof, 32, "straw", cap0=True, cap1=True, cap_key="hay_end", cap_uv="disc")
    ob = mb.build("Proto_RoundBale", coll)
    return ob


def proto_square_bale(coll):
    mb = MB()
    mb.box(T_((0, 0, 0.19)), (0.95, 0.46, 0.38), "straw", grain=True)
    for x in (-0.22, 0.22):  # twine
        mb.box(T_((x, 0, 0.19)), (0.012, 0.47, 0.39), "dark_wood")
    return mb.build("Proto_SquareBale", coll)


def proto_barrel(coll):
    mb = MB()
    prof = [(0.27, 0.0), (0.31, 0.2), (0.33, 0.45), (0.31, 0.7), (0.27, 0.9)]
    mb.lathe(Matrix.Identity(4), prof, 20, "dark_wood", cap0=True, cap1=True, cap_key="crate_wood")
    for z, r in ((0.08, 0.288), (0.3, 0.324), (0.6, 0.324), (0.82, 0.288)):
        mb.lathe(T_((0, 0, z)), [(r + 0.008, -0.025), (r + 0.008, 0.025)], 20, "dark_metal", smooth=True)
    return mb.build("Proto_Barrel", coll)


def proto_crate(coll):
    mb = MB()
    s = 0.6
    for z in (0.05, 0.22, 0.39, 0.56):
        for k, (x, y, w, d) in enumerate(((0, -s / 2 + 0.01, s, 0.02), (0, s / 2 - 0.01, s, 0.02), (-s / 2 + 0.01, 0, 0.02, s), (s / 2 - 0.01, 0, 0.02, s))):
            mb.box(T_((x, y, z)), (w, d, 0.13), "crate_wood", grain=True)
    for x in (-s / 2 + 0.03, s / 2 - 0.03):
        for y in (-s / 2 + 0.03, s / 2 - 0.03):
            mb.box(T_((x, y, s / 2 - 0.0)), (0.05, 0.05, s), "crate_wood", grain=True)
    mb.box(T_((0, 0, 0.02)), (s - 0.04, s - 0.04, 0.02), "crate_wood")
    mb.box(T_((0, 0, s - 0.08)), (s - 0.06, s - 0.06, 0.04), "straw")  # filled with produce/straw
    return mb.build("Proto_Crate", coll)


def build_trough(coll, x, y, rot):
    z = ground(x, y)
    mb = MB()
    M = T_((x, y, z)) @ RZ(rot)
    L, W, H = 2.4, 0.7, 0.55
    mb.lathe(M @ T_((-L / 2, 0, H)) @ RY(math.pi / 2), [(W / 2, 0), (W / 2, L)], 20, "galv", a0=0, a1=math.pi, smooth=True)
    mb.lathe(M @ T_((-L / 2, 0, H)) @ RY(math.pi / 2), [(W / 2 - 0.01, L - 0.01), (W / 2 - 0.01, 0.01)], 20, "galv", a0=0, a1=math.pi, smooth=True)
    for s in (-1, 1):
        end = [M @ Vector((s * L / 2, W / 2 * math.cos(a), H - W / 2 * math.sin(a))) for a in np.linspace(0, math.pi, 12)]
        mb.face(end if s > 0 else list(reversed(end)), "galv")
        mb.face(list(reversed(end)) if s > 0 else end, "galv")
        for yy in (-0.3, 0.3):
            mb.beam(M @ Vector((s * (L / 2 - 0.2), yy, -0.1)), M @ Vector((s * (L / 2 - 0.2), yy * 0.4, H - 0.2)), 0.05, 0.05, "galv")
    water = [M @ Vector((x2, y2, H - 0.12)) for x2, y2 in ((-L / 2 + 0.02, -0.33), (L / 2 - 0.02, -0.33), (L / 2 - 0.02, 0.33), (-L / 2 + 0.02, 0.33))]
    mb.face(water, "pond_water")
    return mb.build("Water_Trough", coll)


def build_cart(coll, x, y, rot):
    z = ground(x, y)
    mb = MB()
    M = T_((x, y, z)) @ RZ(rot)
    R = 0.55
    bed_z = R + 0.15
    mb.box(M @ T_((0, 0, bed_z)), (2.2, 1.3, 0.06), "old_wood", grain=True)
    for s in (-1, 1):
        mb.box(M @ T_((0, s * 0.63, bed_z + 0.22)), (2.2, 0.05, 0.4), "old_wood", grain=True)
        mb.box(M @ T_((s * 1.08, 0, bed_z + 0.22)), (0.05, 1.3, 0.4), "old_wood", grain=True)
        # wheels
        W = M @ T_((0.2, s * 0.78, R)) @ RX(math.pi / 2)
        mb.lathe(W, [(R - 0.06, -0.05), (R, -0.05), (R, 0.05), (R - 0.06, 0.05), (R - 0.06, -0.05)], 28, "dark_wood", smooth=False)
        mb.lathe(W, [(0.1, -0.08), (0.1, 0.08)], 12, "dark_metal", cap0=True, cap1=True)
        for k in range(10):
            a = 2 * math.pi * k / 10
            mb.beam(W @ Vector((0.08 * math.cos(a), 0.08 * math.sin(a), 0)), W @ Vector(((R - 0.05) * math.cos(a), (R - 0.05) * math.sin(a), 0)), 0.04, 0.03, "dark_wood")
        # shafts resting on the ground
        mb.beam(M @ Vector((-1.1, s * 0.45, bed_z - 0.05)), M @ Vector((-3.2, s * 0.35, 0.05)), 0.07, 0.07, "old_wood")
    mb.beam(M @ Vector((0.2, -0.8, R)), M @ Vector((0.2, 0.8, R)), 0.08, 0.08, "dark_metal")
    for k in range(5):  # a few bags / straw in the bed
        mb.box(M @ T_((random.uniform(-0.7, 0.7), random.uniform(-0.3, 0.3), bed_z + 0.2)) @ RZ(random.uniform(0, 3)), (0.95, 0.46, 0.38), "straw", grain=True)
    return mb.build("Hay_Cart", coll)


# ---------------------------------------------------------------------------
# Vegetation
# ---------------------------------------------------------------------------

def set_card_normals(ob, center_fn):
    """Point foliage-card normals away from the crown centre: soft, volumetric lighting."""
    me = ob.data
    normals = []
    for v in me.vertices:
        n = (v.co - center_fn(v.co))
        n = n.normalized() if n.length > 1e-6 else Vector((0, 0, 1))
        normals.append((n * 0.85 + Vector((0, 0, 0.35))).normalized())
    try:
        me.normals_split_custom_set_from_vertices(normals)
    except Exception as e:  # pragma: no cover - API differences
        log(f"custom normals skipped: {e}")


def proto_tree(coll, seed, height=10.0, crown=1.0, name="Proto_Tree"):
    rng = random.Random(seed)
    wood = MB()
    leaf = MB()
    tips = []

    def grow(p, d, length, r0, depth):
        segs = 4 if depth == 0 else 3
        pts = [p]
        cd = d.copy()
        for _ in range(segs):
            wob = Vector((rng.gauss(0, 0.22), rng.gauss(0, 0.22), rng.gauss(0, 0.1)))
            cd = (cd + wob * (0.5 if depth == 0 else 1.0)).normalized()
            if depth >= 2:
                cd.z -= 0.08
                cd.normalize()
            pts.append(pts[-1] + cd * (length / segs))
        r1 = r0 * (0.35 if depth < 3 else 0.2)
        radii = [r0 + (r1 - r0) * i / segs for i in range(segs + 1)]
        if depth == 0:
            radii[0] *= 1.5
        wood.tube(pts, radii, max(4, 9 - 2 * depth), "bark", uv_off=rng.random())
        if depth >= 3 or length < 0.8:
            tips.extend(pts[-2:])
            return
        n_child = rng.randint(3, 5) if depth == 0 else rng.randint(2, 4)
        for c in range(n_child):
            t = rng.uniform(0.5, 1.0) if depth == 0 else rng.uniform(0.35, 1.0)
            fi = t * segs
            i0 = min(int(fi), segs - 1)
            q = pts[i0].lerp(pts[i0 + 1], fi - i0)
            r = radii[i0] + (radii[i0 + 1] - radii[i0]) * (fi - i0)
            axis = d.orthogonal().normalized()
            axis.rotate(Matrix.Rotation(rng.uniform(0, 2 * math.pi), 3, d))
            ang = rng.uniform(0.45, 0.9) if depth == 0 else rng.uniform(0.35, 0.8)
            nd = d.copy()
            nd.rotate(Matrix.Rotation(ang, 3, axis))
            nd.z += 0.25
            grow(q, nd.normalized(), length * rng.uniform(0.55, 0.72) * crown, r * 0.8, depth + 1)
        if depth > 0:
            tips.append(pts[-1])

    trunk_len = height * 0.42
    grow(Vector((0, 0, -0.2)), Vector((0, 0, 1)), trunk_len, height * 0.028, 0)
    # foliage cards around branch tips
    cz = sum((t.z for t in tips), 0.0) / max(1, len(tips))
    center = Vector((0, 0, cz))
    for t in tips:
        for _ in range(rng.randint(6, 9)):
            off = Vector((rng.gauss(0, 0.55), rng.gauss(0, 0.55), rng.gauss(0, 0.4)))
            c = t + off
            n = (c - center).normalized() * 0.6 + Vector((rng.gauss(0, 0.6), rng.gauss(0, 0.6), rng.gauss(0, 0.6)))
            leaf.card(c, n.normalized(), rng.uniform(1.0, 1.6), "leaves", rot=rng.uniform(0, 6.28))
    wood_ob = wood.build(name + "_Wood", coll)
    leaf_ob = leaf.build(name + "_Leaves", coll, merge=False)
    set_card_normals(leaf_ob, lambda co: Vector((0, 0, co.z * 0.3 + cz * 0.7)))
    return wood_ob, leaf_ob


def proto_bush(coll, seed, size=1.2):
    rng = random.Random(seed)
    leaf = MB()
    wood = MB()
    for _ in range(5):
        d = Vector((rng.gauss(0, 0.4), rng.gauss(0, 0.4), 1)).normalized()
        wood.tube([Vector((0, 0, -0.1)), d * size * 0.7], [0.04, 0.012], 4, "bark")
    for _ in range(int(70 * size)):
        p = Vector((rng.gauss(0, 0.5), rng.gauss(0, 0.5), abs(rng.gauss(0.5, 0.3)))) * size
        n = (p - Vector((0, 0, size * 0.3))).normalized() + Vector((rng.gauss(0, 0.5), rng.gauss(0, 0.5), rng.gauss(0, 0.5)))
        leaf.card(p, n.normalized(), rng.uniform(0.55, 0.85) * size, "leaves", rot=rng.uniform(0, 6.28))
    w = wood.build(f"Proto_Bush{seed}_Wood", coll)
    l = leaf.build(f"Proto_Bush{seed}_Leaves", coll, merge=False)
    set_card_normals(l, lambda co: Vector((0, 0, size * 0.25)))
    return w, l


def leaf_strip(mb, base, d_h, length, width, droop, key="corn_leaf", segs=5, rng=None, rise=0.55):
    side = Vector((-d_h.y, d_h.x, 0)).normalized()
    pts = []
    for i in range(segs + 1):
        s = i / segs
        p = base + d_h * (length * s * 0.85) + Vector((0, 0, length * (rise * s - droop * s * s)))
        pts.append(p)
    for i in range(segs):
        s0, s1 = i / segs, (i + 1) / segs
        tw0 = side * (width / 2)
        tw1 = side * (width / 2)
        q = [pts[i] - tw0, pts[i] + tw0, pts[i + 1] + tw1, pts[i + 1] - tw1]
        mb.face(q, key, [(0, s0), (1, s0), (1, s1), (0, s1)])


def proto_corn(coll, seed):
    rng = random.Random(seed)
    mb = MB()
    H = rng.uniform(2.0, 2.4)
    lean = Vector((rng.gauss(0, 0.04), rng.gauss(0, 0.04), 0))
    stalk = [Vector((0, 0, -0.05)) + lean * (z / H) * 3 + Vector((0, 0, z)) for z in np.linspace(0, H, 5)]
    # stalk uses the midrib region of the leaf texture
    side = 5
    rings = []
    for i, p in enumerate(stalk):
        r = 0.022 * (1 - 0.55 * i / (len(stalk) - 1))
        rings.append([p + Vector((math.cos(2 * math.pi * j / side), math.sin(2 * math.pi * j / side), 0)) * r for j in range(side + 1)])
    for i in range(len(stalk) - 1):
        for j in range(side):
            q = [rings[i][j], rings[i][j + 1], rings[i + 1][j + 1], rings[i + 1][j]]
            mb.face(q, "corn_leaf", [(0.47, 0.05), (0.53, 0.05), (0.53, 0.5), (0.47, 0.5)], smooth=True)
    phi = rng.uniform(0, 6.28)
    nleaves = 11
    for k in range(nleaves):
        z = 0.25 + (H - 0.55) * k / nleaves
        a = phi + (k % 2) * math.pi + rng.gauss(0, 0.35)
        d = Vector((math.cos(a), math.sin(a), 0))
        base = Vector((0, 0, z)) + lean * (z / H) * 3
        L = 0.95 - abs(k - nleaves * 0.45) * 0.06 + rng.uniform(-0.1, 0.1)
        leaf_strip(mb, base, d, L, 0.085, droop=rng.uniform(0.75, 1.05), segs=5, rise=0.75)
    top = stalk[-1]
    for k in range(7):  # tassel
        a = 2 * math.pi * k / 7 + rng.random()
        d = Vector((math.cos(a), math.sin(a), 0))
        leaf_strip(mb, top - Vector((0, 0, 0.1)), d, 0.32, 0.015, droop=0.9, key="straw", segs=3, rise=1.0)
    # ear with husk
    ez = H * 0.5
    a = phi + math.pi / 2
    d = Vector((math.cos(a), math.sin(a), 0))
    M = T_(Vector((0, 0, ez)) + d * 0.04) @ frame(d * 0.35 + Vector((0, 0, 1)), Vector((0, 0, 1))).to_4x4() @ RY(math.pi / 2)
    mb.lathe(M @ RY(0), [(0.0, 0.0), (0.035, 0.03), (0.042, 0.12), (0.03, 0.22), (0.0, 0.27)], 7, "corn_leaf", smooth=True)
    ob = mb.build(f"Proto_Corn{seed}", coll)
    return ob


def proto_reeds(coll, seed):
    rng = random.Random(seed)
    mb = MB()
    for _ in range(14):
        a = rng.uniform(0, 6.28)
        d = Vector((math.cos(a), math.sin(a), 0))
        base = Vector((rng.gauss(0, 0.2), rng.gauss(0, 0.2), -0.05))
        leaf_strip(mb, base, d, rng.uniform(1.0, 1.7), 0.04, droop=rng.uniform(0.0, 0.4), segs=4, rise=1.1)
    for _ in range(3):
        base = Vector((rng.gauss(0, 0.15), rng.gauss(0, 0.15), 0))
        top = base + Vector((rng.gauss(0, 0.08), rng.gauss(0, 0.08), rng.uniform(1.4, 1.9)))
        mb.tube([base, top], [0.008, 0.006], 4, "corn_leaf")
        mb.lathe(T_(top - Vector((0, 0, 0.32))), [(0.0, 0.0), (0.025, 0.02), (0.026, 0.22), (0.0, 0.25)], 8, "dark_wood")
    return mb.build(f"Proto_Reeds{seed}", coll)


def proto_rock(coll, seed, size=1.0):
    rng = random.Random(seed)
    mb = MB()
    res = bmesh.ops.create_icosphere(mb.bm, subdivisions=3, radius=1.0)
    off = Vector((rng.random() * 50, rng.random() * 50, rng.random() * 50))
    sx, sy, sz = rng.uniform(0.8, 1.3), rng.uniform(0.7, 1.1), rng.uniform(0.45, 0.7)
    for v in res["verts"]:
        p = v.co.copy()
        n = mnoise.fractal(p * 1.3 + off, 0.6, 2.0, 4)
        v.co = Vector((p.x * sx, p.y * sy, p.z * sz)) * (1 + 0.28 * n) * size
        if v.co.z < -0.15 * size:
            v.co.z = -0.15 * size + (v.co.z + 0.15 * size) * 0.2
    mi = mb.mi("rock")
    for f in mb.bm.faces:
        f.material_index = mi
        f.smooth = True
        pts = [l.vert.co for l in f.loops]
        for l, uv in zip(f.loops, planar_uv(pts, TILE["rock"])):
            l[mb.uvl].uv = uv
    return mb.build(f"Proto_Rock{seed}", coll, merge=False)


# ---------------------------------------------------------------------------
# Scene assembly
# ---------------------------------------------------------------------------

def clear_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for coll in list(bpy.data.collections):
        bpy.data.collections.remove(coll)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.lights, bpy.data.cameras):
        for item in list(block):
            block.remove(item)


def scatter_ok(x, y, keep_out):
    if any(math.hypot(x - kx, y - ky) < kr for kx, ky, kr in keep_out):
        return False
    d, s, g = masks(x, y)
    return d < 0.05 and s < 0.05 and g < 0.5


def build_world_objects():
    root = collection("Farm")
    c_terrain = collection("Terrain", root)
    c_build = collection("Buildings", root)
    c_props = collection("Props", root)
    c_nature = collection("Nature", root)
    c_crops = collection("Crops", root)
    c_proto = collection("Prototypes", root)
    c_help = collection("WebHelpers", root)

    build_terrain(c_terrain)
    log("terrain")
    build_pond(c_terrain)
    build_barn(c_build)
    log("barn")
    build_silo(c_build)
    build_house(c_build)
    log("house")
    build_windmill(c_build)
    log("windmill")

    # paddock fence with a gate on the east side
    x0, x1, y0, y1 = PADDOCK
    build_fence(c_props, [(x1, 3.0), (x1, y1), (x0, y1), (x0, y0), (x1, y0), (x1, 0.0)], "Paddock_Fence")
    build_gate(c_props, (x1, 0.0), (x1, 3.0))
    # garden fence in front of the house
    hx, hy = HOUSE
    build_fence(c_props, [(hx - 6.5, hy - 7.2), (hx - 1.6, hy - 7.2)], "Garden_Fence_W", spacing=2.2)
    build_fence(c_props, [(hx + 1.6, hy - 7.2), (hx + 6.5, hy - 7.2), (hx + 6.5, hy - 3.0)], "Garden_Fence_E", spacing=2.2)
    build_trough(c_props, -20.0, 9.0, 0.3)
    build_cart(c_props, 8.5, 0.5, 2.6)
    log("fences & props")

    # prototypes (hidden far below; instances reference their meshes)
    protos = {}
    protos["round_bale"] = proto_round_bale(c_proto)
    protos["square_bale"] = proto_square_bale(c_proto)
    protos["barrel"] = proto_barrel(c_proto)
    protos["crate"] = proto_crate(c_proto)
    trees = [proto_tree(c_proto, 100 + i, height=random.uniform(9, 13), name=f"Proto_Tree{i}") for i in range(4)]
    bushes = [proto_bush(c_proto, 300 + i, size=random.uniform(0.9, 1.4)) for i in range(3)]
    corns = [proto_corn(c_proto, 400 + i) for i in range(4)]
    reeds = [proto_reeds(c_proto, 500 + i) for i in range(2)]
    rocks = [proto_rock(c_proto, 600 + i, size=random.uniform(0.5, 1.1)) for i in range(4)]
    for ob in c_proto.objects:
        ob.location.z -= 500.0
    log("prototypes")

    def put(src, name, coll, x, y, rot=None, scale=1.0, dz=0.0):
        rot = random.uniform(0, 2 * math.pi) if rot is None else rot
        return instance(src, name, coll, (x, y, ground(x, y) + dz), rot, scale)

    # hay: round bales in the meadow, a stack of square bales by the barn
    k = 0
    for i in range(14):
        x, y = random.uniform(-80, -46), random.uniform(0, 40)
        put(protos["round_bale"], f"RoundBale{k}", c_props, x, y, scale=random.uniform(0.95, 1.05), dz=-0.04)
        k += 1
    for x, y, r in ((-12.5, 6.5, 0.2), (-13.6, 8.6, 1.4), (25, 8, 0.6)):
        put(protos["round_bale"], f"RoundBale{k}", c_props, x, y, rot=r, dz=-0.04)
        k += 1
    bx, by = -9.4, 3.2
    k = 0
    for layer in range(3):
        for row in range(2):
            for col in range(3 - layer):
                x = bx + col * 0.97 + layer * 0.48 + random.uniform(-0.03, 0.03)
                y = by + row * 0.48 + random.uniform(-0.03, 0.03)
                instance(protos["square_bale"], f"SquareBale{k}", c_props, (x, y, ground(bx, by) + layer * 0.38 - 0.01),
                         random.uniform(-0.06, 0.06))
                k += 1
    for i, (x, y) in enumerate(((2.6, 4.0), (3.3, 4.3), (2.9, 3.4), (8.6, 17.0))):
        put(protos["barrel"], f"Barrel{i}", c_props, x, y)
    for i, (x, y, z) in enumerate(((1.6, 3.6, 0), (1.5, 2.95, 0), (1.55, 3.3, 0.6), (17.2, -8.2, 0), (16.9, -8.8, 0))):
        instance(protos["crate"], f"Crate{i}", c_props, (x, y, ground(x, y) + z), random.uniform(-0.3, 0.3))

    # corn field: rows along Y, 0.8 m apart
    cx0, cx1, cy0, cy1 = CORN
    k = 0
    xs = np.arange(cx0 + 0.6, cx1 - 0.4, 0.8)
    for x in xs:
        for y in np.arange(cy0 + 0.5, cy1 - 0.3, 0.42):
            if random.random() < 0.04:
                continue
            xx, yy = x + random.gauss(0, 0.05), y + random.gauss(0, 0.08)
            put(random.choice(corns), f"Corn{k}", c_crops, xx, yy, scale=random.uniform(0.85, 1.1))
            k += 1
    log(f"corn plants: {k}")

    # trees
    keep = [(BARN[0], BARN[1], 13), (HOUSE[0], HOUSE[1] - 1, 9), (SILO[0], SILO[1], 4.5), (WINDMILL[0], WINDMILL[1], 4),
            (POND[0], POND[1], POND[2] + 2), (40, -40, 16), (24, -24, 9)]  # last two: keep the default view clear
    spots = [(31, -9), (32, 5), (11, -17), (-17, 31), (-6, 34), (7, 35), (-24, 36), (36, -40), (24, -45)]
    for x in np.arange(-70, 75, 8.0):  # wind-break row behind the farm
        spots.append((x + random.uniform(-2, 2), 58 + random.uniform(-3, 3)))
    for x, y in (((-6, -60), (-2, -80), (24, -75), (25, -100), (5, -120), (28, -130), (-4, -100))):
        spots.append((x, y))
    for _ in range(60):  # scattered trees on the hills
        a = random.uniform(0, 2 * math.pi)
        r = random.uniform(80, 190)
        spots.append((2 + r * math.cos(a), 2 + r * math.sin(a)))
    k = 0
    for x, y in spots:
        if not scatter_ok(x, y, keep):
            continue
        w, l = random.choice(trees)
        rot = random.uniform(0, 2 * math.pi)
        s = random.uniform(0.8, 1.2)
        put(w, f"Tree{k}_Wood", c_nature, x, y, rot, s)
        put(l, f"Tree{k}_Leaves", c_nature, x, y, rot, s)
        k += 1
    log(f"trees: {k}")
    k = 0
    bush_spots = [(HOUSE[0] - 4 + i * 1.6, HOUSE[1] - 6.6) for i in range(6) if abs(i - 2.5) > 1] + \
                 [(-14.8, y) for y in np.arange(6, 24, 4.5)] + [(x, -4.8) for x in np.arange(-36, -16, 5.5)] + \
                 [(random.uniform(-90, 90), random.uniform(-90, 90)) for _ in range(60)]
    for x, y in bush_spots:
        if not (k < 6 or scatter_ok(x, y, keep)):
            continue
        w, l = random.choice(bushes)
        rot = random.uniform(0, 6.28)
        s = random.uniform(0.7, 1.2)
        put(w, f"Bush{k}_Wood", c_nature, x, y, rot, s)
        put(l, f"Bush{k}_Leaves", c_nature, x, y, rot, s)
        k += 1
    # reeds around the pond
    px, py, pr = POND
    for i in range(26):
        a = random.uniform(0, 2 * math.pi)
        r = pr + random.uniform(-1.0, 0.8)
        put(random.choice(reeds), f"Reeds{i}", c_nature, px + r * math.cos(a), py + r * math.sin(a), scale=random.uniform(0.8, 1.2))
    # rocks
    for i in range(40):
        x, y = random.uniform(-120, 120), random.uniform(-120, 120)
        if i < 8:
            a = random.uniform(0, 2 * math.pi)
            x, y = px + (pr + 1.6) * math.cos(a), py + (pr + 1.6) * math.sin(a)
        elif not scatter_ok(x, y, keep):
            continue
        put(random.choice(rocks), f"Rock{i}", c_nature, x, y, scale=random.uniform(0.6, 1.6), dz=-0.1)
    log("vegetation")

    # helper planes so the web viewer gets the terrain-layer textures
    for i, key in enumerate(("grass", "dirt", "soil")):
        mb = MB()
        mb.face([(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)], key, [(0, 0), (1, 0), (1, 1), (0, 1)])
        mb.build(f"TexLayer_{key}", c_help, loc=(i * 2, 0, -600))


# ---------------------------------------------------------------------------
# Lighting, camera, render, export
# ---------------------------------------------------------------------------

SUN_ELEV = math.radians(32)
SUN_AZ = math.radians(215)  # from +Y clockwise-ish; sun in the south-west afternoon


def setup_lighting_and_camera():
    scene = bpy.context.scene
    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    scene.world = world
    nt = node_tree(world)
    nt.nodes.clear()
    sky = nt.nodes.new("ShaderNodeTexSky")
    for kind in ("MULTIPLE_SCATTERING", "SINGLE_SCATTERING", "NISHITA"):
        try:
            sky.sky_type = kind
            break
        except TypeError:
            continue
    try:
        sky.sun_elevation = SUN_ELEV
        sky.sun_rotation = SUN_AZ
        sky.altitude = 200
        sky.air_density = 1.0
        sky.aerosol_density = 1.6
    except AttributeError:
        pass
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = 0.22
    out = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])

    sun_data = bpy.data.lights.new("Sun", "SUN")
    sun_data.energy = 2.6
    sun_data.angle = math.radians(0.6)
    sun_data.color = (1.0, 0.95, 0.86)
    sun = bpy.data.objects.new("Sun", sun_data)
    scene.collection.objects.link(sun)
    # direction toward the sun: elevation SUN_ELEV, azimuth SUN_AZ measured from +Y toward +X
    d = Vector((math.sin(SUN_AZ) * math.cos(SUN_ELEV), math.cos(SUN_AZ) * math.cos(SUN_ELEV), math.sin(SUN_ELEV)))
    sun.rotation_euler = d.to_track_quat("Z", "Y").to_euler()

    cam_data = bpy.data.cameras.new("Camera")
    cam_data.lens = 30
    cam_data.clip_end = 2000
    cam = bpy.data.objects.new("Camera", cam_data)
    scene.collection.objects.link(cam)
    cam.location = (46, -46, 17)
    target = Vector((2, 8, 3))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    return sun, cam


def render_preview(path, samples):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 4
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 900
    scene.render.film_transparent = False
    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium High Contrast"
        scene.view_settings.exposure = -0.4
    except TypeError:
        pass
    # hide helper/prototype collections from the render
    for name in ("Prototypes", "WebHelpers"):
        COLL[name].hide_render = True
    scene.render.filepath = path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    log(f"rendering preview ({samples} samples) -> {path}")
    bpy.ops.render.render(write_still=True)
    for name in ("Prototypes", "WebHelpers"):
        COLL[name].hide_render = False


def export_glb(out_dir):
    raw = os.path.join(HERE, "out", "farm_raw.glb")
    os.makedirs(os.path.dirname(raw), exist_ok=True)
    proto = COLL["Prototypes"]
    for ob in bpy.context.scene.objects:  # prototypes are only referenced through their instances
        ob.select_set(ob.name not in proto.objects and ob.type in {"MESH", "EMPTY"})
    bpy.ops.export_scene.gltf(
        filepath=raw, export_format="GLB", use_selection=True, export_yup=True, export_apply=True,
        export_extras=True, export_cameras=False, export_lights=False, export_animations=False,
        export_image_format="WEBP", export_image_quality=88,
        export_vertex_color="ACTIVE", export_all_vertex_colors=False)
    log(f"exported {raw} ({os.path.getsize(raw) / 1e6:.1f} MB)")
    # instancing + meshopt compression (needs Node.js and `npm install` in the repo)
    final = os.path.join(out_dir, "farm.glb")
    os.makedirs(out_dir, exist_ok=True)
    node = shutil.which("node")
    script = os.path.join(HERE, "optimize.mjs")
    if node:
        r = subprocess.run([node, script, raw, final], cwd=REPO)
        if r.returncode == 0:
            return
    shutil.copyfile(raw, final)
    log(f"node/optimize.mjs unavailable: copied the uncompressed file to {final}; run `npm run farm:optimize` later")


def main():
    clear_scene()
    T = make_textures()
    make_materials(T)
    build_world_objects()
    setup_lighting_and_camera()
    if OPT["blend"]:
        os.makedirs(os.path.dirname(OPT["blend"]), exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=OPT["blend"])
        log(f"saved {OPT['blend']}")
    if OPT["export"]:
        export_glb(OPT["out"])
    if OPT["render"]:
        render_preview(OPT["render"], OPT["samples"])
    log("done")


if __name__ == "__main__":
    main()
