import { formatUnits, parseUnits } from "viem";
import { SECONDS_PER_L1_BLOCK, USDG_DECIMALS } from "./contracts";

export const APP_NAME = "Exit Market";

export function usdg(amount: bigint | undefined, digits = 2): string {
  if (amount === undefined) return "—";
  const n = Number(formatUnits(amount, USDG_DECIMALS));
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const USDG_INPUT = new RegExp(`^\\d+(\\.\\d{1,${USDG_DECIMALS}})?$`);

/** Parses a user-typed USDG amount; undefined for malformed, zero or over-precise input (never throws). */
export function parseUsdgInput(input: string): bigint | undefined {
  const trimmed = input.trim();
  if (!USDG_INPUT.test(trimmed)) return undefined;
  const value = parseUnits(trimmed, USDG_DECIMALS);
  return value > 0n ? value : undefined;
}

/** One readable line from a viem/wagmi/unknown error (viem's shortMessage when available). */
export function errorText(err: unknown): string {
  if (err && typeof err === "object" && "shortMessage" in err && typeof err.shortMessage === "string") {
    return err.shortMessage;
  }
  if (err instanceof Error) return err.message.split("\n")[0];
  return "Something went wrong";
}

export function shortHex(value: string, head = 6, tail = 4): string {
  return value.length <= head + tail + 2 ? value : `${value.slice(0, head + 2)}…${value.slice(-tail)}`;
}

export function bps(value: number | bigint): string {
  return `${(Number(value) / 100).toFixed(2)}%`;
}

/** Human duration for a number of L1 blocks (12s each). */
export function blocksToDuration(blocks: bigint): string {
  if (blocks <= 0n) return "now";
  const seconds = Number(blocks) * SECONDS_PER_L1_BLOCK;
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.ceil((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
