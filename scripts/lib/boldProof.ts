import {
  encodeAbiParameters,
  encodePacked,
  keccak256,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { boldRootVerifierAbi } from "./abis.ts";
import { NotYetAssertedError, decodeWithdrawal, outboxPathOf, toExitProof, type Withdrawal } from "./exitProof.ts";
import { getLogsChunked } from "./logScan.ts";

/**
 * Proofs for BOLD rollups (Arbitrum One and Nova since 2025, Arbitrum Sepolia, new Orbit chains). BOLD stores only
 * assertion hashes, so BoldRootVerifier accepts a pending send root once the assertion's preimage, and every pending
 * ancestor's, is registered with it; the claim then carries the assertion hash in `blockHash` (nodeNum is unused).
 */

const STATE = "((bytes32[2] bytes32Vals, uint64[2] u64Vals) globalState, uint8 machineStatus, bytes32 endHistoryRoot)";
/** BOLD rollup event carrying an assertion's preimage. */
export const ASSERTION_CREATED = parseAbiItem(
  `event AssertionCreated(bytes32 indexed assertionHash, bytes32 indexed parentAssertionHash, ((bytes32 prevPrevAssertionHash, bytes32 sequencerBatchAcc, (bytes32 wasmModuleRoot, uint256 requiredStake, address challengeManager, uint64 confirmPeriodBlocks, uint64 nextInboxPosition) configData) beforeStateData, ${STATE} beforeState, ${STATE} afterState) assertion, bytes32 afterInboxBatchAcc, uint256 inboxMaxCount, bytes32 wasmModuleRoot, uint256 requiredStake, address challengeManager, uint64 confirmPeriodBlocks)`,
);
const BOLD_ROLLUP_ABI = parseAbi([
  "struct AssertionNode { uint64 firstChildBlock; uint64 secondChildBlock; uint64 createdAtBlock; bool isFirstChild; uint8 status; bytes32 configHash; }",
  "function getAssertion(bytes32 assertionHash) view returns (AssertionNode)",
]);
/** RollupCore AssertionStatus values the verifier and this library act on. */
export const AssertionStatus = { Pending: 1, Confirmed: 2 } as const;
/** Same bound as BoldRootVerifier.MAX_PENDING_DEPTH. */
const MAX_PENDING_DEPTH = 512;
const ASSERTION_STATE_PARAMS = [
  {
    type: "tuple",
    components: [
      { name: "globalState", type: "tuple", components: [{ name: "bytes32Vals", type: "bytes32[2]" }, { name: "u64Vals", type: "uint64[2]" }] },
      { name: "machineStatus", type: "uint8" },
      { name: "endHistoryRoot", type: "bytes32" },
    ],
  },
] as const;

export interface BoldAssertionState {
  globalState: { bytes32Vals: readonly [Hex, Hex]; u64Vals: readonly [bigint, bigint] };
  machineStatus: number;
  endHistoryRoot: Hex;
}

/** What BoldRootVerifier.register takes for one assertion (plus the hash it recomputes from it). */
export interface BoldAssertion {
  assertionHash: Hex;
  parent: Hex;
  afterState: BoldAssertionState;
  inboxAcc: Hex;
}

/** RollupLib.assertionHash, exactly as BoldRootVerifier.register recomputes it. */
export function assertionHashOf(parent: Hex, afterState: BoldAssertionState, inboxAcc: Hex): Hex {
  const stateHash = keccak256(encodeAbiParameters(ASSERTION_STATE_PARAMS, [afterState]));
  return keccak256(encodePacked(["bytes32", "bytes32", "bytes32"], [parent, stateHash, inboxAcc]));
}

/** AssertionCreated events of `rollup` in [fromBlock, toBlock] as registrable assertions, oldest first. */
export async function loadAssertions(parent: PublicClient, rollup: Address, fromBlock: bigint, toBlock: bigint, chunk = 5_000n): Promise<BoldAssertion[]> {
  const { logs } = await getLogsChunked(
    (from, to) => parent.getLogs({ address: rollup, event: ASSERTION_CREATED, fromBlock: from, toBlock: to }),
    fromBlock,
    toBlock,
    chunk,
  );
  return logs.map((l) => toBoldAssertion(l.args));
}

/** An AssertionCreated event's arguments as a registrable assertion (for logs fetched by other means). */
export function toBoldAssertion(args: {
  assertionHash?: Hex;
  parentAssertionHash?: Hex;
  assertion?: { afterState: BoldAssertionState };
  afterInboxBatchAcc?: Hex;
}): BoldAssertion {
  const { assertionHash, parentAssertionHash, assertion, afterInboxBatchAcc } = args;
  if (!assertionHash || !parentAssertionHash || !assertion || !afterInboxBatchAcc) throw new Error("Incomplete AssertionCreated event");
  return { assertionHash, parent: parentAssertionHash, afterState: assertion.afterState, inboxAcc: afterInboxBatchAcc };
}

export interface CoveringAssertion {
  assertion: BoldAssertion;
  /** Messages committed by the assertion's send root. */
  sendCount: bigint;
  /** True when the assertion is still pending (otherwise its root is confirmed in the Outbox). */
  pending: boolean;
  /** Every pending assertion from just after the latest confirmed one down to `assertion`, oldest first: what
   *  must be registered with BoldRootVerifier before selling. Empty for a confirmed assertion. */
  chain: BoldAssertion[];
}

async function sendCountOf(child: PublicClient, assertion: BoldAssertion): Promise<bigint> {
  const [blockHash, sendRoot] = assertion.afterState.globalState.bytes32Vals;
  // eth_getBlockByHash on an Arbitrum chain returns sendCount/sendRoot, which viem's Block type does not model.
  const block = (await child.request({ method: "eth_getBlockByHash" as never, params: [blockHash, false] as never })) as
    | { sendCount: Hex; sendRoot: Hex }
    | null;
  if (!block) throw new Error(`Child block ${blockHash} not found`);
  if (block.sendRoot !== sendRoot) throw new Error("Child block sendRoot does not match the assertion");
  return BigInt(block.sendCount);
}

type AssertionReader = (hash: Hex) => Promise<{ secondChildBlock: bigint; status: number }>;

/** getAssertion with a per-call cache: candidate chains overlap, so each assertion is read once. */
function cachedReader(parent: PublicClient, rollup: Address): AssertionReader {
  const cache = new Map<Hex, Promise<{ secondChildBlock: bigint; status: number }>>();
  return (hash) => {
    let hit = cache.get(hash);
    if (!hit) {
      hit = parent.readContract({ address: rollup, abi: BOLD_ROLLUP_ABI, functionName: "getAssertion", args: [hash] });
      cache.set(hash, hit);
    }
    return hit;
  };
}

/**
 * The pending chain BoldRootVerifier would walk for `assertion`, oldest first, or undefined if it would refuse it:
 * an ancestor missing from `known`, a rival child at any level, or a non-pending link.
 */
async function uncontestedChain(read: AssertionReader, assertion: BoldAssertion, known: Map<Hex, BoldAssertion>) {
  const chain: BoldAssertion[] = [];
  for (let cursor: BoldAssertion | undefined = assertion, depth = 0; cursor && depth < MAX_PENDING_DEPTH; depth++) {
    chain.unshift(cursor);
    const p = await read(cursor.parent);
    if (p.secondChildBlock !== 0n) return undefined; // disputed at this level
    if (p.status === AssertionStatus.Confirmed) return chain;
    if (p.status !== AssertionStatus.Pending) return undefined;
    cursor = known.get(cursor.parent);
  }
  return undefined; // an ancestor outside `known`, or deeper than the verifier walks
}

/** An assertion that covers the withdrawal, with its rollup status. */
export interface CoveringCandidate {
  assertion: BoldAssertion;
  sendCount: bigint;
  status: number;
}

/**
 * Which covering assertion to prove against, the same rule as legacy rollups (exitProof.findCoveringNode): a CONFIRMED
 * one wins (its root is in the Outbox, so no wait, no rollup risk, no time discount and nothing to register);
 * otherwise the EARLIEST pending one BoldRootVerifier accepts (an earlier deadline means a better price).
 * @param candidates covering assertions, newest first
 * @param chainOf the pending chain the verifier would walk for an assertion, undefined if it would refuse it
 */
export async function pickCovering(
  candidates: readonly CoveringCandidate[],
  chainOf: (assertion: BoldAssertion) => Promise<BoldAssertion[] | undefined>,
): Promise<CoveringAssertion | undefined> {
  const confirmed = candidates.find((c) => c.status === AssertionStatus.Confirmed);
  if (confirmed) return { assertion: confirmed.assertion, sendCount: confirmed.sendCount, pending: false, chain: [] };
  for (const c of [...candidates].reverse()) {
    if (c.status !== AssertionStatus.Pending) continue;
    const chain = await chainOf(c.assertion);
    if (chain) return { assertion: c.assertion, sendCount: c.sendCount, pending: true, chain };
  }
  return undefined;
}

/**
 * The assertion to prove a withdrawal at `position` against (see pickCovering).
 * @param assertions AssertionCreated history (oldest first) reaching back past the latest confirmed assertion
 * @throws NotYetAssertedError when no assertion covers the withdrawal yet, or only ones the verifier would refuse
 */
export async function findCoveringAssertion(
  parent: PublicClient,
  child: PublicClient,
  rollup: Address,
  position: bigint,
  assertions: BoldAssertion[],
): Promise<CoveringAssertion> {
  const known = new Map(assertions.map((a) => [a.assertionHash, a]));
  const read = cachedReader(parent, rollup);
  const candidates: CoveringCandidate[] = [];
  let newestSendCount: bigint | undefined;
  for (const assertion of [...assertions].reverse()) {
    const sendCount = await sendCountOf(child, assertion);
    newestSendCount ??= sendCount;
    if (sendCount <= position) break;
    const { status } = await read(assertion.assertionHash);
    candidates.push({ assertion, sendCount, status });
    if (status === AssertionStatus.Confirmed) break; // everything older is confirmed too
  }
  const best = await pickCovering(candidates, (a) => uncontestedChain(read, a, known));
  if (!best) throw new NotYetAssertedError(position, newestSendCount ?? 0n);
  return best;
}

/**
 * Builds the ExitClaim proof for a withdrawal from a BOLD chain, plus the assertions to register with
 * BoldRootVerifier first (see unregistered()).
 */
export async function buildBoldExitProof(params: {
  parent: PublicClient;
  child: PublicClient;
  rollup: Address;
  childGateway: Address;
  withdrawalTx: Hex;
  assertions: BoldAssertion[];
  exitNum?: bigint;
}): Promise<{ withdrawal: Withdrawal; covering: CoveringAssertion }> {
  const { parent, child, rollup, childGateway, withdrawalTx, assertions } = params;
  const d = await decodeWithdrawal(child, childGateway, withdrawalTx, params.exitNum);
  const covering = await findCoveringAssertion(parent, child, rollup, d.position, assertions);
  const sendRoot = covering.assertion.afterState.globalState.bytes32Vals[1];
  const merkleProof = await outboxPathOf(child, covering.sendCount, d.position, sendRoot);
  // BOLD claims carry the assertion hash where legacy claims carry the child block hash.
  const withdrawal = toExitProof(d, merkleProof, { sendRoot, nodeNum: 0n, blockHash: covering.assertion.assertionHash });
  return { withdrawal, covering };
}

/** The links of `chain` that `verifier` does not know yet, in the order to register them. */
export async function unregistered(parent: PublicClient, verifier: Address, rollup: Address, chain: BoldAssertion[]): Promise<BoldAssertion[]> {
  const known = await Promise.all(
    chain.map((a) => parent.readContract({ address: verifier, abi: boldRootVerifierAbi, functionName: "assertions", args: [rollup, a.assertionHash] })),
  );
  return chain.filter((_, i) => !known[i][3]);
}
