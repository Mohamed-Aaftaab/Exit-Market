import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, zeroAddress, type Hex } from "viem";
import { exitIntentRouterAbi } from "./abis.ts";
import { claimOf, netOfMarketFee } from "./hookData.ts";
import { listingEconomics, listingIdOf } from "./listings.ts";
import { assertionHashOf } from "./boldProof.ts";
import { SELL_ORDER_TYPES, revertReason, transientSettlementWait } from "./relay.ts";
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

test("listingIdOf matches ExitKeys.id: keccak256(abi.encode(gateway, exitNum, initialDestination))", () => {
  const gateway = "0xCcB451C4Df22addCFe1447c58bC6b2f264Bb1256";
  const dest = "0x4BDc704660B3710849e8C324469f863F8fC5cFAD";
  // Value returned by ExitMarket.listingId(gateway, 1, dest) on the deployed v4 market (Arbitrum Sepolia).
  assert.equal(listingIdOf(gateway, 1n, dest), "0xa3a7eda8a60c2f330f4a71bd282caa2202e730d9b213caba1ca3af193996da59");
  assert.notEqual(listingIdOf(gateway, 2n, dest), listingIdOf(gateway, 1n, dest));
});

test("listingEconomics: seller net after the snapshotted fee, buyer discount and annualised return", () => {
  const listing = { price: 1_990_000n, feeBps: 25, exit: { amount: 2_000_000n, deadlineBlock: 1_300n } };
  const e = listingEconomics(listing, 1_000n); // 300 L1 blocks = 3,600 s to payout
  assert.equal(e.sellerNet, 1_990_000n - 4_975n);
  assert.equal(e.discount, 10_000n);
  assert.equal(e.secondsToPayout, 3_600n);
  // 10,000 / 1,990,000 over one hour, annualised: 0.5025% * 8,760 = 4,402%.
  assert.equal(e.aprBps, (10_000n * 10_000n * 31_536_000n) / (1_990_000n * 3_600n));
});

test("listingEconomics: no annualised return without a discount or once the exit can pay out", () => {
  const atFace = { price: 2_000_000n, feeBps: 25, exit: { amount: 2_000_000n, deadlineBlock: 1_300n } };
  assert.equal(listingEconomics(atFace, 1_000n).aprBps, undefined);
  const due = { price: 1_990_000n, feeBps: 25, exit: { amount: 2_000_000n, deadlineBlock: 900n } };
  const e = listingEconomics(due, 1_000n);
  assert.equal(e.secondsToPayout, 0n);
  assert.equal(e.aprBps, undefined);
  const premium = { price: 2_100_000n, feeBps: 0, exit: { amount: 2_000_000n, deadlineBlock: 1_300n } };
  assert.equal(listingEconomics(premium, 1_000n).discount, -100_000n);
});
test("assertionHashOf reproduces a real Arbitrum One BOLD assertion hash from its preimage (fork fixture data)", () => {
  // Read from contracts/test/fork/ArbOneExitFixture.sol, generated from live mainnet events.
  const sol = readFileSync(new URL("../../contracts/test/fork/ArbOneExitFixture.sol", import.meta.url), "utf8");
  const pick = (re: RegExp) => {
    const m = re.exec(sol);
    assert.ok(m, `fixture field not found: ${re}`);
    return m.slice(1);
  };
  const [assertionHash] = pick(/ASSERTION_HASH = (0x[0-9a-f]{64});/);
  const [parent] = pick(/PARENT_ASSERTION_HASH = (0x[0-9a-f]{64});/);
  const [inboxAcc] = pick(/INBOX_ACC = (0x[0-9a-f]{64});/);
  const [blockHash, sendRoot] = pick(/bytes32Vals: \[bytes32\((0x[0-9a-f]{64})\), bytes32\((0x[0-9a-f]{64})\)\]/);
  const [u0, u1] = pick(/u64Vals: \[uint64\((\d+)\), uint64\((\d+)\)\]/);
  const [machineStatus] = pick(/s\.machineStatus = (\d+);/);
  const [endHistoryRoot] = pick(/s\.endHistoryRoot = (0x[0-9a-f]{64});/);
  const afterState = {
    globalState: { bytes32Vals: [blockHash as Hex, sendRoot as Hex] as const, u64Vals: [BigInt(u0), BigInt(u1)] as const },
    machineStatus: Number(machineStatus),
    endHistoryRoot: endHistoryRoot as Hex,
  };
  assert.equal(assertionHashOf(parent as Hex, afterState, inboxAcc as Hex), assertionHash);
});
test("transientSettlementWait keeps orders waiting through reverts that clear up by themselves, and only those", () => {
  for (const reason of ["InsufficientLiquidity(1, 0)", "TooManyOpenPositions(32)", "InvalidRoot(0xab, 61962)", "PendingNotAccepted"]) {
    assert.ok(transientSettlementWait(reason), reason);
  }
  for (const reason of ["BadSignature", "OrderExpired(1700000000)", "ExitTooSmall(500000, 1000000)", "ProceedsBelowMin(1, 2)", "NOT_EXPECTED_SENDER"]) {
    assert.equal(transientSettlementWait(reason), undefined, reason);
  }
});