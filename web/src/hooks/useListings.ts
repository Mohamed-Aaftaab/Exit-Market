"use client";

import { useQuery } from "@tanstack/react-query";
import type { PublicClient } from "viem";
import { usePublicClient } from "wagmi";
import { arbitrumSepolia } from "wagmi/chains";
import { loadOpenListings, type OpenListing } from "@shared/listings.ts";
import { DEPLOYMENT } from "@/lib/contracts";

export interface ListingsData {
  listings: OpenListing[];
  /** Inside Arbitrum's EVM, block.number is the L1 block that rollup deadlines count in. */
  currentL1Block: bigint;
  /** Parent-chain block time, which listing expiries are compared against on-chain. */
  chainTime: bigint;
}

async function loadListings(parent: PublicClient): Promise<ListingsData> {
  const { market, deployBlock } = DEPLOYMENT;
  if (!market) throw new Error("Market not configured (NEXT_PUBLIC_EXIT_MARKET)");
  const [listings, block] = await Promise.all([loadOpenListings(parent, market, deployBlock), parent.getBlock()]);
  return {
    listings,
    currentL1Block: BigInt((block as unknown as { l1BlockNumber: string }).l1BlockNumber),
    chainTime: block.timestamp,
  };
}

/** Every open listing on the live market, with its liveness, refreshed every 30s. */
export function useListings() {
  const parent = usePublicClient({ chainId: arbitrumSepolia.id });
  return useQuery({
    queryKey: ["listings", DEPLOYMENT.market],
    enabled: Boolean(parent && DEPLOYMENT.market),
    refetchInterval: 30_000,
    queryFn: () => loadListings(parent as PublicClient),
  });
}
