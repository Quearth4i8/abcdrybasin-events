"""
Rig and animate a static T-pose character for the 3D farm (Blender 4.2+ / 5.x).

Many free models (Sketchfab, etc.) come without a skeleton. This script:
  1. imports the .glb, applies its transforms, scales it to a real height, stands it on the
     ground at the origin facing -Y (= +Z / "front" in the web viewer) and joins the meshes;
  2. builds a humanoid skeleton from the body's measured proportions (hips, spine, chest,
     neck, head, legs with feet, arms with hands) and binds the mesh with smooth
     distance-based weights (robust on messy meshes where Blender's automatic weights fail);
  3. creates looping animations: Idle, Walk, Run and Work (crouch and tend crops);
  4. downsizes textures and exports a web-ready .glb with skin + animations.

The model must be in a T-pose (arms horizontal), standing upright, facing -Y in Blender
(the front of the model looks at the camera in Blender's front view, numpad 1).

Run:
    blender -b -P tools/farm/rig_character.py -- input.glb output.glb [--height 1.75] [--tex 1024]
or with the `bpy` pip module:
    python tools/farm/rig_character.py input.glb output.glb
"""

import math
import os
import sys

import bpy  # noqa: I001 - must come first: it makes bmesh/mathutils importable
import numpy as np
from mathutils import Euler, Matrix, Quaternion, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
if len(argv) < 2:
    sys.exit(__doc__)
SRC, DST = os.path.abspath(argv[0]), os.path.abspath(argv[1])
HEIGHT = float(argv[argv.index("--height") + 1]) if "--height" in argv else 1.75
TEX = int(argv[argv.index("--tex") + 1]) if "--tex" in argv else 1024
FPS = 30


def log(msg):
    print(f"[rig] {msg}", flush=True)


# ---------------------------------------------------------------------------
# 1. import, normalise, join
# ---------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
scene = bpy.context.scene
scene.render.fps = FPS
meshes = [o for o in scene.objects if o.type == "MESH"]
for o in meshes:  # bake world transforms into the mesh data, drop the importer's empties
    o.data.transform(o.matrix_world)
    o.parent = None
    o.matrix_world = Matrix.Identity(4)
for o in [o for o in scene.objects if o.type != "MESH"]:
    bpy.data.objects.remove(o, do_unlink=True)

pts = np.concatenate([np.array([v.co[:] for v in o.data.vertices]) for o in meshes])
lo, hi = pts.min(0), pts.max(0)
scale = HEIGHT / (hi[2] - lo[2])
feet = pts[pts[:, 2] < lo[2] + (hi[2] - lo[2]) * 0.05]
offset = Vector((-(feet[:, 0].min() + feet[:, 0].max()) / 2, -feet[:, 1].mean(), -lo[2]))
for o in meshes:
    o.data.transform(Matrix.Scale(scale, 4) @ Matrix.Translation(offset))
    o.data.update()

bpy.ops.object.select_all(action="DESELECT")
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.join()
body = bpy.context.view_layer.objects.active
body.name = "Character"
V = np.array([v.co[:] for v in body.data.vertices])
H = HEIGHT
log(f"{len(V)} vertices, height {H:.2f} m, scale {scale:.4f}")


# ---------------------------------------------------------------------------
# 2. measure landmarks (T-pose) and build the skeleton
# ---------------------------------------------------------------------------
def band(z0, z1):
    return V[(V[:, 2] >= z0 * H) & (V[:, 2] < z1 * H)]


torso = band(0.55, 0.66)
half_w = max(abs(torso[:, 0].min()), torso[:, 0].max())
arm_pts = V[np.abs(V[:, 0]) > half_w * 1.6]
arm_z = float(np.median(arm_pts[:, 2])) if len(arm_pts) else 0.8 * H
arm_y = float(np.median(arm_pts[:, 1])) if len(arm_pts) else 0.0
reach = float(np.abs(V[:, 0]).max())
legs = band(0.08, 0.3)
leg_x = float(np.median(np.abs(legs[:, 0]))) if len(legs) else 0.05 * H
leg_y = float(np.median(legs[:, 1])) if len(legs) else 0.0
toe_y = float(V[V[:, 2] < 0.04 * H][:, 1].min())
body_y = float(np.median(band(0.5, 0.8)[:, 1]))
log(f"shoulder width {half_w:.2f}, arm height {arm_z:.2f}, reach {reach:.2f}, leg x {leg_x:.2f}")

sh_x = half_w * 0.85
wrist_x = sh_x + (reach - sh_x) * 0.82
elbow_x = (sh_x + wrist_x) / 2
J = {  # joint positions in metres (Blender: X right of the character's left side, -Y forward, Z up)
    "hips": Vector((0, body_y, 0.53 * H)),
    "spine": Vector((0, body_y, 0.62 * H)),
    "chest": Vector((0, body_y, 0.72 * H)),
    "neck": Vector((0, body_y, arm_z + 0.03 * H)),
    "head": Vector((0, body_y, 0.87 * H)),
    "head_end": Vector((0, body_y, 1.0 * H)),
}
for s, side in ((1, "L"), (-1, "R")):
    J[f"hip.{side}"] = Vector((s * leg_x, leg_y, 0.5 * H))
    J[f"knee.{side}"] = Vector((s * leg_x, leg_y - 0.005 * H, 0.28 * H))
    J[f"ankle.{side}"] = Vector((s * leg_x, leg_y + 0.01 * H, 0.055 * H))
    J[f"toe.{side}"] = Vector((s * leg_x, toe_y + 0.02 * H, 0.015 * H))
    J[f"clav.{side}"] = Vector((s * 0.03 * H, arm_y, arm_z))
    J[f"shoulder.{side}"] = Vector((s * sh_x, arm_y, arm_z))
    J[f"elbow.{side}"] = Vector((s * elbow_x, arm_y, arm_z))
    J[f"wrist.{side}"] = Vector((s * wrist_x, arm_y, arm_z))
    J[f"fingers.{side}"] = Vector((s * reach, arm_y, arm_z))

BONES = [  # name, head, tail, parent
    ("root", Vector((0, 0, 0)), Vector((0, 0.25 * H, 0)), None),
    ("hips", J["hips"], J["spine"], "root"),
    ("spine", J["spine"], J["chest"], "hips"),
    ("chest", J["chest"], J["neck"], "spine"),
    ("neck", J["neck"], J["head"], "chest"),
    ("head", J["head"], J["head_end"], "neck"),
]
for side in ("L", "R"):
    BONES += [
        (f"thigh.{side}", J[f"hip.{side}"], J[f"knee.{side}"], "hips"),
        (f"shin.{side}", J[f"knee.{side}"], J[f"ankle.{side}"], f"thigh.{side}"),
        (f"foot.{side}", J[f"ankle.{side}"], J[f"toe.{side}"], f"shin.{side}"),
        (f"shoulder.{side}", J[f"clav.{side}"], J[f"shoulder.{side}"], "chest"),
        (f"upperarm.{side}", J[f"shoulder.{side}"], J[f"elbow.{side}"], f"shoulder.{side}"),
        (f"forearm.{side}", J[f"elbow.{side}"], J[f"wrist.{side}"], f"upperarm.{side}"),
        (f"hand.{side}", J[f"wrist.{side}"], J[f"fingers.{side}"], f"forearm.{side}"),
    ]

arm_data = bpy.data.armatures.new("Skeleton")
rig = bpy.data.objects.new("Farmer", arm_data)
scene.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="EDIT")
for name, head, tail, parent in BONES:
    b = arm_data.edit_bones.new(name)
    b.head, b.tail = head, tail
    b.roll = 0.0
    if parent:
        b.parent = arm_data.edit_bones[parent]
        b.use_connect = False
arm_data.edit_bones["root"].use_deform = False
bpy.ops.object.mode_set(mode="OBJECT")


# ---------------------------------------------------------------------------
# 3. smooth distance-based skin weights
# ---------------------------------------------------------------------------
def seg_dist(P, a, b):
    a, b = np.array(a[:]), np.array(b[:])
    ab = b - a
    t = np.clip(((P - a) @ ab) / max(ab @ ab, 1e-9), 0, 1)
    return np.linalg.norm(P - (a + t[:, None] * ab), axis=1)


deform = [b for b in BONES if b[0] != "root"]
D = np.stack([seg_dist(V, head, tail) for _, head, tail, _ in deform], 1)
names = [b[0] for b in deform]
# keep limbs from grabbing the wrong side or the torso grabbing hands, etc.
side_x = V[:, 0]
for k, n in enumerate(names):
    if n.endswith(".L"):
        D[side_x < -0.02 * H, k] = 1e3
    if n.endswith(".R"):
        D[side_x > 0.02 * H, k] = 1e3
    if n.startswith(("thigh", "shin", "foot")):
        D[V[:, 2] > 0.58 * H, k] = 1e3
    if n.startswith(("upperarm", "forearm", "hand")):
        D[np.abs(side_x) < sh_x * 0.8, k] = 1e3
W = 1.0 / np.maximum(D, 0.01 * H) ** 4
top = np.argsort(-W, 1)[:, :3]
for k, n in enumerate(names):
    vg = body.vertex_groups.new(name=n)
for i in range(len(V)):
    ws = W[i, top[i]]
    ws = ws / ws.sum()
    for k, w in zip(top[i], ws):
        if w > 0.02:
            body.vertex_groups[names[k]].add([i], float(w), "REPLACE")
body.parent = rig
mod = body.modifiers.new("Armature", "ARMATURE")
mod.object = rig
log("skinned")


# ---------------------------------------------------------------------------
# 4. animations
# ---------------------------------------------------------------------------
R = {b.name: b.matrix_local.to_3x3() for b in arm_data.bones}
for pb in rig.pose.bones:
    pb.rotation_mode = "QUATERNION"


def rot(name, q):
    """Rotation given in armature (rest) axes -> pose-bone local quaternion."""
    m = R[name]
    return (m.inverted() @ q.to_matrix() @ m).to_quaternion()


def ax(axis, deg):
    return Quaternion(Vector(axis), math.radians(deg))


def key(frame, pose):
    """pose: {bone: Quaternion in armature axes} plus optional ('hips_loc', Vector)."""
    for pb in rig.pose.bones:
        q = pose.get(pb.name, Quaternion())
        pb.rotation_quaternion = rot(pb.name, q)
        pb.keyframe_insert("rotation_quaternion", frame=frame)
        loc = pose.get(f"{pb.name}@loc")
        pb.location = (R[pb.name].inverted() @ loc) if loc is not None else Vector()
        if pb.name in ("hips", "root"):
            pb.keyframe_insert("location", frame=frame)


def arms_down(pose, swing_l=0.0, swing_r=0.0, elbow=12.0, down=72.0):
    pose["upperarm.L"] = ax((1, 0, 0), -swing_l) @ ax((0, 1, 0), down)
    pose["upperarm.R"] = ax((1, 0, 0), -swing_r) @ ax((0, 1, 0), -down)
    pose["forearm.L"] = ax((0, 0, 1), -elbow - max(swing_l, 0) * 0.6)
    pose["forearm.R"] = ax((0, 0, 1), elbow + max(swing_r, 0) * 0.6)
    pose["shoulder.L"] = ax((0, 1, 0), 6)
    pose["shoulder.R"] = ax((0, 1, 0), -6)
    return pose


def make_action(name, frames, fn):
    act = bpy.data.actions.new(name)
    rig.animation_data_create()
    rig.animation_data.action = act
    for f in range(0, frames + 1, 2):
        key(f, fn(f / frames))
    for fc in getattr(act, "fcurves", []):
        for kp in fc.keyframe_points:
            kp.interpolation = "BEZIER"
    act.use_fake_user = True
    track = rig.animation_data.nla_tracks.new()
    track.name = name
    track.strips.new(name, 0, act)
    rig.animation_data.action = None
    log(f"action {name}: {frames} frames")
    return act


def gait(t, amp, knee, bob, arm, lean):
    """One stride cycle (t in 0..1): legs swing, knees bend on the forward swing, arms counter-swing."""
    s = math.sin(2 * math.pi * t)
    c = math.cos(2 * math.pi * t)
    pose = {}
    pose["thigh.L"] = ax((1, 0, 0), -amp * s)
    pose["thigh.R"] = ax((1, 0, 0), amp * s)
    pose["shin.L"] = ax((1, 0, 0), knee * max(0.0, c) + 6)
    pose["shin.R"] = ax((1, 0, 0), knee * max(0.0, -c) + 6)
    pose["foot.L"] = ax((1, 0, 0), -8 * s)
    pose["foot.R"] = ax((1, 0, 0), 8 * s)
    pose["hips"] = ax((0, 0, 1), 5 * s) @ ax((1, 0, 0), lean)  # positive X = lean forward
    pose["chest"] = ax((0, 0, 1), -7 * s)
    pose["head"] = ax((0, 0, 1), 2 * s)
    pose["hips@loc"] = Vector((0, 0, -bob * abs(c) + bob * 0.5))
    return arms_down(pose, swing_l=arm * s, swing_r=-arm * s, elbow=14 + arm * 0.3)


def idle(t):
    br = math.sin(2 * math.pi * t * 2)
    pose = {"chest": ax((1, 0, 0), 1.5 * br), "spine": ax((0, 1, 0), 1.2 * math.sin(2 * math.pi * t)),
            "head": ax((0, 0, 1), 18 * math.sin(2 * math.pi * t)) @ ax((1, 0, 0), 4),
            "thigh.L": ax((1, 0, 0), -3), "thigh.R": ax((1, 0, 0), 2), "shin.L": ax((1, 0, 0), 5), "shin.R": ax((1, 0, 0), 3),
            "hips@loc": Vector((0.01 * math.sin(2 * math.pi * t), 0, -0.004 + 0.003 * br))}
    return arms_down(pose, swing_l=3 * br, swing_r=-2 * br)


def work(t):
    """Crouch and tend the crops: bend down, both hands reach to the ground and work."""
    w = 0.5 - 0.5 * math.cos(2 * math.pi * t)          # 0 standing -> 1 bent, back to 0
    dip = math.sin(2 * math.pi * t * 4) * w             # small hand movements while bent
    pose = {
        "hips": ax((1, 0, 0), 12 * w), "spine": ax((1, 0, 0), 28 * w), "chest": ax((1, 0, 0), 18 * w),  # bend forward
        "neck": ax((1, 0, 0), -8 * w), "head": ax((1, 0, 0), -12 * w),  # keep looking at the hands
        "thigh.L": ax((1, 0, 0), -55 * w), "thigh.R": ax((1, 0, 0), -40 * w),
        "shin.L": ax((1, 0, 0), 85 * w), "shin.R": ax((1, 0, 0), 70 * w),
        "foot.L": ax((1, 0, 0), -30 * w), "foot.R": ax((1, 0, 0), -30 * w),
        "hips@loc": Vector((0, 0.06 * w, -0.3 * w)),
    }
    return arms_down(pose, swing_l=55 * w + 10 * dip, swing_r=50 * w - 10 * dip, elbow=20 + 25 * w)


make_action("Idle", 4 * FPS, idle)
make_action("Walk", FPS, lambda t: gait(t, 26, 48, 0.03, 22, 3))
make_action("Run", 20, lambda t: gait(t, 42, 85, 0.05, 45, 10))
make_action("Work", 5 * FPS, work)


# ---------------------------------------------------------------------------
# 5. smaller textures, export
# ---------------------------------------------------------------------------
for img in bpy.data.images:
    if img.size[0] > TEX or img.size[1] > TEX:
        f = TEX / max(img.size)
        img.scale(max(1, int(img.size[0] * f)), max(1, int(img.size[1] * f)))
os.makedirs(os.path.dirname(DST), exist_ok=True)
bpy.ops.object.select_all(action="SELECT")
kw = dict(filepath=DST, export_format="GLB", use_selection=True, export_yup=True, export_apply=False,
          export_animations=True, export_skins=True, export_image_format="WEBP", export_image_quality=82,
          export_cameras=False, export_lights=False, export_def_bones=True)
for extra in (dict(export_animation_mode="NLA_TRACKS"), dict(export_animation_mode="ACTIONS"), {}):
    try:
        bpy.ops.export_scene.gltf(**kw, **extra)
        break
    except TypeError:
        continue
log(f"exported {DST} ({os.path.getsize(DST) / 1e6:.1f} MB)")
