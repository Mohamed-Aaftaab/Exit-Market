"""Scene parts reused across shots: the chain-layer stack, the withdrawal capsule, the challenge-period ring."""
import math

import lib

LAYER_SIZE = (6.4, 4.2, 0.22)
# (label, edge color key, z)
LAYERS = [
    ("XAI  ·  ORBIT L3", "l3", 4.6),
    ("ARBITRUM ONE", "arb", 2.5),
    ("ETHEREUM", "eth", 0.4),
]


def layer_stack() -> dict:
    """Three tinted glass slabs with glowing edges and front labels. Returns {label: slab}."""
    glass = lib.mat_glass("LayerGlass", "#a9c4ff", roughness=0.18)
    label_mat = lib.mat_emission("LayerLabel", lib.COLORS["ink"], 1.6)
    slabs = {}
    for label, color_key, z in LAYERS:
        slab = lib.box(f"Layer_{label}", LAYER_SIZE, (0, 0, z), glass, bevel=0.05)
        edge = lib.mat_emission(f"Edge_{color_key}", lib.COLORS[color_key], 6.0)
        lib.edge_frame(f"Edge_{label}", LAYER_SIZE, (0, 0, z), edge, thickness=0.025)
        lib.text(label, (-LAYER_SIZE[0] / 2 + 0.1, -LAYER_SIZE[1] / 2, z + 0.34), 0.3, label_mat,
                 align="LEFT", name=f"Label_{label}")
        slabs[label] = slab
    return slabs


def capsule(loc: tuple, *, glow=5.0, light=True):
    """The withdrawal: a glowing pill, with an inner light that tints nearby glass."""
    mat = lib.mat_emission("CapsuleGlow", "#6fb0ff", glow)
    pill = lib.sphere("Capsule", 0.2, loc, mat, scale=(1, 1, 1.7))
    if light:
        bulb = lib.point_light("CapsuleLight", loc, 120.0, lib.COLORS["blue"], radius=0.2)
        bulb.parent = pill
        bulb.location = (0, 0, 0)
    return pill, mat


def challenge_ring(loc: tuple, *, ticks=24, major=0.78, tilt=(math.pi / 2, 0.0, 0.45)):
    """Amber clock-face ring with tick marks (the 6.4-day challenge period), stood upright on a pivot facing the
    camera. Returns (ring, ring material, tick materials)."""
    pivot = lib.bpy.data.objects.new("RingPivot", None)
    lib.bpy.context.scene.collection.objects.link(pivot)
    pivot.location = loc
    pivot.rotation_euler = tilt
    ring_mat = lib.mat_emission("RingGlow", lib.COLORS["amber"], 4.0)
    ring = lib.torus("ChallengeRing", major, 0.035, (0, 0, 0), ring_mat)
    ring.parent = pivot
    tick_mats = []
    for i in range(ticks):
        angle = 2 * math.pi * i / ticks
        mat = lib.mat_emission(f"Tick{i}", lib.COLORS["amber"], 5.0)
        tick = lib.box(f"Tick{i}", (0.14, 0.035, 0.035), (0, 0, 0), mat, bevel=0)
        tick.parent = ring  # ring-relative placement, so the ticks turn with the ring
        tick.location = ((major + 0.14) * math.cos(angle), (major + 0.14) * math.sin(angle), 0)
        tick.rotation_euler = (0, 0, angle)
        tick_mats.append(mat)
    return ring, ring_mat, tick_mats


def base_lighting(target=(0, 0, 2.2)) -> None:
    lib.area_light("Key", (7, -8, 9), target, 900, 6, "#dfe8ff")
    lib.area_light("Rim", (-8, 6, 6), target, 700, 5, lib.COLORS["blue"])
    lib.area_light("Fill", (0, -12, 1.5), target, 150, 8, "#ffffff")
