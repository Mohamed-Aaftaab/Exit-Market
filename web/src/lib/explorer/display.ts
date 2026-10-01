import { formatUnits, type Address, type Hash } from "viem";
import { XAI_TESTNET } from "@shared/networks.ts";
import { shortHex } from "@/lib/format";
import { MAINNET_EXPLORER_URL, OUR_CONTRACT_LABEL, PARENT_CODE_EXPLORER_URL, PARENT_EXPLORER_URL } from "./constants";
import type { ExitToken, ExplorerExit, TokenTotal } from "./status";

const DEFAULT_DECIMALS = 18;

export const xaiTxUrl = (hash: Hash) => `${XAI_TESTNET.explorerUrl}/tx/${hash}`;
export const xaiAddressUrl = (address: Address) => `${XAI_TESTNET.explorerUrl}/address/${address}`;
export const parentTxUrl = (hash: Hash) => `${PARENT_EXPLORER_URL}/tx/${hash}`;
export const parentAddressUrl = (address: Address) => `${PARENT_EXPLORER_URL}/address/${address}`;
/** One of our contracts, opened on its verified source. */
export const contractCodeUrl = (address: Address) => `${PARENT_CODE_EXPLORER_URL}/address/${address}?tab=contract`;
export const mainnetTxUrl = (hash: string) => `${MAINNET_EXPLORER_URL}/tx/${hash}`;

export function tokenSymbol(token: ExitToken): string {
  return token.symbol ?? shortHex(token.address, 4, 4);
}

/** Human amount: up to 4 decimals below 1,000, 2 above (display only; Number precision is enough). */
export function tokenAmount(amount: bigint, decimals: number | undefined): string {
  const n = Number(formatUnits(amount, decimals ?? DEFAULT_DECIMALS));
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1_000 ? 2 : 4 });
}

/** "1,200 USDG" or "1,200 USDG + 2 more tokens" for a bucket's per-token totals. */
export function totalsText(totals: TokenTotal[]): string {
  const [first, ...rest] = totals;
  if (!first) return "—";
  const lead = `${tokenAmount(first.amount, first.token.decimals)} ${tokenSymbol(first.token)}`;
  if (rest.length === 0) return lead;
  return `${lead} + ${rest.length} more token${rest.length === 1 ? "" : "s"}`;
}

/** Compact age: "45s", "12m", "5h 3m", "4d 6h", "212d". */
export function ageText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** "$5.06M", "$676K" (compact USD for research figures). */
export function usdCompact(value: number, digits = 2): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: digits,
  });
}

export function integer(value: number | bigint): string {
  return value.toLocaleString("en-US");
}

/** Owner label: one of our contracts by name, else a short address. */
export function ownerLabel(exit: ExplorerExit): string {
  return exit.ownerContract ? OUR_CONTRACT_LABEL[exit.ownerContract] : shortHex(exit.owner);
}

/** Only http(s) URLs from configuration become links. */
export function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString().replace(/\/$/, "") : undefined;
  } catch {
    return undefined;
  }
}
