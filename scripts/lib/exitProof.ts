import {
  type Address,
  type Hex,
  type PublicClient,
  decodeAbiParameters,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
} from "viem";

/** Pre-BOLD rollup event: carries the assertion's after-state (L3 blockHash + sendRoot). */
export const NODE_CREATED = parseAbiItem(
  "event NodeCreated(uint64 indexed nodeNum, bytes32 indexed parentNodeHash, bytes32 indexed nodeHash, bytes32 executionHash, (((bytes32[2] bytes32Vals, uint64[2] u64Vals) globalState, uint8 machineStatus) beforeState, ((bytes32[2] bytes32Vals, uint64[2] u64Vals) globalState, uint8 machineStatus) afterState, uint64 numBlocks) assertion, bytes32 afterInboxBatchAcc, bytes32 wasmModuleRoot, uint256 inboxMaxCount)",
);

/** ArbSys (0x64) event emitted for every child->parent message. */
const L2_TO_L1_TX = parseAbiItem(
  "event L2ToL1Tx(address caller, address indexed destination, uint256 indexed hash, uint256 indexed position, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data)",
);

/** Child gateway event: links an exitNum to its L2->L1 message id (= position). */
const WITHDRAWAL_INITIATED = parseAbiItem(
  "event WithdrawalInitiated(address l1Token, address indexed _from, address indexed _to, uint256 indexed _l2ToL1Id, uint256 _exitNum, uint256 _amount)",
);

/** Arbitrum precompiles (fixed addresses on every Arbitrum chain). */
export const NODE_INTERFACE: Address = "0x00000000000000000000000000000000000000C8";
export const ARB_SYS: Address = "0x0000000000000000000000000000000000000064";
const NODE_INTERFACE_ABI = parseAbi([
  "function constructOutboxProof(uint64 size, uint64 leaf) view returns (bytes32 send, bytes32 root, bytes32[] proof)",
]);
const ROLLUP_ABI = parseAbi(["function firstUnresolvedNode() view returns (uint64)"]);

const DEFAULT_LOOKBACK_BLOCKS = 50_000n;
/** Widening stops here (~11 days of Arbitrum Sepolia blocks): a validator idle for longer is a chain outage. */
const MAX_LOOKBACK_BLOCKS = 3_200_000n;

/** The transaction is not a withdrawal this library can prove (caller input error, not a network failure). */
export class InvalidWithdrawalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWithdrawalError";
  }
}

/** The withdrawal exists but no rollup node commits to it yet: retry after the next node (typed, not a string). */
export class NotYetAssertedError extends Error {
  readonly position: bigint;
  readonly sendCount: bigint;

  // No TS parameter properties here: Node runs these files with type stripping, which does not support them.
  constructor(position: bigint, sendCount: bigint) {
    super(`Withdrawal #${position} not yet asserted (node covers ${sendCount} sends). Retry after next node.`);
    this.name = "NotYetAssertedError";
    this.position = position;
    this.sendCount = sendCount;
  }
}

/** Must match ExitMarket's ExitProof struct field-for-field. */
export interface ExitProof {
  l1Token: Address;
  from: Address;
  amount: bigint;
  extraData: Hex;
  l2Block: bigint;
  l1Block: bigint;
  l2Timestamp: bigint;
  index: bigint;
  merkleProof: Hex[];
  sendRoot: Hex;
  nodeNum: bigint;
  blockHash: Hex;
}

export interface Withdrawal {
  exitNum: bigint;
  initialDestination: Address;
  proof: ExitProof;
}

export interface AssertedNode {
  nodeNum: bigint;
  blockHash: Hex;
  sendRoot: Hex;
  /** Number of child->parent messages committed by this node's send root. */
  sendCount: bigint;
}

type NodeCreatedLog = Awaited<ReturnType<typeof nodeLogs>>[number];

/**
 * NodeCreated logs, oldest first. Starts with `lookbackBlocks` and widens (x4) while the window is empty, so an
 * idle validator slows the call down instead of failing it.
 */
async function nodeLogs(parent: PublicClient, rollup: Address, lookbackBlocks: bigint) {
  const head = await parent.getBlockNumber();
  for (let span = lookbackBlocks; ; span *= 4n) {
    const fromBlock = head > span ? head - span : 0n;
    const logs = await parent.getLogs({ address: rollup, event: NODE_CREATED, fromBlock, toBlock: head });
    if (logs.length > 0 || fromBlock === 0n || span >= MAX_LOOKBACK_BLOCKS) return logs;
  }
}

/** Reads a node's after-state from its log and checks it against the child chain's own block header. */
async function describeNode(child: PublicClient, log: NodeCreatedLog): Promise<AssertedNode> {
  const [blockHash, sendRoot] = log.args.assertion!.afterState.globalState.bytes32Vals;
  // eth_getBlockByHash on an Arbitrum chain returns sendCount/sendRoot, which viem's Block type does not model.
  const block = (await child.request({
    method: "eth_getBlockByHash" as never,
    params: [blockHash, false] as never,
  })) as { sendCount: Hex; sendRoot: Hex } | null;
  if (!block) throw new Error(`Child block ${blockHash} not found`);
  if (block.sendRoot !== sendRoot) throw new Error("Child block sendRoot does not match node");
  return { nodeNum: log.args.nodeNum!, blockHash, sendRoot, sendCount: BigInt(block.sendCount) };
}

/** Newest rollup node and how many withdrawals its send root commits to. */
export async function findLatestNode(
  parent: PublicClient,
  child: PublicClient,
  rollup: Address,
  lookbackBlocks = DEFAULT_LOOKBACK_BLOCKS,
): Promise<AssertedNode> {
  const newest = (await nodeLogs(parent, rollup, lookbackBlocks)).at(-1);
  if (!newest) throw new Error("No rollup nodes found");
  return describeNode(child, newest);
}

/**
 * The node to prove a withdrawal against: the EARLIEST still-unresolved node whose send root covers `position`.
 * An earlier node means an earlier deadline, so a better price for the seller and a shorter position for the
 * buyer. Falls back to the newest covering node when every covering node is already resolved.
 * @throws NotYetAssertedError when no node covers the withdrawal yet
 */
export async function findCoveringNode(
  parent: PublicClient,
  child: PublicClient,
  rollup: Address,
  position: bigint,
  lookbackBlocks = DEFAULT_LOOKBACK_BLOCKS,
): Promise<AssertedNode> {
  const [logs, firstUnresolved] = await Promise.all([
    nodeLogs(parent, rollup, lookbackBlocks),
    parent.readContract({ address: rollup, abi: ROLLUP_ABI, functionName: "firstUnresolvedNode" }),
  ]);
  if (logs.length === 0) throw new Error("No rollup nodes found");

  let chosen: AssertedNode | undefined;
  let newestSendCount: bigint | undefined;
  // Newest to oldest: stop at the first node that no longer covers the withdrawal, or that is resolved.
  for (const log of [...logs].reverse()) {
    const node = await describeNode(child, log);
    newestSendCount ??= node.sendCount;
    if (node.sendCount <= position) break;
    const isPending = node.nodeNum >= firstUnresolved;
    if (isPending || !chosen) chosen = node;
    if (!isPending) break;
  }
  if (!chosen) throw new NotYetAssertedError(position, newestSendCount ?? 0n);
  return chosen;
}

/**
 * Builds everything ExitMarket needs to verify a withdrawal against a PENDING assertion,
 * starting from the child-chain withdrawal transaction hash.
 */
export async function buildExitProof(params: {
  parent: PublicClient;
  child: PublicClient;
  rollup: Address;
  childGateway: Address;
  withdrawalTx: Hex;
  /** Which withdrawal to prove when one transaction made several (defaults to the only one). */
  exitNum?: bigint;
  lookbackBlocks?: bigint;
}): Promise<Withdrawal> {
  const { parent, child, rollup, childGateway, withdrawalTx } = params;
  const receipt = await child.getTransactionReceipt({ hash: withdrawalTx });

  // Gateways also emit TxToL1 in the same tx, so filter by event signature, not just address.
  const withdrawals = parseEventLogs({ abi: [WITHDRAWAL_INITIATED], logs: receipt.logs }).filter(
    (l) => l.address.toLowerCase() === childGateway.toLowerCase(),
  );
  if (withdrawals.length === 0) throw new InvalidWithdrawalError("Tx is not a withdrawal through this gateway");
  if (params.exitNum === undefined && withdrawals.length > 1) {
    throw new InvalidWithdrawalError(`Tx made ${withdrawals.length} withdrawals: pass the exitNum to prove`);
  }
  const initiated =
    params.exitNum === undefined ? withdrawals[0] : withdrawals.find((l) => l.args._exitNum === params.exitNum);
  if (!initiated) throw new InvalidWithdrawalError(`Tx has no withdrawal with exitNum ${params.exitNum}`);
  const w = initiated.args;

  // Pick the ArbSys message whose id is the one the gateway reported.
  const sent = parseEventLogs({ abi: [L2_TO_L1_TX], logs: receipt.logs }).find(
    (l) => l.address.toLowerCase() === ARB_SYS.toLowerCase() && l.args.position === w._l2ToL1Id,
  );
  if (!sent) throw new Error("Matching L2ToL1Tx not found");
  const m = sent.args;

  // finalizeInboundTransfer(token, from, to, amount, abi.encode(exitNum, extraData))
  const [, , , , gatewayMsg] = decodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes" }],
    `0x${m.data.slice(10)}`,
  );
  const [exitNum, extraData] = decodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], gatewayMsg);
  if (exitNum !== w._exitNum) throw new Error("exitNum mismatch between events");

  const node = await findCoveringNode(parent, child, rollup, m.position, params.lookbackBlocks);
  const [, root, merkleProof] = await child.readContract({
    address: NODE_INTERFACE,
    abi: NODE_INTERFACE_ABI,
    functionName: "constructOutboxProof",
    args: [node.sendCount, m.position],
  });
  if (root !== node.sendRoot) throw new Error("NodeInterface root does not match node sendRoot");

  return {
    exitNum,
    initialDestination: w._to,
    proof: {
      l1Token: w.l1Token,
      from: w._from,
      amount: w._amount,
      extraData,
      l2Block: m.arbBlockNum,
      l1Block: m.ethBlockNum,
      l2Timestamp: m.timestamp,
      index: m.position,
      merkleProof: [...merkleProof],
      sendRoot: node.sendRoot,
      nodeNum: node.nodeNum,
      blockHash: node.blockHash,
    },
  };
}
