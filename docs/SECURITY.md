# Security model and audit log

Exit Market lets anyone buy an Arbitrum withdrawal that has not finished its challenge period.
The gateway primitive it builds on (`transferExitAndCall`) **does not validate the exit** — the
Offchain Labs source says so explicitly — so every guarantee below is enforced by our contracts.

## What is verified on-chain, inside the seller's transaction

| Check | How | Why |
|---|---|---|
| Market owns the exit | `gateway.getExternalCall(exitNum, initialDestination) == market` | the gateway already redirected it; `exitNum`/gateway come from the gateway call, never from calldata |
| Exit content | rebuild the Outbox item `finalizeInboundTransfer(token, from, to, amount, abi.encode(exitNum, ""))` from child gateway → parent gateway and fold the merkle proof | binds token, amount, sender, destination and exit number |
| Minimal path | `index < 2**proof.length`, `proof.length < 256` | MerkleLib ignores high index bits but `Outbox.isSpent` does not — a padded index would check the wrong slot |
| Root is real | confirmed in `Outbox.roots`, **or** committed by an unresolved legacy node: `firstUnresolvedNode ≤ n ≤ latestNodeCreated` and `getNode(n).confirmData == keccak256(blockHash, sendRoot)` | rejected legacy nodes are **not deleted** (`RollupCore._rejectNextNode` only bumps a counter) |
| Not yet claimed | `!Outbox.isSpent(index)` | once redirected, any later execution of *this item* pays the market's side |

Verification sources (child gateway, outbox, rollup) are **derived from the gateway**
(`inbox → bridge → rollup → outbox`, plus `bridge.allowedOutboxes`) and frozen with the verifier on first allow.

## Audit findings (ECC security-reviewer, code-reviewer, tdd-guide) and fixes

| ID | Severity | Finding | Status |
|---|---|---|---|
| D1 | High | Design assumed rejected nodes are deleted; they are not | Fixed: node-range check + re-check at buy |
| D2 | High | Exit executed while listed leaves tokens in the market | Fixed: `settle` path |
| F1 | **High** | *Spent-index aliasing drains the market*: `isSpent` is keyed by index only; a fake exit proven against a later-rejected node shares an index with a real message, then `settle` paid the attacker from pooled balances | Fixed: payout requires the index to hold **this item under a confirmed root** (`isExitPaidOut`). PoC kept as regression test `Exploits.t.sol` |
| F2 | **High** | Same root cause lets the vault `collect` money that never arrived (insolvency) | Fixed: `collect` requires `isExitPaidOut` |
| T1 | High | `writeOff` could strand a real exit that paid out under a sibling root | Fixed: `writeOff` requires a **fraud proof** — a confirmed root holding a *different* item for the same `exitNum` (exit numbers are unique per child gateway) |
| F4 | Medium | JIT deposits capture the whole purchase discount | Fixed: exits carried at cost, gain recognized at `collect`; 1-day share lock |
| T2 | Medium | Lock griefing via deposit-for-victim | Fixed: deposits mint to caller only; locked shares are non-transferable |
| C1 | Medium | Trust claim overstated (owner chooses the verifier) | Fixed: documented; verifier frozen per gateway, zero-address checks |
| C2 | Medium | Keepers could not rebuild records from events | Fixed: `ExitVerified(id, ExitRecord)` |

## Residual risks (accepted, documented)

- **Optimistic-rollup risk on pending proofs.** A listing proven against a node that is later rejected may be
  fake; buyers see `pending`/`nodeNum`, `buy` re-checks liveness, and the vault can cap size or refuse pending
  exits (`acceptPending`). On L3s with allowlisted validators this requires a malicious validator.
- **Owner trust.** The owner allowlists gateways and picks the root verifier; it cannot move user funds or
  change a gateway's sources after first allow. Fee is capped at 2% and snapshotted per listing.
- **Unsupported, fail-closed:** WETH gateway exits (leaf value ≠ 0), BOLD rollups (a BOLD `IRootVerifier` is the
  next adapter), fee-on-transfer exit tokens.
- **Vault liquidity.** Withdrawals are limited to idle USDG; outstanding exits return liquidity at confirmation.
