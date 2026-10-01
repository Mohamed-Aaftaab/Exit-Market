import { type Address, type Hex, type PublicClient, parseAbi, parseAbiItem } from "viem";
import { ARB_SYS, NODE_INTERFACE } from "./exitProof.ts";
import { planChunks } from "./logScan.ts";

/** Emitted by the Outbox whenever the rollup confirms a root: the same event for legacy nodes and BOLD assertions. */
const SEND_ROOT_UPDATED = parseAbiItem("event SendRootUpdated(bytes32 indexed outputRoot, bytes32 indexed l2BlockHash)");
// exitProof.ts keeps its copy of this event private, so the Outbox side declares its own.
const L2_TO_L1_TX = parseAbiItem(
  "event L2ToL1Tx(address caller, address indexed destination, uint256 indexed hash, uint256 indexed position, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data)",
);
/** Child-chain getLogs span: `position` is an indexed topic, so each request matches at most one log. */
const CHILD_LOG_CHUNK = 5_000_000n;

export const outboxAbi = parseAbi([
  "function isSpent(uint256 index) view returns (bool)",
  "function roots(bytes32 root) view returns (bytes32)",
  "function executeTransaction(bytes32[] proof, uint256 index, address l2Sender, address to, uint256 l2Block, uint256 l1Block, uint256 l2Timestamp, uint256 value, bytes data)",
]);
const nodeInterfaceAbi = parseAbi([
  "function constructOutboxProof(uint64 size, uint64 leaf) view returns (bytes32 send, bytes32 root, bytes32[] proof)",
]);

export interface ConfirmedRoot {
  sendRoot: Hex;
  /** Child block hash the root was confirmed with. */
  blockHash: Hex;
  /** Number of child->parent messages committed by the root. */
  sendCount: bigint;
  /** Child block the root was taken at: every message it commits was sent at or before this block. */
  childBlock: bigint;
}

/**
 * Newest root the rollup confirmed into `outbox`, with the size of its send tree (read from the child block header).
 * Rollup-agnostic: legacy nodes and BOLD assertions both confirm through Outbox.updateSendRoot.
 */
export async function latestConfirmedRoot(
  parent: PublicClient,
  child: PublicClient,
  outbox: Address,
  lookbackBlocks = 200_000n,
): Promise<ConfirmedRoot> {
  const head = await parent.getBlockNumber();
  const logs = await parent.getLogs({
    address: outbox,
    event: SEND_ROOT_UPDATED,
    fromBlock: head > lookbackBlocks ? head - lookbackBlocks : 0n,
    toBlock: head,
  });
  const last = logs.at(-1)?.args;
  if (!last?.outputRoot || !last.l2BlockHash) throw new Error("No confirmed root in the lookback window");
  const block = (await child.request({
    method: "eth_getBlockByHash" as never,
    params: [last.l2BlockHash, false] as never,
  })) as { number: Hex; sendCount: Hex; sendRoot: Hex } | null;
  if (!block || block.sendRoot !== last.outputRoot) throw new Error("Confirmed root / child block mismatch");
  return {
    sendRoot: last.outputRoot,
    blockHash: last.l2BlockHash,
    sendCount: BigInt(block.sendCount),
    childBlock: BigInt(block.number),
  };
}
/**
 * Everything needed to call Outbox.executeTransaction for message `position`. Scans [fromBlock, toBlock] newest
 * chunk first (exits being collected are recent) and stops at the first match. Pass `toBlock` when a bound is
 * known (e.g. ConfirmedRoot.childBlock); it defaults to the child chain head.
 */
export async function outboxMessage(
  child: PublicClient,
  position: bigint,
  range: { fromBlock?: bigint; toBlock?: bigint } = {},
) {
  const fromBlock = range.fromBlock ?? 0n;
  const toBlock = range.toBlock ?? (await child.getBlockNumber());
  for (const [from, to] of planChunks(fromBlock, toBlock, CHILD_LOG_CHUNK).reverse()) {
    const logs = await child.getLogs({ address: ARB_SYS, event: L2_TO_L1_TX, args: { position }, fromBlock: from, toBlock: to });
    const m = logs[0]?.args;
    if (m) return m as Required<typeof m>;
  }
  throw new Error(`L2ToL1Tx #${position} not found in child blocks ${fromBlock}-${toBlock}`);
}

/** Merkle proof of message `position` in the send tree of size `size` (via the child chain's NodeInterface). */
export async function outboxProof(child: PublicClient, size: bigint, position: bigint) {
  const [, root, proof] = await child.readContract({
    address: NODE_INTERFACE,
    abi: nodeInterfaceAbi,
    functionName: "constructOutboxProof",
    args: [size, position],
  });
  return { root, proof: [...proof] };
}
