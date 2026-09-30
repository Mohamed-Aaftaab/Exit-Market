import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { XAI_TESTNET, xaiTestnet } from "./networks.ts";

export { xaiTestnet };

/** Value of the first of `names` that is set, so a role key can fall back to the deployer's. */
function requireEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`Missing ${names.join(" or ")} in .env (see .env.example)`);
}

/** @param keyEnv env vars tried in order for the signing key (default: the deployer's). */
export function getClients(keyEnv: readonly string[] = ["DEPLOYER_PRIVATE_KEY"]) {
  const account = privateKeyToAccount(requireEnv(...keyEnv) as Hex);
  const parentRpc = process.env.ARB_SEPOLIA_RPC_URL ?? arbitrumSepolia.rpcUrls.default.http[0];
  return {
    account,
    parent: createPublicClient({ chain: arbitrumSepolia, transport: http(parentRpc) }),
    parentWallet: createWalletClient({ account, chain: arbitrumSepolia, transport: http(parentRpc) }),
    child: createPublicClient({ chain: xaiTestnet, transport: http(XAI_TESTNET.rpcUrl) }),
    childWallet: createWalletClient({ account, chain: xaiTestnet, transport: http(XAI_TESTNET.rpcUrl) }),
  };
}

export interface Deployment {
  chainId: number;
  usdg: Address;
  verifier: Address;
  market: Address;
  vault: Address;
  router?: Address;
  /** Arbitrum Sepolia block the deployment starts at; event scans begin here when it is recorded. */
  deployBlock?: number;
}

export function loadDeployment(): Deployment {
  return JSON.parse(readFileSync(new URL("../../deployments/arbitrumSepolia.json", import.meta.url), "utf8"));
}
