"""Shot 5 — "Now instant": the same three layers as shot 1, but the withdrawal passes straight through without
stopping, and the title rises. Narration: 10-close. The tagline is composited later.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib  # noqa: E402
import parts  # noqa: E402

SECONDS = 13.0
TOP_Z = 5.06
LAND_Z = 0.4 + 0.11 + 0.34  # resting on the Ethereum slab
DROP_START, DROP_END = 30, 62
TRAIL = 5
TITLE_IN = 150


def build():
    scene = lib.reset_scene(SECONDS)
    lib.floor(-0.3)
    parts.layer_stack()
    parts.base_lighting()
    _drop()
    _arrival_flash()
    _title()
    cam, aim = lib.camera((10.5, -12.5, 8.2), (0, 0, 2.6), lens=38)
    lib.key(cam, "location", 1, (10.5, -12.5, 8.2))
    lib.key(aim, "location", 1, (0, 0, 2.6))
    lib.key(cam, "location", 110, (7.5, -13.5, 5.2))
    lib.key(cam, "location", scene.frame_end, (0.0, -17.5, 4.9))
    lib.key(aim, "location", scene.frame_end, (0, 0, 3.9))
    return scene


def _drop():
    pill, _ = parts.capsule((0, 0, TOP_Z))
    lib.key(pill, "location", DROP_START, (0, 0, TOP_Z))
    lib.key(pill, "location", DROP_END, (0, 0, LAND_Z))
    for i in range(1, TRAIL + 1):  # motion trail: fading copies a few frames behind
        mat = lib.mat_emission(f"Trail{i}", "#6fb0ff", 0.0)
        ghost = lib.sphere(f"Trail{i}", 0.2 - i * 0.02, (0, 0, TOP_Z), mat, scale=(1, 1, 1.7))
        lib.key(ghost, "location", DROP_START + i * 2, (0, 0, TOP_Z))
        lib.key(ghost, "location", DROP_END + i * 2, (0, 0, LAND_Z))
        sock = lib.emission_strength_socket(mat)
        lib.key_socket(sock, DROP_START, 0.0)
        lib.key_socket(sock, DROP_START + 4, 4.0 / i)
        lib.key_socket(sock, DROP_END + i * 2 + 6, 0.0)


def _arrival_flash():
    edge = lib.bpy.data.materials["Edge_eth"]
    sock = lib.emission_strength_socket(edge)
    lib.key_socket(sock, DROP_END - 1, 6.0)
    lib.key_socket(sock, DROP_END + 4, 30.0)
    lib.key_socket(sock, DROP_END + 30, 6.0)
    color = edge.node_tree.nodes["Emission"].inputs["Color"]
    lib.key_socket(color, DROP_END - 1, lib.lin(lib.COLORS["eth"]))
    lib.key_socket(color, DROP_END + 4, lib.lin(lib.COLORS["green"]))
    lib.key_socket(color, DROP_END + 60, lib.lin(lib.COLORS["eth"]))


def _title():
    mat = lib.mat_emission("Title", lib.COLORS["ink"], 0.0)
    lib.text("EXIT MARKET", (0, -3.0, 6.9), 1.05, mat, font="Inter-Bold.ttf", extrude=0.04)
    sock = lib.emission_strength_socket(mat)
    lib.key_socket(sock, TITLE_IN, 0.0)
    lib.key_socket(sock, TITLE_IN + 35, 3.2)


if __name__ == "__main__":
    lib.render_from_cli(build())
