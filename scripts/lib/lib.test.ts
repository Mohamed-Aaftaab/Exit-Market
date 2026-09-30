import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, zeroAddress, type Hex } from "viem";
import { exitIntentRouterAbi } from "./abis.ts";
import { claimOf, netOfMarketFee } from "./hookData.ts";
import { SELL_ORDER_TYPES, revertReason } from "./relay.ts";
import type { Withdrawal } from "./exitProof.ts";

test("netOfMarketFee rounds the fee down exactly like ExitMarket (price - price * feeBps / 10_000)", () => {
  assert.equal(netOfMarketFee(4_994_973n, 25), 4_994_973n - 12_487n);
  assert.equal(netOfMarketFee(399n, 25), 399n); // fee rounds to zero on dust
  assert.equal(netOfMarketFee(10_000_000n, 200n), 9_800_000n);
});

test("the EIP-712 SellOrder fields match the router's SELL_ORDER_TYPEHASH string field for field", () => {
  const source = readFileSync(new URL("../../contracts/ExitIntentRouter.sol", import.meta.url), "utf8");
  const typeString = /"SellOrder\(([^)]*)\)"/.exec(source)?.[1];
  assert.ok(typeString, "SELL_ORDER_TYPEHASH string not found in ExitIntentRouter.sol");
  const fromTs = SELL_ORDER_TYPES.SellOrder.map((f) => `${f.type} ${f.name}`).join(",");
  assert.equal(fromTs, typeString);
});

test("revertReason names a custom error with its arguments", () => {
  const data = encodeErrorResult({ abi: exitIntentRouterAbi, errorName: "OrderExpired", args: [1_700_000_000n] });
  const reverted = new ContractFunctionRevertedError({ abi: exitIntentRouterAbi, data, functionName: "settle" });
  const wrapped = new BaseError("simulation failed", { cause: reverted });
  assert.equal(revertReason(wrapped), "OrderExpired(1700000000)");
});

test("revertReason falls back to the raw revert string, and ignores non-viem errors", () => {
  const reverted = new ContractFunctionRevertedError({ abi: exitIntentRouterAbi, functionName: "settle", message: "NOT_EXPECTED_SENDER" });
  assert.equal(revertReason(new BaseError("x", { cause: reverted })), "NOT_EXPECTED_SENDER");
  assert.equal(revertReason(new Error("plain")), undefined);
});

test("claimOf copies every field the market's ExitClaim needs", () => {
  const hash = `0x${"ab".repeat(32)}` as Hex;
  const w: Withdrawal = {
    exitNum: 12n,
    initialDestination: zeroAddress,
    proof: {
      l1Token: zeroAddress,
      from: zeroAddress,
      amount: 5_000_000n,
      extraData: "0x",
      l2Block: 1n,
      l1Block: 2n,
      l2Timestamp: 3n,
      index: 84n,
      merkleProof: [hash],
      sendRoot: hash,
      nodeNum: 61925n,
      blockHash: hash,
    },
  };
  const c = claimOf(w);
  assert.deepEqual(Object.keys(c), [
    "initialDestination", "l1Token", "from", "amount", "l2Block", "l1Block", "l2Timestamp", "index", "proof",
    "sendRoot", "nodeNum", "blockHash",
  ]);
  assert.equal(c.index, 84n);
  assert.deepEqual(c.proof, [hash]);
});
