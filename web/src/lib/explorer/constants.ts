import { getAddress, type Address } from "viem";
import deployment from "../../../../deployments/arbitrumSepolia.json";

/**
 * First Xai Testnet block with code at XAI_TESTNET.tokenBridge.childErc20Gateway. Found on 2026-09-29 by
 * binary-searching eth_getCode(gateway, block) against XAI_TESTNET.rpcUrl: empty at 3,114, deployed at 3,115.
 * No WithdrawalInitiated can predate it (the first real one is at block 222,561).
 */
export const XAI_GATEWAY_START_BLOCK = 3_115n;

/**
 * Arbitrum Sepolia block at the child gateway's deployment time (Xai block 3,115 = 2023-11-29T02:06:55Z), found by
 * binary-searching Arbitrum Sepolia block timestamps. An exit cannot be redirected before its withdrawal exists,
 * so WithdrawRedirected scans on the parent gateway start here.
 */
export const PARENT_REDIRECT_START_BLOCK = 1_653_340n;

/** getLogs spans. Both public RPCs answered full-range, address-filtered queries in <300ms on 2026-09-29;
 *  chunks keep each request bounded as the chains grow, and failed chunks are bisected (see scripts/lib/logScan.ts). */
export const XAI_LOG_CHUNK = 5_000_000n;
export const PARENT_LOG_CHUNK = 100_000_000n;

/** NodeCreated lookback on Arbitrum Sepolia (~4 blocks/s → ~6 days) for the confirmed and pending rollup nodes. */
export const NODE_LOOKBACK = 2_000_000n;
/** Upper bound on pending (created, unconfirmed) nodes read per refresh. */
export const MAX_PENDING_NODES = 32;

export const PARENT_EXPLORER_URL = "https://sepolia.arbiscan.io";
/** Where our contracts' source can be read: Blockscout shows the code verified on Sourcify (exact match). */
export const PARENT_CODE_EXPLORER_URL = "https://arbitrum-sepolia.blockscout.com";
export const MAINNET_EXPLORER_URL = "https://arbiscan.io";

export type OurContract = "market" | "vault" | "router";

export const OUR_CONTRACT_LABEL: Record<OurContract, string> = {
  market: "ExitMarket",
  vault: "ExitVault",
  router: "Intent router",
};

function safeAddress(value: string | undefined): Address | undefined {
  if (!value) return undefined;
  try {
    return getAddress(value);
  } catch {
    return undefined;
  }
}

type ContractSet = { market?: string; vault?: string; router?: string };

const KINDS: readonly OurContract[] = ["market", "vault", "router"];

/**
 * Exit Market contracts on Arbitrum Sepolia, from deployments/arbitrumSepolia.json: the live set plus every earlier
 * version under `history`, so exits bought by a superseded vault or router are still labelled as ours.
 */
export const OUR_CONTRACTS: ReadonlyArray<{ kind: OurContract; address: Address }> = [
  deployment as ContractSet,
  ...Object.values((deployment as { history?: Record<string, ContractSet> }).history ?? {}),
].flatMap((set) =>
  KINDS.flatMap((kind) => {
    const address = safeAddress(set[kind]);
    return address ? [{ kind, address }] : [];
  }),
);

/** Which of our contracts (if any) is `address`. */
export function ourContract(address: Address | undefined): OurContract | undefined {
  if (!address) return undefined;
  const lower = address.toLowerCase();
  return OUR_CONTRACTS.find((c) => c.address.toLowerCase() === lower)?.kind;
}
