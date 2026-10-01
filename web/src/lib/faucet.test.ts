// Run: node --test web/src/lib/faucet.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { FAUCET_GAS, FAUCET_USDG, parseFaucetRequest, planDrip } from "./faucet.ts";

const STOCKED = { faucetUsdg: 10n * FAUCET_USDG, faucetGas: 10n * FAUCET_GAS };

test("parseFaucetRequest checksums a valid address and rejects anything else", () => {
  const ok = parseFaucetRequest({ address: "0x1df04e205ea55c9528d44f42a58a81c4bd7cb0ed" });
  assert.deepEqual(ok, { ok: true, address: "0x1DF04E205ea55C9528d44F42A58A81C4BD7CB0ed" });
  for (const bad of [null, "x", {}, { address: 1 }, { address: "0x123" }]) {
    assert.equal(parseFaucetRequest(bad).ok, false, JSON.stringify(bad));
  }
});

test("planDrip sends USDG once per address and only the gas the recipient is missing", () => {
  assert.deepEqual(planDrip({ ...STOCKED, alreadyFunded: false, recipientGas: 0n }), { ok: true, usdg: FAUCET_USDG, gas: FAUCET_GAS });
  assert.deepEqual(planDrip({ ...STOCKED, alreadyFunded: false, recipientGas: FAUCET_GAS / 4n }), {
    ok: true,
    usdg: FAUCET_USDG,
    gas: FAUCET_GAS - FAUCET_GAS / 4n,
  });
  assert.deepEqual(planDrip({ ...STOCKED, alreadyFunded: false, recipientGas: 2n * FAUCET_GAS }), { ok: true, usdg: FAUCET_USDG, gas: 0n });
  const again = planDrip({ ...STOCKED, alreadyFunded: true, recipientGas: 0n });
  assert.equal(again.ok, false);
  assert.equal(!again.ok && again.status, 409);
});

test("planDrip reports an empty faucet instead of sending a partial drip", () => {
  const noUsdg = planDrip({ alreadyFunded: false, recipientGas: 0n, faucetUsdg: FAUCET_USDG - 1n, faucetGas: 10n * FAUCET_GAS });
  const noGas = planDrip({ alreadyFunded: false, recipientGas: 0n, faucetUsdg: FAUCET_USDG, faucetGas: FAUCET_GAS });
  for (const plan of [noUsdg, noGas]) {
    assert.equal(plan.ok, false);
    assert.equal(!plan.ok && plan.status, 503);
  }
});
