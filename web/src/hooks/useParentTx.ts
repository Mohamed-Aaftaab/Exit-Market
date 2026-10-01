"use client";

import type { Hash } from "viem";
import { useAccount, usePublicClient, useSwitchChain } from "wagmi";
import { arbitrumSepolia } from "wagmi/chains";

const RECEIPT_TIMEOUT_MS = 120_000;

/** Sends a transaction on Arbitrum Sepolia (switching the wallet there first) and waits for it; throws if it reverted. */
export function useParentTx() {
  const { chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const parent = usePublicClient({ chainId: arbitrumSepolia.id });
  return async (send: () => Promise<Hash>): Promise<Hash> => {
    if (!parent) throw new Error("Arbitrum Sepolia client unavailable");
    if (chainId !== arbitrumSepolia.id) await switchChainAsync({ chainId: arbitrumSepolia.id });
    const hash = await send();
    const receipt = await parent.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
    return hash;
  };
}
