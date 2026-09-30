import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRelayResponse, mergeRelayed, needsRelay, upsertIntent, type GaslessIntent } from "./intentStore.ts";

const TX_A = `0x${"a".repeat(64)}` as const;
const TX_B = `0x${"b".repeat(64)}` as const;

function intent(overrides: Partial<GaslessIntent> = {}): GaslessIntent {
  return {
    withdrawalTx: TX_A,
    amount: "5000000",
    exitNum: "9",
    order: { gateway: "0x1", exitNum: "9", buyer: "0x2", minProceeds: "1", relayerFee: "20000", deadline: "1" },
    signature: `0x${"1".repeat(130)}`,
    status: "waiting",
    updatedAt: 1,
    ...overrides,
  };
}

test("only signed intents that are waiting or retrying are polled", () => {
  assert.equal(needsRelay(intent()), true);
  assert.equal(needsRelay(intent({ status: "retrying" })), true);
  assert.equal(needsRelay(intent({ status: "unsigned", order: undefined, signature: undefined })), false);
  for (const status of ["settled", "done-elsewhere", "failed"] as const) {
    assert.equal(needsRelay(intent({ status })), false, status);
  }
});

test("upsert replaces by withdrawal tx and puts the newest first without mutating", () => {
  const list = [intent({ withdrawalTx: TX_B }), intent()];
  const next = upsertIntent(list, intent({ status: "settled" }));
  assert.deepEqual(next.map((i) => [i.withdrawalTx, i.status]), [[TX_A, "settled"], [TX_B, "waiting"]]);
  assert.equal(list.length, 2);
  assert.equal(list[1].status, "waiting");
});

test("merging relay results keeps intents added while the requests were in flight", () => {
  const before = [intent({ updatedAt: 5 })];
  const addedMeanwhile = intent({ withdrawalTx: TX_B, updatedAt: 6 });
  const current = upsertIntent(before, addedMeanwhile);
  const relayed = [intent({ status: "settled", updatedAt: 7 })];
  const merged = mergeRelayed(current, relayed);
  assert.deepEqual(merged.map((i) => [i.withdrawalTx, i.status]), [[TX_B, "waiting"], [TX_A, "settled"]]);
});

test("a stale relay result never overwrites a newer local change", () => {
  const current = [intent({ status: "failed", updatedAt: 10 })];
  const merged = mergeRelayed(current, [intent({ status: "waiting", updatedAt: 9 })]);
  assert.equal(merged[0].status, "failed");
});

test("relayer responses map to the right status", () => {
  const settled = applyRelayResponse(intent(), { httpStatus: 200, body: { status: "settled", txHash: TX_B } }, 2);
  assert.deepEqual([settled.status, settled.settleTx], ["settled", TX_B]);

  const elsewhere = applyRelayResponse(intent(), { httpStatus: 200, body: { status: "done-elsewhere", owner: "0x3" } }, 2);
  assert.equal(elsewhere.status, "done-elsewhere");

  const waiting = applyRelayResponse(intent(), { httpStatus: 202, body: { status: "waiting", reason: "next node" } }, 2);
  assert.deepEqual([waiting.status, waiting.detail], ["waiting", "next node"]);

  const rejected = applyRelayResponse(intent(), { httpStatus: 422, body: { status: "error", error: "OrderExpired(1)" } }, 2);
  assert.deepEqual([rejected.status, rejected.detail], ["failed", "OrderExpired(1)"]);

  const limited = applyRelayResponse(intent(), { httpStatus: 429, body: { status: "error", error: "Too many requests" } }, 2);
  assert.equal(limited.status, "retrying");

  const down = applyRelayResponse(intent(), { httpStatus: 502, body: { status: "error", error: "RPC down" } }, 2);
  assert.equal(down.status, "retrying");

  const unreachable = applyRelayResponse(intent(), undefined, 2);
  assert.deepEqual([unreachable.status, unreachable.updatedAt], ["retrying", 2]);
});
