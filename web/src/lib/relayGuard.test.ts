// Run: node --test web/src/lib/relayGuard.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { getAddress } from "viem";
import deployment from "../../../deployments/arbitrumSepolia.json" with { type: "json" };
import { XAI_TESTNET } from "../../../scripts/lib/networks.ts";
import { MIN_RELAYER_FEE, allowRequest, parseRelayRequest, runExclusive } from "./relayGuard.ts";

// The relayer pins the live gateway and vault, so the test uses the same sources the app does.
const GATEWAY = XAI_TESTNET.tokenBridge.parentErc20Gateway;
const VAULT = getAddress(deployment.vault);
const expect = { gateway: GATEWAY, buyer: VAULT } as const;

function body(overrides: Record<string, unknown> = {}) {
  return {
    withdrawalTx: `0x${"ab".repeat(32)}`,
    signature: `0x${"cd".repeat(65)}`,
    order: {
      gateway: GATEWAY,
      exitNum: "5",
      buyer: VAULT,
      minProceeds: "9880000",
      relayerFee: MIN_RELAYER_FEE.toString(),
      deadline: String(Math.floor(Date.now() / 1000) + 3600),
      ...overrides,
    },
  };
}

test("accepts a well-formed order for the pinned gateway and buyer", () => {
  const parsed = parseRelayRequest(body(), expect);
  assert.equal(parsed.ok, true);
});

test("rejects non-object bodies (JSON null, arrays of junk) without throwing", () => {
  for (const raw of [null, 42, "x", []]) assert.equal(parseRelayRequest(raw, expect).ok, false);
});

test("rejects an attacker-chosen buyer before any RPC work", () => {
  const parsed = parseRelayRequest(body({ buyer: "0x000000000000000000000000000000000000dEaD" }), expect);
  assert.deepEqual(parsed, { ok: false, error: "Unsupported buyer" });
});

test("rejects free-riding orders below the relayer fee floor", () => {
  const parsed = parseRelayRequest(body({ relayerFee: "0" }), expect);
  assert.deepEqual(parsed, { ok: false, error: "Relayer fee below minimum" });
});

test("rejects negative, fractional and oversized numbers", () => {
  for (const exitNum of ["-1", "1.5", "1e3", "9".repeat(80)]) {
    assert.equal(parseRelayRequest(body({ exitNum }), expect).ok, false, exitNum);
  }
});

test("rejects expired and far-future deadlines", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(parseRelayRequest(body({ deadline: String(now - 1) }), expect).ok, false);
  assert.equal(parseRelayRequest(body({ deadline: String(now + 30 * 86400) }), expect).ok, false);
});

test("rate limits a client after 20 requests per minute and recovers after the window", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 20; i++) assert.equal(allowRequest("ip-1", t0 + i), true);
  assert.equal(allowRequest("ip-1", t0 + 100), false);
  assert.equal(allowRequest("ip-2", t0 + 100), true, "other clients are unaffected");
  assert.equal(allowRequest("ip-1", t0 + 61_000), true);
});

test("dedupes concurrent settlements of the same withdrawal and serializes the rest", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const first = runExclusive("tx-a", async () => {
    await gate;
    order.push("a");
    return "a";
  });
  assert.equal(await runExclusive("tx-a", async () => "dup"), undefined, "same key while in flight is skipped");
  const second = runExclusive("tx-b", async () => {
    order.push("b");
    return "b";
  });
  release();
  assert.deepEqual(await Promise.all([first, second]), ["a", "b"]);
  assert.deepEqual(order, ["a", "b"], "b waited for a");
});
