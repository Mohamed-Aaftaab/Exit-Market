"use client";

import { useQuery } from "@tanstack/react-query";
import { childClient, parentClient } from "@/lib/explorer/clients";
import { loadExplorer } from "@/lib/explorer/loadExits";

/** Every Xai Testnet standard-gateway exit with its live status, rescanned every 60s. */
export function useExitExplorer() {
  return useQuery({
    queryKey: ["exit-explorer"],
    queryFn: () => loadExplorer(parentClient, childClient),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
