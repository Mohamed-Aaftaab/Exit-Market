"""Shot 1 — "The lock": a withdrawal leaves the L3 and is caught in the 6.4-day challenge ring.

Narration: 01-lock + 02-stakes (the 2D counters are composited on top of this shot later).
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib  # noqa: E402
import parts  # noqa: E402

SECONDS = 27.0
RING_Z = 3.55
CAPSULE_START_Z = 5.06  # resting on the L3 slab
LOCK = lib.seconds(5.0)  # the capsule is caught ("...takes six point four days")


def build():
    scene = lib.reset_scene(SECONDS)
    lib.floor(-0.3)
    parts.layer_stack()
    parts.base_lighting()

    pill, pill_mat = parts.capsule((0, 0, CAPSULE_START_Z))
    lib.key(pill, "location", 1, (0, 0, CAPSULE_START_Z))
    lib.key(pill, "location", lib.seconds(2.4), (0, 0, CAPSULE_START_Z))
    lib.key(pill, "location", LOCK, (0, 0, RING_Z))
    lib.drive(pill, "delta_location", 2, "sin(frame/18)*0.035")  # trapped: bobbing in place

    ring, ring_mat, tick_mats = parts.challenge_ring((0, 0, RING_Z))
    lib.key(ring, "scale", 1, (0.001, 0.001, 0.001))
    lib.key(ring, "scale", LOCK - 20, (0.001, 0.001, 0.001))
    lib.key(ring, "scale", LOCK, (1, 1, 1))
    glow = lib.emission_strength_socket(ring_mat)
    lib.key_socket(glow, LOCK, 4.0)
    lib.key_socket(glow, LOCK + 8, 22.0)
    lib.key_socket(glow, LOCK + 30, 6.0)
    _count_down(tick_mats)

    label_mat = lib.mat_emission("RingLabel", lib.COLORS["amber"], 0.0)
    facing = (math.radians(90), 0, 0.45)  # same plane as the ring, facing the camera path
    lib.text("6.4 DAYS", (1.2, 0.5, RING_Z + 0.1), 0.34, label_mat, rotation=facing, align="LEFT")
    lib.text("CHALLENGE PERIOD", (1.2, 0.5, RING_Z - 0.22), 0.13, label_mat, rotation=facing, align="LEFT",
             font="JetBrainsMono-Regular.ttf")
    lib.key_socket(lib.emission_strength_socket(label_mat), LOCK + 10, 0.0)
    lib.key_socket(lib.emission_strength_socket(label_mat), LOCK + 35, 2.2)

    cam, aim = lib.camera((10.5, -12.5, 8.2), (0, 0, 2.6), lens=38)
    lib.key(cam, "location", 1, (10.5, -12.5, 8.2))
    lib.key(aim, "location", 1, (0, 0, 2.6))
    lib.key(cam, "location", LOCK, (6.2, -8.8, 5.4))
    lib.key(aim, "location", LOCK, (0, 0, RING_Z))
    lib.key(cam, "location", scene.frame_end, (3.9, -7.9, 4.3))
    lib.key(aim, "location", scene.frame_end, (0.35, 0, RING_Z - 0.1))
    return scene


def _count_down(tick_mats):
    """After the lock, ticks dim one by one, slowly: time passing, and far from over."""
    for i, mat in enumerate(tick_mats[:9]):
        socket = lib.emission_strength_socket(mat)
        start = LOCK + 45 + i * 70
        lib.key_socket(socket, start, 5.0)
        lib.key_socket(socket, start + 40, 0.25)


if __name__ == "__main__":
    lib.render_from_cli(build())
