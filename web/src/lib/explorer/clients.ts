import { createPublicClient, http, type PublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { ARBITRUM_SEPOLIA, XAI_TESTNET } from "@shared/networks.ts";
import { xaiTestnet } from "@/lib/wagmi";

/**
 * Read-only clients for the explorer, independent of the connected wallet. JSON-RPC batching folds the per-exit
 * block reads and per-node header reads into a handful of HTTP requests to the public endpoints.
 */
const transportOptions = { batch: { batchSize: 50 }, retryCount: 2, timeout: 20_000 } as const;

export const parentClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(ARBITRUM_SEPOLIA.rpcUrl, transportOptions),
}) as PublicClient;

export const childClient = createPublicClient({
  chain: xaiTestnet,
  transport: http(XAI_TESTNET.rpcUrl, transportOptions),
}) as PublicClient;
