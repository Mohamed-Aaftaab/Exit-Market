import { getAddress, isHex, type Address, type Hex } from "viem";
import type { SellOrder } from "@shared/relay.ts";

/**
 * Cheap, local checks the relayer runs BEFORE any RPC work (re-audit R1–R4): strict request parsing, a fee
 * floor so the relayer never works for free, a pinned buyer/gateway, a per-IP rate limit, in-flight dedupe
 * and one settlement at a time (single relayer account → no nonce races). State is per server instance.
 */
export const MIN_RELAYER_FEE = 20_000n; // 0.02 USDG, the fee the web app signs
const MAX_DEADLINE_AHEAD_S = 7n * 24n * 60n * 60n;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 20;
/** Past this many tracked clients, entries whose window has passed are dropped (bounded memory per instance). */
const MAX_TRACKED_CLIENTS = 10_000;
const UINT256_MAX = (1n << 256n) - 1n;

export interface RelayRequest {
  withdrawalTx: Hex;
  order: SellOrder;
  signature: Hex;
}

type Parsed = { ok: true; value: RelayRequest } | { ok: false; error: string };

function uint(raw: unknown): bigint | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  if (!/^\d{1,78}$/.test(String(raw))) return undefined;
  const value = BigInt(String(raw));
  return value <= UINT256_MAX ? value : undefined;
}

function address(raw: unknown): Address | undefined {
  try {
    return typeof raw === "string" ? getAddress(raw) : undefined;
  } catch {
    return undefined;
  }
}

function parseOrder(raw: unknown): SellOrder | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const [gateway, buyer] = [address(o.gateway), address(o.buyer)];
  const [exitNum, minProceeds, relayerFee, deadline] = [o.exitNum, o.minProceeds, o.relayerFee, o.deadline].map(uint);
  if (!gateway || !buyer || exitNum === undefined || minProceeds === undefined) return undefined;
  if (relayerFee === undefined || deadline === undefined) return undefined;
  return { gateway, exitNum, buyer, minProceeds, relayerFee, deadline };
}

/** Validates a relay request against the only gateway and buyer this relayer serves. */
export function parseRelayRequest(body: unknown, expect: { gateway: Address; buyer: Address }): Parsed {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid body" };
  const b = body as Record<string, unknown>;
  const order = parseOrder(b.order);
  if (!order) return { ok: false, error: "Invalid order" };
  if (!isHex(b.withdrawalTx) || b.withdrawalTx.length !== 66) return { ok: false, error: "Invalid withdrawalTx" };
  if (!isHex(b.signature) || b.signature.length !== 132) return { ok: false, error: "Invalid signature" };
  if (order.gateway !== expect.gateway) return { ok: false, error: "Unsupported gateway" };
  if (order.buyer !== expect.buyer) return { ok: false, error: "Unsupported buyer" };
  if (order.relayerFee < MIN_RELAYER_FEE) return { ok: false, error: "Relayer fee below minimum" };
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (order.deadline < now) return { ok: false, error: "Order expired" };
  if (order.deadline > now + MAX_DEADLINE_AHEAD_S) return { ok: false, error: "Deadline too far ahead" };
  return { ok: true, value: { withdrawalTx: b.withdrawalTx, order, signature: b.signature } };
}

const hits = new Map<string, number[]>();

function pruneStale(nowMs: number): void {
  for (const [key, times] of hits) {
    if (times.every((t) => nowMs - t >= RATE_WINDOW_MS)) hits.delete(key);
  }
}

/** Number of clients the limiter currently remembers (for tests and monitoring). */
export function trackedClientCount(): number {
  return hits.size;
}

/** Sliding-window limit per client key; true when the request may proceed. */
export function allowRequest(clientKey: string, nowMs = Date.now()): boolean {
  if (hits.size >= MAX_TRACKED_CLIENTS) pruneStale(nowMs);
  const recent = (hits.get(clientKey) ?? []).filter((t) => nowMs - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX_REQUESTS) {
    hits.set(clientKey, recent);
    return false;
  }
  hits.set(clientKey, [...recent, nowMs]);
  return true;
}

const inFlight = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs `task` for `key` unless one is already running for it (returns undefined then), strictly one task at a
 * time across all keys, so the single relayer account never races its own nonce.
 */
export async function runExclusive<T>(key: string, task: () => Promise<T>): Promise<T | undefined> {
  if (inFlight.has(key)) return undefined;
  inFlight.add(key);
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  try {
    return await run;
  } finally {
    inFlight.delete(key);
  }
}
