import { type Address, type Hex, type PublicClient, parseAbi, parseAbiItem } from "viem";

const NODE_CONFIRMED = parseAbiItem("event NodeConfirmed(uint64 indexed nodeNum, bytes32 blockHash, bytes32 sendRoot)");
const L2_TO_L1_TX = parseAbiItem(
  "event L2ToL1Tx(address caller, address indexed destination, uint256 indexed hash, uint256 indexed position, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data)",
);
const NODE_INTERFACE: Address = "0x00000000000000000000000000000000000000C8";
const ARB_SYS: Address = "0x0000000000000000000000000000000000000064";

export const outboxAbi = parseAbi([
  "function isSpent(uint256 index) view returns (bool)",
  "function roots(bytes32 root) view returns (bytes32)",
  "function executeTransaction(bytes32[] proof, uint256 index, address l2Sender, address to, uint256 l2Block, uint256 l1Block, uint256 l2Timestamp, uint256 value, bytes data)",
]);
const nodeInterfaceAbi = parseAbi([
  "function constructOutboxProof(uint64 size, uint64 leaf) view returns (bytes32 send, bytes32 root, bytes32[] proof)",
]);

export interface ConfirmedRoot {
  nodeNum: bigint;
  sendRoot: Hex;
  /** Number of child->parent messages committed by the root. */
  sendCount: bigint;
}

/** Newest confirmed legacy-rollup node, with the size of its send tree (read from the child block header). */
export async function latestConfirmedRoot(
  parent: PublicClient,
  child: PublicClient,
  rollup: Address,
  lookbackBlocks = 200_000n,
): Promise<ConfirmedRoot> {
  const head = await parent.getBlockNumber();
  const logs = await parent.getLogs({
    address: rollup,
    event: NODE_CONFIRMED,
    fromBlock: head > lookbackBlocks ? head - lookbackBlocks : 0n,
    toBlock: head,
  });
  const last = logs.at(-1);
  if (!last) throw new Error("No confirmed node in lookback window");
  const block = (await child.request({
    method: "eth_getBlockByHash" as never,
    params: [last.args.blockHash, false] as never,
  })) as { sendCount: Hex; sendRoot: Hex } | null;
  if (!block || block.sendRoot !== last.args.sendRoot) throw new Error("Confirmed node / child block mismatch");
  return { nodeNum: last.args.nodeNum!, sendRoot: last.args.sendRoot!, sendCount: BigInt(block.sendCount) };
}

/** Everything needed to call Outbox.executeTransaction for message `position`. */
export async function outboxMessage(child: PublicClient, position: bigint) {
  const logs = await child.getLogs({
    address: ARB_SYS,
    event: L2_TO_L1_TX,
    args: { position },
    fromBlock: 0n,
    toBlock: "latest",
  });
  const m = logs[0]?.args;
  if (!m) throw new Error(`L2ToL1Tx #${position} not found`);
  return m as Required<typeof m>;
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
