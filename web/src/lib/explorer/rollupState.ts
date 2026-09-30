import type { Hex, PublicClient } from "viem";
import { NODE_CREATED } from "@shared/exitProof.ts";
import { XAI_TESTNET, rollupAbi } from "@/lib/contracts";
import { MAX_PENDING_NODES, NODE_LOOKBACK } from "./constants";
import { getLogsChunked } from "./logScan";

export interface RollupNode {
  nodeNum: bigint;
  /** Child->parent messages committed by the node's send root: positions below this are in the node. */
  sendCount: bigint;
  /** L1 block after which the node can be confirmed (0 for the confirmed node). */
  deadlineBlock: bigint;
}

export interface RollupState {
  parentBlock: bigint;
  /** Current L1 (Ethereum Sepolia) block: the unit of rollup deadlines. */
  l1Block: bigint;
  confirmed: RollupNode;
  /** Created but not yet confirmed, ascending by node number. */
  pending: RollupNode[];
}

const rollup = XAI_TESTNET.ethBridge.rollup;

async function readHeads(parent: PublicClient) {
  const [block, [confirmed, created]] = await Promise.all([
    parent.getBlock(),
    parent.multicall({
      allowFailure: false,
      contracts: [
        { address: rollup, abi: rollupAbi, functionName: "latestConfirmed" },
        { address: rollup, abi: rollupAbi, functionName: "latestNodeCreated" },
      ],
    }),
  ]);
  // Inside Arbitrum's EVM, block.number is the L1 block; the RPC exposes it as l1BlockNumber.
  const l1Block = BigInt((block as unknown as { l1BlockNumber: Hex }).l1BlockNumber);
  return { parentBlock: block.number, l1Block, confirmed, created };
}

/** After-state L3 block hash of each requested node, from its NodeCreated event. */
async function nodeBlockHashes(parent: PublicClient, nodeNums: bigint[], head: bigint): Promise<Map<bigint, Hex>> {
  const from = head > NODE_LOOKBACK ? head - NODE_LOOKBACK : 0n;
  const { logs } = await getLogsChunked(
    (fromBlock, toBlock) => parent.getLogs({ address: rollup, event: NODE_CREATED, args: { nodeNum: nodeNums }, fromBlock, toBlock }),
    from,
    head,
    NODE_LOOKBACK + 1n,
  );
  return new Map(logs.map((l) => [l.args.nodeNum!, l.args.assertion!.afterState.globalState.bytes32Vals[0]]));
}

async function sendCountAt(child: PublicClient, blockHash: Hex): Promise<bigint> {
  const block = (await child.request({
    method: "eth_getBlockByHash" as never,
    params: [blockHash, false] as never,
  })) as { sendCount?: Hex } | null;
  if (!block?.sendCount) throw new Error(`Xai block ${blockHash} not found`);
  return BigInt(block.sendCount);
}

async function deadlines(parent: PublicClient, nodeNums: bigint[]): Promise<bigint[]> {
  if (nodeNums.length === 0) return [];
  const nodes = await parent.multicall({
    allowFailure: false,
    contracts: nodeNums.map((n) => ({ address: rollup, abi: rollupAbi, functionName: "getNode", args: [n] }) as const),
  });
  return nodes.map((n) => n.deadlineBlock);
}

/** Latest confirmed node and every pending node of Xai Testnet's rollup, with their send-tree sizes. */
export async function loadRollupState(parent: PublicClient, child: PublicClient): Promise<RollupState> {
  const heads = await readHeads(parent);
  const last = heads.created < heads.confirmed + BigInt(MAX_PENDING_NODES) ? heads.created : heads.confirmed + BigInt(MAX_PENDING_NODES);
  const nodeNums: bigint[] = [];
  for (let n = heads.confirmed; n <= last; n++) nodeNums.push(n);

  const hashes = await nodeBlockHashes(parent, nodeNums, heads.parentBlock);
  const found = nodeNums.filter((n) => hashes.has(n));
  if (found[0] !== heads.confirmed) {
    throw new Error(`Rollup node #${heads.confirmed} not found in the last ${NODE_LOOKBACK} Arbitrum Sepolia blocks`);
  }
  const pendingNums = found.slice(1);
  const [sendCounts, pendingDeadlines] = await Promise.all([
    Promise.all(found.map((n) => sendCountAt(child, hashes.get(n)!))),
    deadlines(parent, pendingNums),
  ]);
  return {
    parentBlock: heads.parentBlock,
    l1Block: heads.l1Block,
    confirmed: { nodeNum: heads.confirmed, sendCount: sendCounts[0], deadlineBlock: 0n },
    pending: pendingNums.map((nodeNum, i) => ({ nodeNum, sendCount: sendCounts[i + 1], deadlineBlock: pendingDeadlines[i] })),
  };
}
