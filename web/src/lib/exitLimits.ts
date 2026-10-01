import { usdg } from "./format.ts";

/**
 * What the market and the vault will refuse, known before the user signs anything: an action the chain would reject
 * is never offered, and a fast exit the vault cannot buy is stopped before its (irreversible) withdrawal.
 */

/** Flat fee paid to whoever relays a gasless exit (USDG, 6 decimals). */
export const RELAYER_FEE = 20_000n; // 0.02 USDG
/** Seller-side slippage bound for gasless orders: accept at least 99% of face value (minus relayer fee). */
export const GASLESS_MIN_BPS = 9_900n;
const BPS = 10_000n;

/** Smallest amount whose signed order still leaves the seller something after the 99% floor and the relayer fee. */
export const MIN_GASLESS_AMOUNT = ((RELAYER_FEE + 1n) * BPS + GASLESS_MIN_BPS - 1n) / GASLESS_MIN_BPS;

/** A fast exit is sold to the vault, so it must also clear the vault's own minimum (ExitVault.minExitAmount). */
export function fastExitMinimum(vaultMinExit: bigint): bigint {
  return vaultMinExit > MIN_GASLESS_AMOUNT ? vaultMinExit : MIN_GASLESS_AMOUNT;
}

export interface VaultLimits {
  /** ExitVault.minExitAmount */
  minExit: bigint;
  /** ExitVault.maxExitAmount */
  maxExit: bigint;
}

/** Why the vault would refuse an exit of `amount` whatever its proof (ExitTooSmall / ExitTooLarge), or undefined. */
export function vaultSizeRefusal(amount: bigint, limits: VaultLimits): string | undefined {
  if (amount < limits.minExit) return `Below the vault's ${usdg(limits.minExit)} USDG minimum.`;
  if (amount > limits.maxExit) return `Above the vault's ${usdg(limits.maxExit)} USDG maximum.`;
  return undefined;
}

/** The checks ExitMarket repeats on-chain for any sale or listing. */
export interface ProofChecks {
  ownerIsSeller: boolean;
  minimalPath: boolean;
  unspent: boolean;
  /** The market's verifier accepts the root (for a pending node: no rival anywhere on its pending chain). */
  rootValid: boolean;
}

/** Why the market would refuse to sell or list this exit right now, or undefined when every check passes. */
export function proofBlocker(c: ProofChecks): string | undefined {
  if (!c.ownerIsSeller) return "You no longer own this exit.";
  if (!c.unspent) return "This exit was already claimed through the Outbox.";
  if (!c.minimalPath) return "The withdrawal proof does not check out against the send tree.";
  if (!c.rootValid) return "Its rollup node is disputed or not provable right now. It becomes sellable once the node confirms.";
  return undefined;
}
