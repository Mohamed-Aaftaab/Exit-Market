"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { arbitrumSepolia } from "wagmi/chains";
import type { Address, Hash, PublicClient } from "viem";
import { findLatestNode, type AssertedNode } from "@shared/exitProof.ts";
import { getLogsChunked } from "@shared/logScan.ts";
import { XAI_GATEWAY_START_BLOCK, XAI_LOG_CHUNK } from "@/lib/explorer/constants";
import {
  ARBITRUM_SEPOLIA,
  DEPLOYMENT,
  XAI_TESTNET,
  outboxAbi,
  parentGatewayAbi,
  withdrawalInitiatedEvent,
} from "@/lib/contracts";
import { xaiTestnet } from "@/lib/wagmi";

/** Lifecycle of a withdrawal from the seller's point of view. */
export type WithdrawalStatus =
  | "awaiting-assertion" // not yet committed by any rollup node: can't be proven yet
  | "sellable" // committed by a node, unspent, still owned by the user
  | "gasless" // withdrawn to the intent router: the relayer sells it, no action needed
  | "listed" // held by the market as an open listing at the seller's price
  | "transferred" // exit redirected (sold) to someone else
  | "claimed"; // executed through the Outbox

export interface WithdrawalRow {
  txHash: Hash;
  exitNum: bigint;
  position: bigint;
  amount: bigint;
  l1Token: Address;
  initialDestination: Address;
  owner: Address;
  status: WithdrawalStatus;
}

export interface WithdrawalsData {
  rows: WithdrawalRow[];
  latestNode: AssertedNode;
}

function statusOf(user: Address, owner: Address, spent: boolean, asserted: boolean): WithdrawalStatus {
  if (spent) return "claimed";
  if (DEPLOYMENT.router && owner.toLowerCase() === DEPLOYMENT.router.toLowerCase()) return "gasless";
  // The market holds an exit only while it is listed (a sale or a cancel moves it on).
  if (DEPLOYMENT.market && owner.toLowerCase() === DEPLOYMENT.market.toLowerCase()) return "listed";
  if (owner.toLowerCase() !== user.toLowerCase()) return "transferred";
  return asserted ? "sellable" : "awaiting-assertion";
}

async function loadWithdrawals(parent: PublicClient, child: PublicClient, user: Address): Promise<WithdrawalsData> {
  const head = await child.getBlockNumber();
  const [{ logs }, latestNode] = await Promise.all([
    // Bounded chunks from the gateway's deployment block (bisected if the RPC refuses a range).
    getLogsChunked(
      (fromBlock, toBlock) =>
        child.getLogs({
          address: XAI_TESTNET.tokenBridge.childErc20Gateway,
          event: withdrawalInitiatedEvent,
          args: { _from: user },
          fromBlock,
          toBlock,
        }),
      XAI_GATEWAY_START_BLOCK,
      head,
      XAI_LOG_CHUNK,
    ),
    findLatestNode(parent, child, XAI_TESTNET.ethBridge.rollup),
  ]);

  const usdgLogs = logs.filter((l) => l.args.l1Token?.toLowerCase() === ARBITRUM_SEPOLIA.usdg.toLowerCase());

  const rows = await Promise.all(
    usdgLogs.map(async (l): Promise<WithdrawalRow> => {
      const { _to, _l2ToL1Id, _exitNum, _amount, l1Token } = l.args as Required<typeof l.args>;
      const [[owner], spent] = await Promise.all([
        parent.readContract({
          address: XAI_TESTNET.tokenBridge.parentErc20Gateway,
          abi: parentGatewayAbi,
          functionName: "getExternalCall",
          args: [_exitNum, _to, "0x"],
        }),
        parent.readContract({
          address: XAI_TESTNET.ethBridge.outbox,
          abi: outboxAbi,
          functionName: "isSpent",
          args: [_l2ToL1Id],
        }),
      ]);
      return {
        txHash: l.transactionHash,
        exitNum: _exitNum,
        position: _l2ToL1Id,
        amount: _amount,
        l1Token,
        initialDestination: _to,
        owner,
        status: statusOf(user, owner, spent, _l2ToL1Id < latestNode.sendCount),
      };
    }),
  );

  return { rows: rows.sort((a, b) => Number(b.exitNum - a.exitNum)), latestNode };
}

/** The connected user's USDG withdrawals from Xai Testnet, refreshed every 60s. */
export function useWithdrawals(user: Address | undefined) {
  const parent = usePublicClient({ chainId: arbitrumSepolia.id });
  const child = usePublicClient({ chainId: xaiTestnet.id });

  return useQuery({
    queryKey: ["withdrawals", user],
    enabled: Boolean(user && parent && child),
    refetchInterval: 60_000,
    queryFn: () => loadWithdrawals(parent as PublicClient, child as PublicClient, user as Address),
  });
}
