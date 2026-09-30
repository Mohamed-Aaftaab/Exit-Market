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

const NODE_INTERFACE: Address = "0x00000000000000000000000000000000000000C8";
const ARB_SYS: Address = "0x0000000000000000000000000000000000000064";
const NODE_INTERFACE_ABI = parseAbi([
  "function constructOutboxProof(uint64 size, uint64 leaf) view returns (bytes32 send, bytes32 root, bytes32[] proof)",
]);

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

/** Newest rollup node and how many withdrawals its send root commits to. */
export async function findLatestNode(
  parent: PublicClient,
  child: PublicClient,
  rollup: Address,
  lookbackBlocks = 50_000n,
): Promise<AssertedNode> {
  const head = await parent.getBlockNumber();
  const logs = await parent.getLogs({
    address: rollup,
    event: NODE_CREATED,
    fromBlock: head > lookbackBlocks ? head - lookbackBlocks : 0n,
    toBlock: head,
  });
  const newest = logs.at(-1);
  if (!newest) throw new Error("No rollup nodes found in lookback window");

  const [blockHash, sendRoot] = newest.args.assertion!.afterState.globalState.bytes32Vals;
  const block = (await child.request({
    method: "eth_getBlockByHash" as never,
    params: [blockHash, false] as never,
  })) as { sendCount: Hex; sendRoot: Hex } | null;
  if (!block) throw new Error(`Child block ${blockHash} not found`);
  if (block.sendRoot !== sendRoot) throw new Error("Child block sendRoot does not match node");

  return { nodeNum: newest.args.nodeNum!, blockHash, sendRoot, sendCount: BigInt(block.sendCount) };
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
  lookbackBlocks?: bigint;
}): Promise<Withdrawal> {
  const { parent, child, rollup, childGateway, withdrawalTx } = params;
  const receipt = await child.getTransactionReceipt({ hash: withdrawalTx });

  // Gateways also emit TxToL1 in the same tx, so filter by event signature, not just address.
  const [initiated] = parseEventLogs({ abi: [WITHDRAWAL_INITIATED], logs: receipt.logs }).filter(
    (l) => l.address.toLowerCase() === childGateway.toLowerCase(),
  );
  if (!initiated) throw new Error("Tx is not a gateway withdrawal");
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

  const node = await findLatestNode(parent, child, rollup, params.lookbackBlocks);
  if (m.position >= node.sendCount) {
    throw new Error(`Withdrawal #${m.position} not yet asserted (node covers ${node.sendCount} sends). Retry after next node.`);
  }
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
