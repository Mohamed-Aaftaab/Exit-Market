/** What the keeper knows about one exit the market verified, read fresh on every pass. */
export interface ExitFacts {
  /** Outbox.isSpent(index): the message at the exit's index was executed. */
  spent: boolean;
  /** The latest confirmed root commits to the exit's index (index < its send count). */
  covered: boolean;
  /** Under that root the index holds THIS exit's item. False when another message sits there (the exit was proven
   *  against a node that lost: its index belongs to a different withdrawal on the confirmed chain). */
  itemConfirmed: boolean;
  /** Set when the vault holds the exit. */
  vault: { writtenOff: boolean } | undefined;
  /** The exit is still an open listing on the market. */
  listed: boolean;
  /** ExitMarket.isExitRejected: the node it was proven against was rejected. */
  rejected: boolean;
}

export type KeeperStep =
  /** Execute through the Outbox if nobody has yet, then vault.collect. */
  | { kind: "collect" }
  /** Execute through the Outbox if nobody has yet, then market.settle (the seller gets face value). */
  | { kind: "settle" }
  /** Execute through the Outbox: the owner (a listing's buyer, a seller who cancelled) is paid directly. */
  | { kind: "execute" }
  /** vault.writeOff: stop carrying an exit that cannot pay out at cost (it stays collectable if it ever does). */
  | { kind: "write-off" }
  | { kind: "wait"; why: string }
  | { kind: "done" };

/**
 * The keeper's next step for one exit. Write-offs depend on rejection alone, not on how far the confirmed root
 * reaches: a rejected node's index range is soon covered by the honest chain, and an exit whose item is not at its
 * index under that root can never be collected, so it must not wait for one.
 */
export function keeperStep(f: ExitFacts): KeeperStep {
  const canWriteOff = f.vault !== undefined && !f.vault.writtenOff && f.rejected;

  if (!f.covered) {
    return canWriteOff ? { kind: "write-off" } : { kind: "wait", why: "pending, waiting for its root to confirm" };
  }
  if (!f.itemConfirmed) {
    if (canWriteOff) return { kind: "write-off" };
    // The vault's exit lost but its node is not rejected yet: it will be, and is written off then.
    if (f.vault && !f.vault.writtenOff) return { kind: "wait", why: "its node lost; waiting for the rollup to reject it" };
    return { kind: "done" }; // nothing a keeper can do: a listing's seller cancels it, a written-off exit stays as is
  }
  if (f.vault) return { kind: "collect" };
  if (f.listed) return { kind: "settle" };
  return f.spent ? { kind: "done" } : { kind: "execute" };
}
