import type { Address, Hex } from "viem";

/**
 * Pure state rules for gasless exits kept in the browser (no React, no storage): which intents still need the
 * relayer, and how a relayer response moves an intent along. Tested in intentStore.test.ts.
 */
export type IntentStatus =
  /** Withdrawn to the router, order not signed yet (signature rejected or tab closed mid-flow). */
  | "unsigned"
  /** Signed; waiting for the next rollup node or for vault liquidity. */
  | "waiting"
  /** The relayer had a temporary problem; retried automatically. */
  | "retrying"
  | "settled"
  /** The router no longer owns the exit: another relayer settled it, or it was reclaimed. */
  | "done-elsewhere"
  /** The chain rejected the order for good (expired, below minimum, bad signature…). Needs the user. */
  | "failed";

export type OrderFields = "gateway" | "exitNum" | "buyer" | "minProceeds" | "relayerFee" | "deadline";

/** One gasless exit. JSON-safe: bigints are decimal strings. */
export interface GaslessIntent {
  withdrawalTx: Hex;
  /** The wallet that withdrew (and must sign): one browser can hold several wallets' exits. Missing on older entries. */
  seller?: Address;
  amount: string;
  exitNum: string;
  order?: Record<OrderFields, string>;
  signature?: Hex;
  status: IntentStatus;
  detail?: string;
  settleTx?: Hex;
  updatedAt: number;
}

const POLLED: ReadonlySet<IntentStatus> = new Set(["waiting", "retrying"]);

/** Intents the relayer should be asked about on the next poll. */
export function needsRelay(intent: GaslessIntent): boolean {
  return POLLED.has(intent.status) && Boolean(intent.order && intent.signature);
}

/** The intents `address` may act on: its own, plus older entries that predate the seller field (owner unknown). */
export function intentsOf(list: readonly GaslessIntent[], address: Address | undefined): GaslessIntent[] {
  if (!address) return [];
  const me = address.toLowerCase();
  return list.filter((i) => !i.seller || i.seller.toLowerCase() === me);
}

/** Insert or replace by withdrawal tx, newest first. Never mutates `list`. */
export function upsertIntent(list: readonly GaslessIntent[], intent: GaslessIntent): GaslessIntent[] {
  return [intent, ...list.filter((i) => i.withdrawalTx !== intent.withdrawalTx)];
}

/**
 * Merges a batch of freshly relayed intents into the CURRENT list: an intent added or changed elsewhere while the
 * requests were in flight (another tab, a new exit) is kept, and a result only replaces the intent it came from.
 */
export function mergeRelayed(current: readonly GaslessIntent[], relayed: readonly GaslessIntent[]): GaslessIntent[] {
  const byTx = new Map(relayed.map((i) => [i.withdrawalTx, i]));
  return current.map((i) => {
    const next = byTx.get(i.withdrawalTx);
    return next && next.updatedAt >= i.updatedAt ? next : i;
  });
}

export interface RelayResponse {
  httpStatus: number;
  body: { status?: string; txHash?: Hex; reason?: string; error?: string; owner?: string } | undefined;
}

/** Moves `intent` according to one relayer response (or a network failure: `response` undefined). */
export function applyRelayResponse(intent: GaslessIntent, response: RelayResponse | undefined, now: number): GaslessIntent {
  const at = { ...intent, updatedAt: now };
  if (!response?.body) return { ...at, status: "retrying", detail: "Relayer unreachable, retrying" };
  const { httpStatus, body } = response;
  if (body.status === "settled" && body.txHash) return { ...at, status: "settled", settleTx: body.txHash, detail: undefined };
  if (body.status === "done-elsewhere") return { ...at, status: "done-elsewhere", detail: "Settled or reclaimed elsewhere" };
  if (body.status === "waiting") return { ...at, status: "waiting", detail: body.reason ?? "Waiting for the next rollup node" };
  // 4xx other than rate limiting is the order's own fault: stop polling and show why.
  if (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429) {
    return { ...at, status: "failed", detail: body.error ?? "Rejected by the relayer" };
  }
  return { ...at, status: "retrying", detail: body.error ?? "Relayer busy, retrying" };
}

export interface FailureAdvice {
  /** What happened and what the seller can do, in plain words. */
  text: string;
  /** A fresh signature fixes it (the old order only expired): offer to sign again. */
  canResign: boolean;
}

/** The router's OrderExpired revert, or the relayer's own pre-check that catches the same expiry before any RPC call. */
const EXPIRED = /^Order ?expired\b/i;

/** What a failed gasless exit needs from its seller, from the relayer's reason (a contract error name, args). */
export function failureAdvice(detail: string | undefined): FailureAdvice {
  if (detail !== undefined && EXPIRED.test(detail)) {
    return { text: "The signed order expired before it could settle. Sign a new one: it is free and needs no gas.", canResign: true };
  }
  return {
    text:
      `Not settled${detail ? ` (${detail})` : ""}. The exit is still yours: it can be returned to your address ` +
      "(node scripts/selfServe.ts reclaim <withdrawal tx>; anyone may do it after 3 days) and then claimed from the bridge.",
    canResign: false,
  };
}
