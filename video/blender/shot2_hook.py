"""Shot 2 — "The hook nobody used": a sealed gate engraved transferExitAndCall(), dust in the air; it opens at the end.

Narration: 03-hook. The 2D overlay "WithdrawRedirected on mainnet: 0" is composited later.
"""
import random
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib  # noqa: E402

SECONDS = 17.0
OPEN_START = lib.seconds(13.6)
OPEN_END = lib.seconds(16.2)
DOOR = (2.1, 0.32, 4.6)


def build():
    scene = lib.reset_scene(SECONDS)
    lib.floor(0.0)
    _gate()
    _reveal()
    _dust(90)
    lib.area_light("Key", (4, -7, 7), (0, 0, 2.3), 900, 5, "#dfe8ff")
    lib.area_light("Top", (0, -2.5, 7.5), (0, 0, 2.3), 700, 6, "#cfe0ff")
    lib.area_light("Rim", (-6, -3, 6), (0, 0, 2.3), 260, 4, lib.COLORS["blue"])

    cam, aim = lib.camera((1.6, -13.5, 2.1), (0, 0, 2.4), lens=42)
    lib.key(cam, "location", 1, (1.6, -13.5, 2.1))
    lib.key(cam, "location", OPEN_START, (0.5, -9.4, 2.3))
    lib.key(cam, "location", scene.frame_end, (0.0, -8.2, 2.35))
    lib.key(aim, "location", 1, (0, 0, 2.4))
    lib.key(aim, "location", scene.frame_end, (0, 0, 2.3))
    return scene


def _gate():
    metal = lib.mat_principled("GateMetal", "#2c3546", metallic=0.85, roughness=0.42)
    frame_mat = lib.mat_principled("GateFrame", "#161b26", metallic=0.9, roughness=0.45)
    # Frame around the doorway
    lib.box("FrameTop", (4.9, 0.6, 0.35), (0, 0, DOOR[2] + 0.18), frame_mat)
    for side in (-1, 1):
        lib.box(f"FrameSide{side}", (0.35, 0.6, DOOR[2] + 0.35), (side * 2.28, 0, DOOR[2] / 2), frame_mat)

    engrave = lib.mat_emission("Engraving", lib.COLORS["amber"], 0.9)
    seam = lib.mat_emission("DoorEdge", lib.COLORS["blue"], 1.4)
    doors = []
    for side in (-1, 1):
        door = lib.box(f"Door{side}", DOOR, (side * DOOR[0] / 2, 0, DOOR[2] / 2), metal, bevel=0.03)
        outline = lib.edge_frame(f"DoorEdge{side}", (DOOR[0] - 0.08, DOOR[1] + 0.01, DOOR[2] - 0.08), (0, 0, 0), seam, 0.015)
        outline.parent = door
        lib.key(door, "location", OPEN_START, (side * DOOR[0] / 2, 0, DOOR[2] / 2))
        lib.key(door, "location", OPEN_END, (side * (DOOR[0] / 2 + 1.95), 0, DOOR[2] / 2))
        doors.append(door)

    # Engraving spans the seam: each half is parented to its door (door-local coordinates) and moves with it.
    halves = [("transferExit", doors[0], "RIGHT", DOOR[0] / 2 - 0.005), ("AndCall()", doors[1], "LEFT", -DOOR[0] / 2 + 0.005)]
    for body, door, align, local_x in halves:
        txt = lib.text(body, (0, 0, 0), 0.36, engrave, align=align, name=f"Eng_{body}")
        txt.parent = door
        txt.location = (local_x, -DOOR[1] / 2 - 0.01, 2.55 - DOOR[2] / 2)
    sub = lib.mat_emission("Sub", lib.COLORS["muted"], 0.7)
    lib.text("L1ArbitrumExtendedGateway", (0, -0.31, DOOR[2] + 0.18), 0.17, sub, font="JetBrainsMono-Regular.ttf")
    glow = lib.emission_strength_socket(engrave)
    lib.key_socket(glow, OPEN_START - 30, 0.9)
    lib.key_socket(glow, OPEN_START, 6.0)


def _reveal():
    """Behind the gate: the withdrawal itself, freed when the doors open, over a grid receding into the dark."""
    pill_mat = lib.mat_emission("FreedCapsule", "#6fb0ff", 5.0)
    pill = lib.sphere("FreedCapsule", 0.26, (0, 1.4, 2.35), pill_mat, scale=(1, 1, 1.7))
    lib.drive(pill, "delta_location", 2, "sin(frame/16)*0.05")
    bulb = lib.point_light("FreedLight", (0, 1.0, 2.35), 0.0, lib.COLORS["blue"], radius=0.3)
    lib.key(bulb.data, "energy", OPEN_START, 0.0)
    lib.key(bulb.data, "energy", OPEN_END, 400.0)


def _dust(count: int):
    """Motes drifting in front of the unused gate (simple-expression drivers, no simulation)."""
    random.seed(7)
    mote = lib.mat_emission("Dust", "#c9d3e6", 0.7)
    template = lib.sphere("Mote", 0.008, (0, 0, 0), mote)
    motes = [template]
    for _ in range(count - 1):  # linked duplicates of a clean template (share one mesh)
        copy = template.copy()
        bpy.context.scene.collection.objects.link(copy)
        motes.append(copy)
    for m in motes:
        m.location = (random.uniform(-3.5, 3.5), random.uniform(-4.5, -0.6), random.uniform(0.2, 4.6))
        phase, speed = random.uniform(0, 6.28), random.uniform(40, 90)
        lib.drive(m, "delta_location", 0, f"sin(frame/{speed:.1f}+{phase:.2f})*0.18")
        lib.drive(m, "delta_location", 2, f"cos(frame/{speed * 1.3:.1f}+{phase:.2f})*0.14")


if __name__ == "__main__":
    lib.render_from_cli(build())
