"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Address, Hash, Hex } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { arbitrumSepolia } from "wagmi/chains";
import { encodeList } from "@shared/hookData.ts";
import type { Withdrawal } from "@shared/exitProof.ts";
import { ARBITRUM_SEPOLIA, DEPLOYMENT, XAI_TESTNET, erc20Abi, marketAbi, parentGatewayAbi } from "@/lib/contracts";
import { useParentTx } from "./useParentTx";

function requireMarket(): Address {
  if (!DEPLOYMENT.market) throw new Error("Market not configured (NEXT_PUBLIC_EXIT_MARKET)");
  return DEPLOYMENT.market;
}

/** Everything a listing changes (exit ownership, listings, balances) is refetched after it lands. */
function useRefreshAll() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries();
}

export interface ListRequest {
  withdrawal: Withdrawal;
  price: bigint;
  /** How long the listing stays buyable; after that anyone can cancel it back to the seller. */
  durationSeconds: bigint;
}

/** One signature: redirect the exit to the market, which proves it on-chain and lists it at `price`. */
export function useListExit() {
  const parent = usePublicClient({ chainId: arbitrumSepolia.id });
  const { writeContractAsync } = useWriteContract();
  const sendTx = useParentTx();
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: async ({ withdrawal: w, price, durationSeconds }: ListRequest): Promise<Hash> => {
      const market = requireMarket();
      if (!parent) throw new Error("Arbitrum Sepolia client unavailable");
      // The market compares expiry with the chain's block time, so count from it rather than the local clock.
      const expiry = (await parent.getBlock()).timestamp + durationSeconds;
      return sendTx(() =>
        writeContractAsync({
          chainId: arbitrumSepolia.id,
          address: XAI_TESTNET.tokenBridge.parentErc20Gateway,
          abi: parentGatewayAbi,
          functionName: "transferExitAndCall",
          args: [w.exitNum, w.initialDestination, market, "0x", encodeList(w, price, expiry)],
        }),
      );
    },
    onSuccess: refresh,
  });
}

/**
 * Buys a listing: approves the market for exactly `price` when the allowance is short (never a standing
 * approval), then calls buy with `price` as the cap, so a changed listing cannot charge more.
 */
export function useBuyListing() {
  const { address } = useAccount();
  const parent = usePublicClient({ chainId: arbitrumSepolia.id });
  const { writeContractAsync } = useWriteContract();
  const sendTx = useParentTx();
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: async ({ id, price }: { id: Hex; price: bigint }): Promise<Hash> => {
      const market = requireMarket();
      if (!address || !parent) throw new Error("Connect a wallet first");
      const [balance, allowance] = await Promise.all([
        parent.readContract({ address: ARBITRUM_SEPOLIA.usdg, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
        parent.readContract({ address: ARBITRUM_SEPOLIA.usdg, abi: erc20Abi, functionName: "allowance", args: [address, market] }),
      ]);
      if (balance < price) throw new Error("Not enough USDG on Arbitrum Sepolia for this listing");
      if (allowance < price) {
        await sendTx(() =>
          writeContractAsync({
            chainId: arbitrumSepolia.id,
            address: ARBITRUM_SEPOLIA.usdg,
            abi: erc20Abi,
            functionName: "approve",
            args: [market, price],
          }),
        );
      }
      return sendTx(() =>
        writeContractAsync({ chainId: arbitrumSepolia.id, address: market, abi: marketAbi, functionName: "buy", args: [id, price] }),
      );
    },
    onSuccess: refresh,
  });
}

/** The seller cancels any time; after expiry anyone can, and the exit goes back to the seller either way. */
export function useCancelListing() {
  const { writeContractAsync } = useWriteContract();
  const sendTx = useParentTx();
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (id: Hex): Promise<Hash> => {
      const market = requireMarket();
      return sendTx(() =>
        writeContractAsync({ chainId: arbitrumSepolia.id, address: market, abi: marketAbi, functionName: "cancel", args: [id] }),
      );
    },
    onSuccess: refresh,
  });
}
