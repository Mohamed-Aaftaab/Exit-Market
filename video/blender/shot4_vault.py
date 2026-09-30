"""Shot 4 — "The vault": the withdrawal flies into the ERC-4626 vault, USDG streams to the seller right away, the
challenge clock runs out inside the vault, the keeper executes and the vault collects. Narration: 07-vault.
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lib  # noqa: E402
import parts  # noqa: E402

SECONDS = 15.0
VAULT = (0.0, 0.0, 2.05)
VAULT_SIZE = 2.7
WALLET = (5.9, -0.3, 1.2)
ARRIVE = 75
COINS = 10
CONFIRM = 300  # challenge period over: keeper executes, vault collects


def build():
    scene = lib.reset_scene(SECONDS)
    lib.floor(0.0)
    parts.base_lighting(target=VAULT)
    _vault()
    _capsule_into_vault()
    _coins()
    _wallet()
    cam, aim = lib.camera((3.8, -12.0, 3.9), (2.2, 0, 1.9), lens=36)
    lib.key(cam, "location", 1, (3.8, -12.0, 3.9))
    lib.key(cam, "location", scene.frame_end, (3.2, -11.4, 3.5))
    lib.key(aim, "location", 1, (2.2, 0, 1.9))
    lib.key(aim, "location", scene.frame_end, (2.6, 0, 1.8))
    return scene


def _vault():
    glass = lib.mat_glass("VaultGlass", "#9fb8e8", roughness=0.22)
    lib.box("Vault", (VAULT_SIZE,) * 3, VAULT, glass, bevel=0.08)
    edge = lib.mat_emission("VaultEdge", lib.COLORS["blue"], 5.0)
    lib.edge_frame("VaultEdge", (VAULT_SIZE + 0.04,) * 3, VAULT, edge, 0.03)
    color = edge.node_tree.nodes["Emission"].inputs["Color"]
    lib.key_socket(color, CONFIRM, lib.lin(lib.COLORS["blue"]))
    lib.key_socket(color, CONFIRM + 12, lib.lin(lib.COLORS["green"]))
    label = lib.mat_emission("VaultLabel", lib.COLORS["ink"], 2.0)
    lib.text("EXIT VAULT  ·  ERC-4626", (VAULT[0], -VAULT_SIZE / 2, VAULT[2] + VAULT_SIZE / 2 + 0.35), 0.24, label)

    ring, ring_mat, tick_mats = parts.challenge_ring(VAULT, major=0.62, tilt=(math.pi / 2, 0, 0.3))
    for i, mat in enumerate(tick_mats):  # the clock runs out inside the vault, not in the seller's wallet
        sock = lib.emission_strength_socket(mat)
        start = ARRIVE + 20 + i * 8
        lib.key_socket(sock, start, 5.0)
        lib.key_socket(sock, start + 10, 0.2)
    ring_color = ring_mat.node_tree.nodes["Emission"].inputs["Color"]
    lib.key_socket(ring_color, CONFIRM, lib.lin(lib.COLORS["amber"]))
    lib.key_socket(ring_color, CONFIRM + 12, lib.lin(lib.COLORS["green"]))

    done = lib.mat_emission("Collected", lib.COLORS["green"], 0.0)
    lib.text("EXECUTED BY THE KEEPER  ·  COLLECTED", (VAULT[0], -VAULT_SIZE / 2, VAULT[2] - VAULT_SIZE / 2 - 0.35),
             0.17, done)
    lib.key_socket(lib.emission_strength_socket(done), CONFIRM + 5, 0.0)
    lib.key_socket(lib.emission_strength_socket(done), CONFIRM + 25, 3.0)


def _capsule_into_vault():
    pill, _ = parts.capsule((-6.8, -0.6, 2.9))
    lib.key(pill, "location", 1, (-6.8, -0.6, 2.9))
    lib.key(pill, "location", 40, (-3.2, -0.9, 3.3))
    lib.key(pill, "location", ARRIVE, VAULT)
    lib.key(pill, "scale", ARRIVE, (1, 1, 1.7))
    lib.key(pill, "scale", CONFIRM, (1, 1, 1.7))
    lib.key(pill, "scale", CONFIRM + 8, (1.35, 1.35, 2.3))
    lib.key(pill, "scale", CONFIRM + 20, (0.001, 0.001, 0.001))  # executed through the Outbox


def _coins():
    coin_mat = lib.mat_principled("Coin", "#1f6b4c", metallic=0.7, roughness=0.25, emission=lib.COLORS["green"],
                                  emission_strength=2.5)
    start_x = VAULT[0] + VAULT_SIZE / 2 - 0.2
    for i in range(COINS):
        coin = lib.cylinder(f"Coin{i}", 0.24, 0.06, (start_x, 0, VAULT[2]), coin_mat, rotation=(math.pi / 2, 0, 0.7))
        t0 = ARRIVE + 12 + i * 11
        lib.key(coin, "scale", t0 - 1, (0.001, 0.001, 0.001))
        lib.key(coin, "scale", t0, (1, 1, 1))
        lib.key(coin, "location", t0, (start_x, 0, VAULT[2]))
        lib.key(coin, "location", t0 + 34, (WALLET[0] - 0.4, WALLET[1], WALLET[2] + 0.15 + i * 0.012))
        lib.key(coin, "scale", t0 + 34, (1, 1, 1))
        lib.key(coin, "scale", t0 + 38, (0.001, 0.001, 0.001))


def _wallet():
    body = lib.mat_principled("WalletBody", "#0f1a16", metallic=0.3, roughness=0.3)
    lib.box("Wallet", (1.5, 0.25, 1.2), WALLET, body, bevel=0.06)
    edge = lib.mat_emission("WalletEdge", lib.COLORS["green"], 1.0)
    lib.edge_frame("WalletEdge", (1.53, 0.28, 1.23), WALLET, edge, 0.02)
    pulse = lib.emission_strength_socket(edge)
    lib.key_socket(pulse, ARRIVE + 40, 1.0)
    lib.key_socket(pulse, ARRIVE + 60, 6.0)
    label = lib.mat_emission("WalletLabel", lib.COLORS["green"], 2.4)
    lib.text("SELLER  ·  USDG NOW", (WALLET[0], WALLET[1] - 0.14, WALLET[2] + 0.95), 0.2, label)


if __name__ == "__main__":
    lib.render_from_cli(build())
