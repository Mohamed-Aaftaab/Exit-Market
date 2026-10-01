import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, zeroAddress, type Hex } from "viem";
import { exitIntentRouterAbi } from "./abis.ts";
import { claimOf, exitItemHash, netOfMarketFee } from "./hookData.ts";
import { keeperStep, type ExitFacts } from "./keeperPlan.ts";
import { listingEconomics, listingIdOf } from "./listings.ts";
import { AssertionStatus, assertionHashOf, pickCovering, type BoldAssertion, type CoveringCandidate } from "./boldProof.ts";
import { outboxRootOf } from "./outbox.ts";
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

test("outboxRootOf rebuilds a live Xai Testnet send root from a real withdrawal (exit #3, index 72, node 61781)", () => {
  // The same vector scripts/stylus/goldenCheck.ts checks on-chain against the Stylus program.
  const proof: Hex[] = [
    "0x6e2f997569dd82bdb30c0ce25af0633f7331c580d4b6aaf1cd8904f3b4c7113a",
    "0xcebc5eda66a599bf0568aae47dde4cefb5f543fbca405016aa3c1490490a2973",
    "0x0000000000000000000000000000000000000000000000000000000000000000",
    "0x3a2d5e8fcce99f0fd08bd609d1303903ab54e9ddfa2730834e14562f11b17dac",
    "0x0000000000000000000000000000000000000000000000000000000000000000",
    "0x0000000000000000000000000000000000000000000000000000000000000000",
    "0x2355f193840f04fc94aed433f911e03a9935a907db640130efbaf69442f7ddd6",
  ];
  const sendRoot: Hex = "0xd8a1c3386ad861c9533e67e76d0f3e403adb04a819775a7ec0ca2404c462b583";
  const owner = "0x2cd28Cda6825C4967372478E87D004637B73F996";
  const w: Withdrawal = {
    exitNum: 3n,
    initialDestination: owner,
    proof: {
      l1Token: "0x67e197D575e7A350Ff3dE1A7eAd2aA06b19145B6",
      from: owner,
      amount: 1_000_000_000_000_000n,
      extraData: "0x",
      l2Block: 14_217_403n,
      l1Block: 9_173_964n,
      l2Timestamp: 1_757_504_867n,
      index: 72n,
      merkleProof: proof,
      sendRoot,
      nodeNum: 61_781n,
      blockHash: `0x${"0".repeat(64)}`,
    },
  };
  const item = exitItemHash(w, "0xD840761a09609394FaFA3404bEEAb312059AC558", "0xCcB451C4Df22addCFe1447c58bC6b2f264Bb1256");
  assert.equal(outboxRootOf(item, proof, 72n), sendRoot);
  assert.notEqual(outboxRootOf(item, proof, 73n), sendRoot); // another index: another message's slot
});

const FACTS: ExitFacts = { spent: false, covered: true, itemConfirmed: true, vault: undefined, listed: false, rejected: false };

test("keeperStep: confirmed exits are executed, then collected by the vault or settled for a listing's seller", () => {
  assert.deepEqual(keeperStep({ ...FACTS, vault: { writtenOff: false } }), { kind: "collect" });
  assert.deepEqual(keeperStep({ ...FACTS, spent: true, vault: { writtenOff: true } }), { kind: "collect" }); // re-credited
  assert.deepEqual(keeperStep({ ...FACTS, listed: true }), { kind: "settle" });
  assert.deepEqual(keeperStep(FACTS), { kind: "execute" }); // a listing's buyer is paid by the Outbox directly
  assert.deepEqual(keeperStep({ ...FACTS, spent: true }), { kind: "done" });
});

test("keeperStep: a rejected vault exit is written off whether or not the confirmed root has reached its index", () => {
  const rejected = { ...FACTS, vault: { writtenOff: false }, rejected: true };
  assert.deepEqual(keeperStep({ ...rejected, covered: false, itemConfirmed: false }), { kind: "write-off" });
  // The honest chain now covers the index with a different message: collect can never succeed, write off instead.
  assert.deepEqual(keeperStep({ ...rejected, itemConfirmed: false }), { kind: "write-off" });
  assert.deepEqual(keeperStep({ ...rejected, spent: true, itemConfirmed: false }), { kind: "write-off" });
  // Re-committed by the honest node: the real exit pays out, so it is collected rather than written off.
  assert.deepEqual(keeperStep(rejected), { kind: "collect" });
});

test("keeperStep: waits on pending exits and stops on exits no keeper can finish", () => {
  assert.equal(keeperStep({ ...FACTS, covered: false, itemConfirmed: false, vault: { writtenOff: false } }).kind, "wait");
  assert.equal(keeperStep({ ...FACTS, itemConfirmed: false, vault: { writtenOff: false } }).kind, "wait"); // not rejected yet
  assert.deepEqual(keeperStep({ ...FACTS, itemConfirmed: false, vault: { writtenOff: true }, rejected: true }), { kind: "done" });
  assert.deepEqual(keeperStep({ ...FACTS, itemConfirmed: false, listed: true }), { kind: "done" });
});

/** Minimal BOLD assertions for the covering policy: only identity matters to pickCovering. */
const assertionNamed = (n: number): BoldAssertion => ({
  assertionHash: `0x${n.toString(16).padStart(64, "0")}`,
  parent: `0x${(n - 1).toString(16).padStart(64, "0")}`,
  afterState: { globalState: { bytes32Vals: [`0x${"0".repeat(64)}`, `0x${"0".repeat(64)}`], u64Vals: [0n, 0n] }, machineStatus: 1, endHistoryRoot: `0x${"0".repeat(64)}` },
  inboxAcc: `0x${"0".repeat(64)}`,
});
const candidate = (n: number, status: number): CoveringCandidate => ({ assertion: assertionNamed(n), sendCount: BigInt(100 + n), status });

test("pickCovering: a confirmed covering assertion wins over pending ones, like confirmed nodes on legacy rollups", async () => {
  // Newest first: two pending assertions, then a confirmed one that already covers the withdrawal.
  const candidates = [candidate(9, AssertionStatus.Pending), candidate(8, AssertionStatus.Pending), candidate(7, AssertionStatus.Confirmed)];
  const asked: number[] = [];
  const best = await pickCovering(candidates, async (a) => {
    asked.push(Number(BigInt(a.assertionHash)));
    return [a];
  });
  assert.equal(best?.pending, false);
  assert.equal(best?.assertion.assertionHash, assertionNamed(7).assertionHash);
  assert.deepEqual(best?.chain, []);
  assert.deepEqual(asked, []); // nothing to register, so no pending chain is even walked
});

test("pickCovering: otherwise the earliest pending assertion the verifier accepts, skipping contested ones", async () => {
  const candidates = [candidate(9, AssertionStatus.Pending), candidate(8, AssertionStatus.Pending), candidate(7, AssertionStatus.Pending)];
  const contested = new Set([assertionNamed(7).assertionHash]);
  const best = await pickCovering(candidates, async (a) => (contested.has(a.assertionHash) ? undefined : [a]));
  assert.equal(best?.pending, true);
  assert.equal(best?.assertion.assertionHash, assertionNamed(8).assertionHash); // 7 is earlier but contested
  assert.deepEqual(best?.chain, [assertionNamed(8)]);
  assert.equal(await pickCovering(candidates, async () => undefined), undefined);
  assert.equal(await pickCovering([], async (a) => [a]), undefined);
});