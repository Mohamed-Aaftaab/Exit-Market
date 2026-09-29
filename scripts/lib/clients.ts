import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { XAI_TESTNET } from "./networks.ts";

export const xaiTestnet = defineChain({
  id: XAI_TESTNET.chainId,
  name: XAI_TESTNET.name,
  nativeCurrency: { name: "sXAI", symbol: "sXAI", decimals: 18 },
  rpcUrls: { default: { http: [XAI_TESTNET.rpcUrl] } },
  blockExplorers: { default: { name: "Xai Explorer", url: XAI_TESTNET.explorerUrl } },
  testnet: true,
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env (see .env.example)`);
  return value;
}

export function getClients() {
  const account = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY") as Hex);
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
}

export function loadDeployment(): Deployment {
  return JSON.parse(readFileSync(new URL("../../deployments/arbitrumSepolia.json", import.meta.url), "utf8"));
}
