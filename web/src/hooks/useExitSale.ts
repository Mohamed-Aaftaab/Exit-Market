"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { arbitrumSepolia } from "wagmi/chains";
import { encodePacked, keccak256, type Hash, type PublicClient } from "viem";
import { buildExitProof, type Withdrawal } from "@shared/exitProof.ts";
import { encodeSellToBuyer, netOfMarketFee } from "@shared/hookData.ts";
import { exitRecordFor } from "@shared/marketReads.ts";
import { DEPLOYMENT, XAI_TESTNET, marketAbi, outboxAbi, parentGatewayAbi, rollupAbi, vaultAbi } from "@/lib/contracts";
import { xaiTestnet } from "@/lib/wagmi";
import type { WithdrawalRow } from "./useWithdrawals";

export interface PreparedSale {
  withdrawal: Withdrawal;
  /** The ExitRecord the market will build, from its own verifier's verdict (pending or confirmed, deadline). */
  record: Awaited<ReturnType<typeof exitRecordFor>>["record"];
  /** Checks the market will repeat on-chain, evaluated client-side for the proof trace. */
  checks: {
    ownerIsSeller: boolean;
    minimalPath: boolean;
    unspent: boolean;
    /** The market's verifier accepts the root (for a pending node: also no rival anywhere on its pending chain). */
    rootValid: boolean;
    /** The root is a pending node's rather than one confirmed in the Outbox. */
    rootPending: boolean;
    /** For a pending root: the node's confirmData commits to (blockHash, sendRoot). */
    nodeCommitsRoot: boolean;
  };
  deadlineBlock: bigint;
  currentL1Block: bigint;
  vaultQuote: bigint;
  /** USDG the vault holds idle right now; a sale needs at least `vaultQuote` of it. */
  vaultIdle: bigint;
  marketFeeBps: number;
}

const GATEWAYS = { parent: XAI_TESTNET.tokenBridge.parentErc20Gateway, child: XAI_TESTNET.tokenBridge.childErc20Gateway };

async function prepareSale(parent: PublicClient, child: PublicClient, row: WithdrawalRow): Promise<PreparedSale> {
  const { market, vault } = DEPLOYMENT;
  if (!market || !vault) throw new Error("Contracts not configured (NEXT_PUBLIC_EXIT_MARKET / NEXT_PUBLIC_EXIT_VAULT)");

  const withdrawal = await buildExitProof({
    parent,
    child,
    rollup: XAI_TESTNET.ethBridge.rollup,
    childGateway: XAI_TESTNET.tokenBridge.childErc20Gateway,
    withdrawalTx: row.txHash,
  });
  const p = withdrawal.proof;

  const [{ record, verdict }, node, feeBps, l1Block, spent] = await Promise.all([
    exitRecordFor(parent, market, GATEWAYS, withdrawal),
    parent.readContract({ address: XAI_TESTNET.ethBridge.rollup, abi: rollupAbi, functionName: "getNode", args: [p.nodeNum] }),
    parent.readContract({ address: market, abi: marketAbi, functionName: "feeBps" }),
    // Inside Arbitrum's EVM, block.number is the L1 block; the RPC exposes it as l1BlockNumber.
    parent.getBlock().then((b) => BigInt((b as unknown as { l1BlockNumber: string }).l1BlockNumber)),
    parent.readContract({ address: XAI_TESTNET.ethBridge.outbox, abi: outboxAbi, functionName: "isSpent", args: [p.index] }),
  ]);
  const [vaultQuote, vaultIdle] = await Promise.all([
    parent.readContract({ address: vault, abi: vaultAbi, functionName: "quote", args: [record] }),
    parent.readContract({ address: vault, abi: vaultAbi, functionName: "idleAssets" }),
  ]);

  return {
    withdrawal,
    record,
    checks: {
      ownerIsSeller: row.owner.toLowerCase() === row.initialDestination.toLowerCase(),
      minimalPath: p.index < 2n ** BigInt(p.merkleProof.length),
      unspent: !spent,
      rootValid: verdict.valid,
      rootPending: verdict.pending,
      nodeCommitsRoot: node.confirmData === keccak256(encodePacked(["bytes32", "bytes32"], [p.blockHash, p.sendRoot])),
    },
    deadlineBlock: verdict.deadlineBlock,
    currentL1Block: l1Block,
    vaultQuote,
    vaultIdle,
    marketFeeBps: feeBps,
  };
}
/** Builds the proof and vault quote for a sellable withdrawal. */
export function usePreparedSale(row: WithdrawalRow | undefined) {
  const parent = usePublicClient({ chainId: arbitrumSepolia.id });
  const child = usePublicClient({ chainId: xaiTestnet.id });
  return useQuery({
    queryKey: ["prepared-sale", row?.txHash],
    enabled: Boolean(row && row.status === "sellable" && parent && child),
    refetchInterval: 60_000,
    staleTime: 30_000,
    queryFn: () => prepareSale(parent as PublicClient, child as PublicClient, row as WithdrawalRow),
  });
}

/** One signature: redirect the exit to the market, which proves it and sells it to the vault atomically. */
export function useSellExit() {
  const { chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const parent = usePublicClient({ chainId: arbitrumSepolia.id });
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sale: PreparedSale): Promise<Hash> => {
      const { market, vault } = DEPLOYMENT;
      if (!market || !vault) throw new Error("Contracts not configured");
      if (!parent) throw new Error("Arbitrum Sepolia client unavailable");
      if (chainId !== arbitrumSepolia.id) await switchChainAsync({ chainId: arbitrumSepolia.id });

      const w = sale.withdrawal;
      // The quote only rises as the deadline approaches, so the prepared quote is a safe minimum.
      const hash = await writeContractAsync({
        chainId: arbitrumSepolia.id,
        address: XAI_TESTNET.tokenBridge.parentErc20Gateway,
        abi: parentGatewayAbi,
        functionName: "transferExitAndCall",
        // The seller's floor is net of the market fee; the quote only rises toward the deadline, so it holds.
        args: [
          w.exitNum,
          w.initialDestination,
          market,
          "0x",
          encodeSellToBuyer(w, vault, netOfMarketFee(sale.vaultQuote, sale.marketFeeBps)),
        ],
      });
      const receipt = await parent.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error("Sale transaction reverted");
      return hash;
    },
    // Refresh everything the sale changed: exit ownership, vault stats, balances.
    onSuccess: () => queryClient.invalidateQueries(),
  });
}
