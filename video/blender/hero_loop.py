"""Seamless 10 s background loop for the landing page hero (not part of the demo video).

Composed like a cinematic hero backdrop: light from a luminous chain layer across the top third, a dark middle
for the headline, soft reflections low in the frame and black at the bottom for the stats. Withdrawals drift
down through the layers without stopping. Every motion is periodic in the loop length, so frame N+1 == frame 1.
  blender -b --factory-startup -P video/blender/hero_loop.py -- --out video/out/shots/hero_loop
"""
import math
import random
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib  # noqa: E402

SECONDS = 10.0
FRAMES = int(SECONDS * lib.FPS)
TOP_Z, MID_Z, LOW_Z = 6.3, 0.7, -0.75
FALL_FROM, FALL_TO = 7.4, -2.0  # capsules wrap outside the frame / under the floor
CAPSULES = 16


def build():
    scene = lib.reset_scene(SECONDS)
    scene.render.use_motion_blur = True
    scene.render.motion_blur_shutter = 0.6
    _layers()
    _capsules()
    lib.floor(-1.4, size=120, mat=lib.mat_floor_grid(spacing=1.4))
    # One broad, camera-invisible ceiling light: a smaller rim light reflects in the glass as a hard quad.
    lib.area_light("Ceiling", (0, 2, 9), (0, 1, 3), 2600, 14, "#cfe0ff").visible_camera = False

    cam, aim = lib.camera((0, -13.5, 1.15), (0, 0, 3.05), lens=30)
    cam.data.dof.use_dof = True
    cam.data.dof.focus_distance = 13.5
    cam.data.dof.aperture_fstop = 5.6
    # A slow periodic sway: closes exactly on itself after FRAMES.
    lib.drive(cam, "delta_location", 0, f"sin(frame*{2 * math.pi / FRAMES:.8f})*0.55")
    lib.drive(cam, "delta_location", 2, f"cos(frame*{2 * math.pi / FRAMES:.8f})*0.12")
    return scene


def _layers():
    glass = lib.mat_glass("LayerGlass", "#b9ceff", roughness=0.16)
    # The luminous top layer: the source of light in the frame.
    lib.box("TopLayer", (46, 16, 0.3), (0, -4.0, TOP_Z), glass, bevel=0.05)
    glow = _pool_of_light("TopGlow", "#dbe7ff", peak=3.6, floor=0.18, half_width=15.0)
    lib.box("TopGlowSheet", (45, 15, 0.02), (0, -4.0, TOP_Z + 0.25), glow, bevel=0)
    lib.edge_frame("TopEdge", (46, 16, 0.3), (0, -4.0, TOP_Z), lib.mat_emission("TopEdgeGlow", lib.COLORS["l3"], 7.0), 0.03)
    # Two dimmer layers below: the chains the withdrawal passes through.
    for name, z, color, strength in (("Mid", MID_Z, "arb", 3.0), ("Low", LOW_Z, "eth", 2.4)):
        lib.box(f"{name}Layer", (13, 7, 0.2), (0, 1.0, z), glass, bevel=0.05)
        lib.edge_frame(f"{name}Edge", (13, 7, 0.2), (0, 1.0, z), lib.mat_emission(f"{name}EdgeGlow", lib.COLORS[color], strength), 0.022)


def _pool_of_light(name: str, color: str, *, peak: float, floor: float, half_width: float):
    """Emission that is brightest along the centre line and falls off toward the sides (object-space X)."""
    mat = lib.mat_emission(name, color, peak)
    nt = mat.node_tree
    coord = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(coord.outputs["Object"], sep.inputs["Vector"])
    chain = sep.outputs["X"]
    for operation, value in (("ABSOLUTE", None), ("DIVIDE", half_width), ("SUBTRACT", None), ("POWER", 1.7), ("MULTIPLY", peak), ("ADD", floor)):
        node = nt.nodes.new("ShaderNodeMath")
        node.operation = operation
        node.use_clamp = operation in ("DIVIDE", "SUBTRACT")
        if operation == "SUBTRACT":  # 1 - x
            node.inputs[0].default_value = 1.0
            nt.links.new(chain, node.inputs[1])
        else:
            nt.links.new(chain, node.inputs[0])
            if value is not None:
                node.inputs[1].default_value = value
        chain = node.outputs[0]
    nt.links.new(chain, nt.nodes["Emission"].inputs["Strength"])
    return mat


def _capsules():
    """Glowing withdrawals falling at constant speed; each wraps once per loop, so the loop is seamless."""
    random.seed(11)
    span = FALL_FROM - FALL_TO
    for i in range(CAPSULES):
        side = -1 if i % 2 else 1
        # Keep the very centre of the frame calm for the headline: spawn toward the sides and at depth.
        x = side * random.uniform(4.2, 9.0)
        y = random.uniform(-0.5, 5.0)
        mat = lib.mat_emission(f"Capsule{i}", "#7fb7ff", random.uniform(1.4, 3.0))
        pill = lib.sphere(f"Capsule{i}", random.uniform(0.07, 0.12), (x, y, FALL_FROM), mat, scale=(1, 1, 1.8))
        phase = (i + random.random()) / CAPSULES
        lib.drive(pill, "location", 2, f"{FALL_FROM} - ((frame/{FRAMES} + {phase:.4f}) % 1) * {span}")


if __name__ == "__main__":
    lib.render_from_cli(build())
