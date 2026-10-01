import { formatUnits, parseUnits } from "viem";

export const APP_NAME = "Exit Market";
export const USDG_DECIMALS = 6;
/** Rollup deadlines are in L1 blocks; Ethereum targets 12s blocks. */
export const SECONDS_PER_L1_BLOCK = 12;

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

/** Human duration for a number of L1 blocks (12s each), rounded up to the minute. */
export function blocksToDuration(blocks: bigint): string {
  return secondsToDuration(blocks * BigInt(SECONDS_PER_L1_BLOCK));
}

/** Human duration for a number of seconds, rounded up to the minute. */
export function secondsToDuration(seconds: bigint): string {
  if (seconds <= 0n) return "now";
  // Round once, then split: rounding each unit separately printed "1h 60m" and "23h 60m".
  const totalMinutes = Math.ceil(Number(seconds) / 60);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
