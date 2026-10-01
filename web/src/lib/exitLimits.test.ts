// Run: node --test web/src/lib/exitLimits.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MIN_GASLESS_AMOUNT, fastExitMinimum, proofBlocker, vaultSizeRefusal } from "./exitLimits.ts";

const ONE_USDG = 1_000_000n;
const ALL_PASS = { ownerIsSeller: true, minimalPath: true, unspent: true, rootValid: true };

test("a fast exit must clear both the relayer-fee floor and the vault's minimum", () => {
  assert.equal(fastExitMinimum(ONE_USDG), ONE_USDG); // the live vault: 1 USDG beats the ~0.02 USDG fee floor
  assert.equal(fastExitMinimum(1n), MIN_GASLESS_AMOUNT); // a vault with a tiny minimum: the fee floor still applies
  assert.ok(MIN_GASLESS_AMOUNT > 20_000n && MIN_GASLESS_AMOUNT < 30_000n);
});

test("vaultSizeRefusal mirrors ExitVault's ExitTooSmall / ExitTooLarge bounds, inclusive", () => {
  const limits = { minExit: ONE_USDG, maxExit: 100n * ONE_USDG };
  assert.match(vaultSizeRefusal(ONE_USDG - 1n, limits) ?? "", /minimum/);
  assert.equal(vaultSizeRefusal(ONE_USDG, limits), undefined);
  assert.equal(vaultSizeRefusal(100n * ONE_USDG, limits), undefined);
  assert.match(vaultSizeRefusal(100n * ONE_USDG + 1n, limits) ?? "", /maximum/);
});

test("proofBlocker names the first failed market check, and nothing when all pass", () => {
  assert.equal(proofBlocker(ALL_PASS), undefined);
  assert.match(proofBlocker({ ...ALL_PASS, ownerIsSeller: false }) ?? "", /no longer own/);
  assert.match(proofBlocker({ ...ALL_PASS, unspent: false }) ?? "", /already claimed/);
  assert.match(proofBlocker({ ...ALL_PASS, minimalPath: false }) ?? "", /proof/);
  assert.match(proofBlocker({ ...ALL_PASS, rootValid: false }) ?? "", /disputed/);
});
