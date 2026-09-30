"""Shot 3 — "The proof": the withdrawal's leaf, its Merkle path to the send root, the root inside a still-pending
rollup node, and the three on-chain checks. Narration: 04-proof.
"""
import sys
from pathlib import Path

from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib  # noqa: E402

SECONDS = 19.0
LEAF = 5  # our withdrawal's index in the (toy) send tree
LEVEL_Z = [0.8, 2.2, 3.6, 5.0]
NODE_BLOCK_Z = 6.7
CHECKS_X = 5.4
# (frame the path reaches this level, frame the next edge starts) — paced to "rebuilds ... proves ... checks"
PATH_FRAMES = [45, 105, 150, 195]


def build():
    scene = lib.reset_scene(SECONDS)
    lib.floor(-0.1)
    lib.area_light("Key", (4, -9, 9), (1, 0, 3), 700, 7, "#dfe8ff")
    lib.area_light("Rim", (-7, 4, 7), (0, 0, 3), 400, 5, lib.COLORS["blue"])

    positions = _tree_positions()
    path = _path_indices()
    siblings = [(level, idx ^ 1) for level, idx in path[:-1]]
    _nodes(positions, path, siblings)
    _edges(positions, path)
    _pending_node(positions[3][0])
    _checklist()
    _camera(scene, positions)
    return scene


def _tree_positions():
    leaves = [Vector((-4.55 + i * 1.3, 0, LEVEL_Z[0])) for i in range(8)]
    levels = [leaves]
    for z in LEVEL_Z[1:]:
        prev = levels[-1]
        levels.append([Vector(((prev[2 * i].x + prev[2 * i + 1].x) / 2, 0, z)) for i in range(len(prev) // 2)])
    return levels


def _path_indices():
    return [(level, LEAF >> level) for level in range(4)]


def _nodes(positions, path, siblings):
    body = lib.mat_principled("NodeBody", "#141a26", metallic=0.3, roughness=0.35)
    dim = lib.mat_emission("NodeDim", lib.COLORS["muted"], 0.5)
    on_path = dict(path)
    for level, row in enumerate(positions):
        for idx, pos in enumerate(row):
            size = 0.5 if level == 0 else 0.56
            lib.box(f"Node{level}_{idx}", (size, size, size), tuple(pos), body, bevel=0.05)
            if on_path.get(level) == idx:
                mat = lib.mat_emission(f"PathNode{level}", lib.COLORS["amber" if level == 0 else "green"], 0.5)
                sock = lib.emission_strength_socket(mat)
                lit = PATH_FRAMES[level] if level else 25
                lib.key_socket(sock, lit - 1, 0.5)
                lib.key_socket(sock, lit + 6, 14.0)
                lib.key_socket(sock, lit + 24, 7.0)
            elif (level, idx) in siblings:
                mat = lib.mat_emission(f"Proof{level}", lib.COLORS["blue"], 0.5)
                sock = lib.emission_strength_socket(mat)
                lib.key_socket(sock, 55, 0.5)
                lib.key_socket(sock, 75, 5.0)
            else:
                mat = dim
            lib.edge_frame(f"NodeEdge{level}_{idx}", (size + 0.02,) * 3, tuple(pos), mat, 0.02)
    label = lib.mat_emission("LeafLabel", lib.COLORS["amber"], 0.0)
    lib.text("YOUR WITHDRAWAL", tuple(positions[0][LEAF] + Vector((0, -0.3, -0.62))), 0.2, label)
    lib.key_socket(lib.emission_strength_socket(label), 25, 0.0)
    lib.key_socket(lib.emission_strength_socket(label), 45, 3.0)
    proof = lib.mat_emission("ProofLabel", lib.COLORS["blue"], 0.0)
    lib.text("PROOF", tuple(positions[0][LEAF ^ 1] + Vector((0, -0.3, -0.62))), 0.2, proof)
    lib.key_socket(lib.emission_strength_socket(proof), 55, 0.0)
    lib.key_socket(lib.emission_strength_socket(proof), 75, 3.0)


def _edges(positions, path):
    dim = lib.mat_emission("EdgeDim", lib.COLORS["muted"], 0.35)
    on_path = dict(path)
    for level in range(3):
        for idx, child in enumerate(positions[level]):
            parent = positions[level + 1][idx // 2]
            a, b = child + Vector((0, 0, 0.3)), parent - Vector((0, 0, 0.3))
            mat = dim
            if on_path.get(level) == idx:
                mat = lib.mat_emission(f"PathEdge{level}", lib.COLORS["green"], 0.35)
                sock = lib.emission_strength_socket(mat)
                start = PATH_FRAMES[level] + 10
                lib.key_socket(sock, start, 0.35)
                lib.key_socket(sock, PATH_FRAMES[level + 1], 9.0)
            lib.rod(f"Edge{level}_{idx}", a, b, 0.022, mat)


def _pending_node(root: Vector):
    """The rollup node (or BOLD assertion) that commits to the send root: still inside its challenge period."""
    body = lib.mat_principled("PendingBody", "#1c1710", metallic=0.2, roughness=0.3)
    size = (3.6, 1.1, 0.42)
    lib.box("PendingNode", size, (root.x, 0, NODE_BLOCK_Z), body, bevel=0.05)
    edge = lib.mat_emission("PendingEdge", lib.COLORS["amber"], 1.0)
    lib.edge_frame("PendingEdge", (size[0] + 0.03, size[1] + 0.03, size[2] + 0.03), (root.x, 0, NODE_BLOCK_Z), edge, 0.025)
    lib.key_socket(lib.emission_strength_socket(edge), 215, 1.0)
    lib.key_socket(lib.emission_strength_socket(edge), 235, 7.0)
    label = lib.mat_emission("PendingLabel", lib.COLORS["amber"], 2.5)
    lib.text("PENDING ROLLUP NODE", (root.x, -0.57, NODE_BLOCK_Z), 0.2, label)
    beam = lib.mat_emission("RootBeam", lib.COLORS["green"], 0.0)
    lib.rod("RootBeam", root + Vector((0, 0, 0.32)), Vector((root.x, 0, NODE_BLOCK_Z - 0.22)), 0.03, beam)
    lib.key_socket(lib.emission_strength_socket(beam), 200, 0.0)
    lib.key_socket(lib.emission_strength_socket(beam), 225, 10.0)
    sub = lib.mat_emission("PendingSub", lib.COLORS["muted"], 1.4)
    lib.text("send root committed  ·  challenge period running", (root.x, -0.57, NODE_BLOCK_Z + 0.42), 0.13, sub,
             font="JetBrainsMono-Regular.ttf")


def _checklist():
    items = ["WITHDRAWAL LEAF REBUILT", "ROOT IN A PENDING NODE", "NOT YET CLAIMED"]
    for i, body in enumerate(items):
        z = 5.2 - i * 0.85
        appear = 250 + i * 45
        check = lib.mat_emission(f"Check{i}", lib.COLORS["green"], 0.0)
        lib.check_mark(f"Check{i}", (CHECKS_X, -0.2, z), 0.42, check)
        text_mat = lib.mat_emission(f"CheckText{i}", lib.COLORS["ink"], 0.0)
        lib.text(body, (CHECKS_X + 0.45, -0.2, z), 0.27, text_mat, align="LEFT")
        for mat, peak in ((check, 9.0), (text_mat, 2.2)):
            sock = lib.emission_strength_socket(mat)
            lib.key_socket(sock, appear, 0.0)
            lib.key_socket(sock, appear + 12, peak)


def _camera(scene, positions):
    leaf = positions[0][LEAF]
    cam, aim = lib.camera((leaf.x + 0.9, -4.6, 1.3), (leaf.x, 0, 1.0), lens=36)
    lib.key(cam, "location", 1, (leaf.x + 0.9, -4.6, 1.3))
    lib.key(aim, "location", 1, (leaf.x, 0, 1.0))
    lib.key(cam, "location", PATH_FRAMES[3], (1.6, -10.5, 4.3))
    lib.key(aim, "location", PATH_FRAMES[3], (0.6, 0, 4.4))
    lib.key(cam, "location", 260, (2.4, -16.2, 4.1))
    lib.key(aim, "location", 260, (2.4, 0, 3.7))
    lib.key(cam, "location", scene.frame_end, (2.1, -15.2, 4.2))
    lib.key(aim, "location", scene.frame_end, (2.4, 0, 3.8))


if __name__ == "__main__":
    lib.render_from_cli(build())
