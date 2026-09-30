import { parseAbi, parseAbiItem, type Address, type PublicClient } from "viem";
import { XAI_TESTNET, outboxAbi, parentGatewayAbi, withdrawalInitiatedEvent } from "@/lib/contracts";
import {
  PARENT_LOG_CHUNK,
  PARENT_REDIRECT_START_BLOCK,
  XAI_GATEWAY_START_BLOCK,
  XAI_LOG_CHUNK,
  ourContract,
} from "./constants";
import { getLogsChunked } from "./logScan";
import { loadRollupState, type RollupState } from "./rollupState";
import { stageOf, statusOf, type ExitToken, type ExplorerExit, type Redirect } from "./status";

/** Parent (L1-side) gateway event emitted by transferExitAndCall. */
const withdrawRedirectedEvent = parseAbiItem(
  "event WithdrawRedirected(address indexed from, address indexed to, uint256 indexed exitNum, bytes newData, bytes data, bool madeExternalCall)",
);
const erc20MetaAbi = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
/** Calldata bytes per Multicall3 eth_call before viem splits it (default 1 KiB would split a few dozen exits). */
const MULTICALL_BATCH_BYTES = 16_384;

export interface ScanInfo {
  childFrom: bigint;
  childTo: bigint;
  parentFrom: bigint;
  parentTo: bigint;
  /** eth_getLogs requests for withdrawals + redirects (bisection retries included). */
  logCalls: number;
}

export interface ExplorerData {
  exits: ExplorerExit[];
  rollup: RollupState;
  scan: ScanInfo;
  /** ms epoch at which the scan finished; ages are measured from it. */
  scannedAt: number;
}

type WithdrawalLog = Awaited<ReturnType<typeof scanWithdrawals>>["logs"][number];

function scanWithdrawals(child: PublicClient, head: bigint) {
  const address = XAI_TESTNET.tokenBridge.childErc20Gateway;
  return getLogsChunked(
    (fromBlock, toBlock) => child.getLogs({ address, event: withdrawalInitiatedEvent, fromBlock, toBlock }),
    XAI_GATEWAY_START_BLOCK,
    head,
    XAI_LOG_CHUNK,
  );
}

async function scanRedirects(parent: PublicClient, head: bigint) {
  const address = XAI_TESTNET.tokenBridge.parentErc20Gateway;
  const scan = await getLogsChunked(
    (fromBlock, toBlock) => parent.getLogs({ address, event: withdrawRedirectedEvent, fromBlock, toBlock }),
    PARENT_REDIRECT_START_BLOCK,
    head,
    PARENT_LOG_CHUNK,
  );
  const byExit = new Map<bigint, Redirect[]>();
  for (const l of scan.logs) {
    const r: Redirect = { from: l.args.from!, to: l.args.to!, txHash: l.transactionHash, blockNumber: l.blockNumber };
    byExit.set(l.args.exitNum!, [...(byExit.get(l.args.exitNum!) ?? []), r]);
  }
  return { byExit, calls: scan.calls };
}

/** Current owner and Outbox spent flag of every exit (two Multicall3 reads on Arbitrum Sepolia). */
async function readOwnership(parent: PublicClient, logs: WithdrawalLog[]): Promise<{ owners: Address[]; spent: boolean[] }> {
  if (logs.length === 0) return { owners: [], spent: [] };
  const [owners, spent] = await Promise.all([
    parent.multicall({
      allowFailure: false,
      batchSize: MULTICALL_BATCH_BYTES,
      contracts: logs.map((l) => ({
        address: XAI_TESTNET.tokenBridge.parentErc20Gateway,
        abi: parentGatewayAbi,
        functionName: "getExternalCall",
        args: [l.args._exitNum!, l.args._to!, "0x"],
      }) as const),
    }),
    parent.multicall({
      allowFailure: false,
      batchSize: MULTICALL_BATCH_BYTES,
      contracts: logs.map((l) => ({ address: XAI_TESTNET.ethBridge.outbox, abi: outboxAbi, functionName: "isSpent", args: [l.args._l2ToL1Id!] }) as const),
    }),
  ]);
  return { owners: owners.map(([target]) => target), spent };
}

/** Symbol and decimals of each parent-chain token; a token that does not answer keeps them undefined. */
async function readTokens(parent: PublicClient, addresses: Address[]): Promise<Map<string, ExitToken>> {
  if (addresses.length === 0) return new Map();
  const results = await parent.multicall({
    allowFailure: true,
    batchSize: MULTICALL_BATCH_BYTES,
    contracts: addresses.flatMap((address) => [
      { address, abi: erc20MetaAbi, functionName: "symbol" } as const,
      { address, abi: erc20MetaAbi, functionName: "decimals" } as const,
    ]),
  });
  return new Map(
    addresses.map((address, i) => {
      const symbol = results[2 * i];
      const decimals = results[2 * i + 1];
      return [
        address.toLowerCase(),
        {
          address,
          symbol: symbol.status === "success" ? String(symbol.result) : undefined,
          decimals: decimals.status === "success" ? Number(decimals.result) : undefined,
        },
      ];
    }),
  );
}

/** Block timestamps (unix seconds) on Xai, one batched eth_getBlockByNumber per distinct block. */
async function readTimestamps(child: PublicClient, blocks: bigint[]): Promise<Map<bigint, number>> {
  const unique = [...new Set(blocks)];
  const headers = await Promise.all(unique.map((blockNumber) => child.getBlock({ blockNumber })));
  return new Map(headers.map((b) => [b.number, Number(b.timestamp)]));
}

interface ExitContext {
  owner: Address;
  spent: boolean;
  token: ExitToken;
  timestamp: number;
  redirects: Redirect[];
  rollup: RollupState;
}

function toExit(l: WithdrawalLog, ctx: ExitContext): ExplorerExit {
  const { _from, _to, _l2ToL1Id, _exitNum, _amount } = l.args as Required<typeof l.args>;
  const { stage, blocksLeft } = stageOf(_l2ToL1Id, ctx.spent, ctx.rollup);
  const ownerContract = ourContract(ctx.owner);
  const touchesMarket = ctx.redirects.some((r) => ourContract(r.to) === "market" || ourContract(r.from) === "market");
  return {
    exitNum: _exitNum,
    position: _l2ToL1Id,
    txHash: l.transactionHash,
    blockNumber: l.blockNumber,
    timestamp: ctx.timestamp,
    token: ctx.token,
    amount: _amount,
    sender: _from,
    initialDestination: _to,
    owner: ctx.owner,
    stage,
    status: statusOf(stage, ctx.owner.toLowerCase() !== _to.toLowerCase()),
    blocksLeft,
    redirects: ctx.redirects,
    ownerContract,
    viaExitMarket: touchesMarket || ownerContract === "market" || ownerContract === "vault",
  };
}

/** Every token withdrawal ever made through Xai Testnet's standard gateway, with live status. */
export async function loadExplorer(parent: PublicClient, child: PublicClient): Promise<ExplorerData> {
  const [childHead, parentHead] = await Promise.all([child.getBlockNumber(), parent.getBlockNumber()]);
  const [withdrawals, redirects, rollup] = await Promise.all([
    scanWithdrawals(child, childHead),
    scanRedirects(parent, parentHead),
    loadRollupState(parent, child),
  ]);
  const logs = withdrawals.logs;
  const tokenAddresses = [...new Map(logs.map((l) => [l.args.l1Token!.toLowerCase(), l.args.l1Token!])).values()];
  const [ownership, tokens, timestamps] = await Promise.all([
    readOwnership(parent, logs),
    readTokens(parent, tokenAddresses),
    readTimestamps(child, logs.map((l) => l.blockNumber)),
  ]);
  const exits = logs.map((l, i) =>
    toExit(l, {
      owner: ownership.owners[i],
      spent: ownership.spent[i],
      token: tokens.get(l.args.l1Token!.toLowerCase())!,
      timestamp: timestamps.get(l.blockNumber) ?? 0,
      redirects: redirects.byExit.get(l.args._exitNum!) ?? [],
      rollup,
    }),
  );
  return {
    exits: exits.sort((a, b) => (a.exitNum === b.exitNum ? 0 : a.exitNum > b.exitNum ? -1 : 1)),
    rollup,
    scan: { childFrom: XAI_GATEWAY_START_BLOCK, childTo: childHead, parentFrom: PARENT_REDIRECT_START_BLOCK, parentTo: parentHead, logCalls: withdrawals.calls + redirects.calls },
    scannedAt: Date.now(),
  };
}
