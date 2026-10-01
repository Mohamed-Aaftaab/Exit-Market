import type { Address, Hash } from "viem";
import type { OurContract } from "./constants";
import type { RollupState } from "./rollupState";

/** Where the withdrawal is in the rollup lifecycle, regardless of who owns it. */
export type ExitStage = "awaiting-assertion" | "in-window" | "confirmed" | "claimed";

/** What the table shows: lifecycle, except that a redirected, unclaimed exit shows as transferred. */
export type ExitStatus = "awaiting-assertion" | "in-window" | "stranded" | "claimed" | "transferred";

export interface Redirect {
  from: Address;
  to: Address;
  txHash: Hash;
  blockNumber: bigint;
}

export interface ExitToken {
  address: Address;
  symbol: string | undefined;
  decimals: number | undefined;
}

export interface ExplorerExit {
  exitNum: bigint;
  /** L2->L1 message id = Outbox index. */
  position: bigint;
  txHash: Hash;
  blockNumber: bigint;
  /** Unix seconds of the Xai block. */
  timestamp: number;
  token: ExitToken;
  amount: bigint;
  sender: Address;
  initialDestination: Address;
  /** Current owner per gateway.getExternalCall (the initial destination unless redirected). */
  owner: Address;
  stage: ExitStage;
  status: ExitStatus;
  /** L1 blocks until the including node's challenge deadline (in-window only). */
  blocksLeft: bigint | undefined;
  redirects: Redirect[];
  ownerContract: OurContract | undefined;
  viaExitMarket: boolean;
}

/**
 * Stage of message `position`: claimed if the Outbox slot is spent, confirmed if the latest confirmed node commits
 * it, in-window if a pending node does (time left = that node's deadline), otherwise not yet asserted.
 * Pending nodes beyond MAX_PENDING_NODES are not read, so a position only they cover reads as awaiting assertion.
 */
export function stageOf(position: bigint, spent: boolean, rollup: RollupState): { stage: ExitStage; blocksLeft?: bigint } {
  if (spent) return { stage: "claimed" };
  if (position < rollup.confirmed.sendCount) return { stage: "confirmed" };
  const node = rollup.pending.find((n) => position < n.sendCount);
  if (!node) return { stage: "awaiting-assertion" };
  const blocksLeft = node.deadlineBlock > rollup.l1Block ? node.deadlineBlock - rollup.l1Block : 0n;
  return { stage: "in-window", blocksLeft };
}

/**
 * Exit Market's part in a redirected, unclaimed exit: "listed" while the market itself holds it (a listing nobody has
 * bought yet), "sold" once it passed through the market to a buyer, undefined when the market was never involved.
 */
export function marketRole(exit: Pick<ExplorerExit, "status" | "ownerContract" | "viaExitMarket">): "listed" | "sold" | undefined {
  if (exit.status !== "transferred") return undefined;
  if (exit.ownerContract === "market") return "listed";
  return exit.viaExitMarket ? "sold" : undefined;
}

export function statusOf(stage: ExitStage, transferred: boolean): ExitStatus {
  if (stage === "claimed") return "claimed";
  if (transferred) return "transferred";
  if (stage === "confirmed") return "stranded";
  return stage;
}

export interface TokenTotal {
  token: ExitToken;
  amount: bigint;
}

export interface Bucket {
  count: number;
  totals: TokenTotal[];
}

export interface ExplorerSummary {
  total: number;
  inWindow: Bucket;
  stranded: Bucket;
  viaExitMarket: Bucket;
}

/** Sums amounts per token, largest count of exits first. */
export function bucketOf(exits: ExplorerExit[]): Bucket {
  const byToken = new Map<string, { total: TokenTotal; n: number }>();
  for (const e of exits) {
    const key = e.token.address.toLowerCase();
    const prev = byToken.get(key);
    byToken.set(key, { total: { token: e.token, amount: (prev?.total.amount ?? 0n) + e.amount }, n: (prev?.n ?? 0) + 1 });
  }
  const totals = [...byToken.values()].sort((a, b) => b.n - a.n).map((v) => v.total);
  return { count: exits.length, totals };
}

export function summarize(exits: ExplorerExit[]): ExplorerSummary {
  return {
    total: exits.length,
    inWindow: bucketOf(exits.filter((e) => e.stage === "in-window")),
    stranded: bucketOf(exits.filter((e) => e.stage === "confirmed")),
    viaExitMarket: bucketOf(exits.filter((e) => e.viaExitMarket)),
  };
}
