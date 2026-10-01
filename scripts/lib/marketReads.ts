import type { Address, PublicClient } from "viem";
import { exitMarketAbi, legacyRootVerifierAbi } from "./abis.ts";
import type { Withdrawal } from "./exitProof.ts";
import { toExitRecord } from "./hookData.ts";

/** What the market's own root verifier says about a claim's root, i.e. what ExitMarket will record. */
export interface RootVerdict {
  valid: boolean;
  /** False once the root is confirmed in the Outbox (no rollup risk, no wait). */
  pending: boolean;
  /** L1 block after which the root's node can confirm; 0 for a confirmed root. */
  deadlineBlock: bigint;
}

/**
 * Asks the verifier ExitMarket froze for `gateway` (both verifiers share verifyRoot's signature) about the claim's
 * root, so callers never re-derive pending/deadline logic off-chain.
 */
export async function rootVerdict(parent: PublicClient, market: Address, gateway: Address, w: Withdrawal): Promise<RootVerdict> {
  const cfg = await parent.readContract({ address: market, abi: exitMarketAbi, functionName: "getGatewayConfig", args: [gateway] });
  const [valid, pending, deadlineBlock] = await parent.readContract({
    address: cfg.verifier,
    abi: legacyRootVerifierAbi,
    functionName: "verifyRoot",
    args: [cfg.rollup, cfg.outbox, w.proof.sendRoot, w.proof.nodeNum, w.proof.blockHash],
  });
  return { valid, pending, deadlineBlock };
}

/** The ExitRecord ExitMarket will build for `w` (for ExitVault.quote before selling), plus the verdict behind it. */
export async function exitRecordFor(
  parent: PublicClient,
  market: Address,
  gateways: { parent: Address; child: Address },
  w: Withdrawal,
) {
  const verdict = await rootVerdict(parent, market, gateways.parent, w);
  return { record: toExitRecord(w, gateways, verdict.deadlineBlock, verdict.pending), verdict };
}
