# Security model and audit log

Exit Market lets anyone buy an Arbitrum withdrawal that has not finished its challenge period.
The gateway primitive it builds on (`transferExitAndCall`) **does not validate the exit** — the
Offchain Labs source says so explicitly — so every guarantee below is enforced by our contracts.

## What is verified on-chain, inside the seller's transaction

(For BOLD rollups the "root is real" row uses `BoldRootVerifier`; see Residual risks.)

| Check | How | Why |
|---|---|---|
| Market owns the exit | `gateway.getExternalCall(exitNum, initialDestination) == market` | the gateway already redirected it; `exitNum`/gateway come from the gateway call, never from calldata |
| Exit content | rebuild the Outbox item `finalizeInboundTransfer(token, from, to, amount, abi.encode(exitNum, ""))` from child gateway → parent gateway and fold the merkle proof | binds token, amount, sender, destination and exit number |
| Minimal path | `index < 2**proof.length`, `proof.length < 256` | MerkleLib ignores high index bits but `Outbox.isSpent` does not — a padded index would check the wrong slot |
| Root is real | confirmed in `Outbox.roots`, **or** committed by an unresolved legacy node: `firstUnresolvedNode ≤ n ≤ latestNodeCreated` and `getNode(n).confirmData == keccak256(blockHash, sendRoot)` | rejected legacy nodes are **not deleted** (`RollupCore._rejectNextNode` only bumps a counter) |
| Not yet claimed | `!Outbox.isSpent(index)` | once redirected, any later execution of *this item* pays the market's side |

Verification sources (child gateway, outbox, rollup) are **derived from the gateway**
(`inbox → bridge → rollup → outbox`, plus `bridge.allowedOutboxes`) and frozen with the verifier on first allow.

## Review findings and fixes

Internal reviews by specialised AI review agents (ECC security-reviewer, code-reviewer, tdd-guide) plus Slither,
fuzz and fork tests. **This is not a third-party audit.** Every High/Critical finding has a regression test that
reproduced the loss before its fix.

### Rounds 1–3 (market and vault)

| ID | Severity | Finding | Status |
|---|---|---|---|
| D1 | High | Design assumed rejected nodes are deleted; they are not | Fixed: node-range check + re-check at buy |
| D2 | High | Exit executed while listed leaves tokens in the market | Fixed: `settle` path |
| F1 | **High** | *Spent-index aliasing drains the market*: `isSpent` is keyed by index only; a fake exit proven against a later-rejected node shares an index with a real message, then `settle` paid the attacker from pooled balances | Fixed: payout requires the index to hold **this item under a confirmed root** (`isExitPaidOut`). PoC kept as regression test `Exploits.t.sol` |
| F2 | **High** | Same root cause lets the vault `collect` money that never arrived (insolvency) | Fixed: `collect` requires `isExitPaidOut` |
| T1 | High | `writeOff` could strand a real exit that paid out under a sibling root | Fixed (superseded by G3 fix): written-off exits keep their record and remain collectable |
| F4 | Medium | JIT deposits capture the whole purchase discount | Fixed: exits carried at cost, gain recognized at `collect`; share lock |
| G1 | Medium | Exit proven at a non-canonical index (via a bogus pending node) could never be collected | Fixed: payouts take a `PayoutProof{index, confirmedRoot, proof}` so the canonical index is proven, not assumed |
| G2 | Medium | Depositor times the permissionless `collect` to capture accrued discount | Fixed: `SHARE_LOCK` = 7 days, then linear accrual (H2 below) |
| T3 | Medium | Permissionless `writeOff` dips NAV for a real exit; attacker deposits cheap and profits at `collect` | Fixed: deposits pause while any written-off exit is impaired (until collected, or `finalizeWriteOff` after 14 days) |
| G3 | Medium | Fake exit with a far-future `exitNum` could never be written off, overstating share price | Fixed: once its node is **rejected** (`isRootRejected`: resolved without publishing its root) the exit is written off at cost; if it later pays out anyway, `collect` re-credits it |
| T2 | Medium | Lock griefing via deposit-for-victim | Fixed: deposits mint to caller only; locked shares are non-transferable |
| C1 | Medium | Trust claim overstated (owner chooses the verifier) | Fixed: documented; verifier frozen per gateway, zero-address checks |
| C2 | Medium | Keepers could not rebuild records from events | Fixed: `ExitVerified(id, ExitRecord)` |

### Round 4 (2026-09-30): gasless router, BOLD verifier, web relayer

Found after the first router deployment (`0x383b…a065`, which never held funds between calls; its only exit was
settled, executed and collected). Fixed, re-tested and redeployed; regressions in `ExitIntentRouterExploits.t.sol`
and `web/src/lib/relayGuard.test.ts`.

| ID | Severity | Finding | Status |
|---|---|---|---|
| R4-C1 | **Critical** | `settle` pays out its payment-token *balance delta*; a hostile `order.gateway`, or an attacker-chosen buyer on the real gateway, could execute **another user's** router-owned exit through the Outbox mid-call and have it paid out as "proceeds" | Fixed: only the router's immutable trusted buyer (the vault) and market-allowed gateways are accepted, so no untrusted code runs inside the window |
| R4-H1 | High | `reclaim` after the Outbox already executed the exit redirected an empty claim and stranded the tokens (`recoverExecuted` then reverts) | Fixed: `reclaim` reverts `ExitAlreadySpent`; recovery stays available |
| R4-M1 | Medium | BOLD `rejectedRoots` is keyed by send root: a staked rival that copies an honest pending root could make that root fail verification | Fixed: validity comes from the ancestor walk alone. Residual: the copied root can still read as rejected and open a re-creditable vault write-off; it costs the attacker a forfeited assertion stake |
| R4-R1 | High (prod) | Relayer gas drain: any buyer, zero relayer fee | Fixed: buyer and gateway pinned, fee floor, validation before any RPC work |
| R4-R2–R4 | Low–Medium | No rate limit or dedupe; nonce races; `JSON null` crash; body read before size check | Fixed: per-IP limit, in-flight dedupe, one settlement at a time, strict parsing |
| R4-L1 | Low | Router exits share `initialDestination = router`, so a *bogus pending root* could claim a future `exitNum` | Accepted residual (below) |

## Vault LP-fairness findings H1-H3 (fixed; regression tests `test_H1_/H2_/H3_*` in Exploits.t.sol)

These affected fairness **between vault LPs**, never sellers, buyers or market funds. No drain, no insolvency,
no permanent lock. Focused tests: `ExitVaultOpenPositions.t.sol` (H1, cap), `ExitVaultAccrual.t.sol` (H2),
`ExitVaultImpairment.t.sol` (H3); stateful fuzz of the whole vault: `ExitVaultInvariant.t.sol` (it caught each
of four planted mutations).

| ID | Issue | Fix |
|---|---|---|
| H1 | An unlocked LP could redeem at pre-loss NAV just before `writeOff` of a rejected exit | `totalAssets()` asks the market (`isExitRejected`) about every open exit on every call and values a rejected one at **zero**, so no deposit/redeem prices off a rejected exit whether or not anyone wrote it off; `writeOff` is now pure bookkeeping. Deposits also pause while any open exit is rejected. The open set is bounded (`MAX_OPEN_POSITIONS` = 32, swap-and-pop); a 33rd sale reverts in the buyer hook (`TooManyOpenPositions`) and the seller's transaction fails whole |
| H2 | A new LP could time `collect` and capture part of a discount incumbents carried | each open exit is worth `cost + (face - cost) * elapsed / (deadlineBlock - purchaseBlock)` (capped at face), so the discount is in NAV before `collect`; `collect` moves NAV only by the not-yet-accrued remainder |
| H3 | Staggered write-offs of dust exits from one rejected node stretched the deposit pause | one impairment window per rejected root (`keccak(rollup, sendRoot)`), opened by its first write-off and never extended |

Residual risks of these fixes (accepted):

- **Slot griefing.** Anyone can fill the 32 open slots with dust exits and make the vault refuse sales until they
  are collected (about one challenge period). Nothing is lost; a `minExitAmount` parameter is the follow-up.
- **Rejection is priced when observable on L1**, not when fraud becomes provable; `SHARE_LOCK` bounds early exits.
- **Unrealized discount is at risk.** NAV includes the accrued discount before the tokens arrive.
- **Rejection-check failure degrades to "carry as before"** instead of bricking deposits and redemptions.
- `deposit`/`redeem` with a full open set cost about 0.45M gas (32 market reads per NAV evaluation).

## Residual risks (accepted, documented)

- **Optimistic-rollup risk on pending proofs.** A listing proven against a node that is later rejected may be
  fake; buyers see `pending`/`nodeNum`, `buy` re-checks liveness, and the vault can cap size or refuse pending
  exits (`acceptPending`). On L3s with allowlisted validators this requires a malicious validator.
- **Owner trust.** The owner allowlists gateways and picks the root verifier; it cannot move user funds or
  change a gateway's sources after first allow. Fee is capped at 2% and snapshotted per listing.
- **WETH gateway exits** (leaf callvalue = amount) are verified by trying `value = amount` after `value = 0`: safe
  because a gateway that never sends callvalue can never have such a leaf.
- **BOLD rollups** (Arbitrum One/Nova, Arbitrum Sepolia, new Orbit chains) are verified by `BoldRootVerifier`: an
  assertion's preimage is registered once, and a pending root is accepted only if every pending ancestor up to
  the latest confirmed one is registered and has no rival child. Proven on an Ethereum mainnet fork against a
  real pending Arbitrum One withdrawal and its real 137-deep pending chain (1.37M gas for the walk).
- **Bogus pending roots and the router (R4-L1).** Router exits all share `initialDestination = router`, so a root
  forged by a validator could redirect a *future* router exit number, not just the forger's own. It needs the
  same malicious-validator assumption as any pending proof; confirmed-only mode would remove it at the cost of
  instant gasless exits.
- **Unsupported, fail-closed:** fee-on-transfer exit tokens; native ETH and custom-gas-token withdrawals (they
  do not go through the token gateway, so they are not transferable exits).
- **Outbox upgrades.** Sources are frozen per gateway; a rollup outbox swap would require a new market deployment.
- **Vault liquidity.** Withdrawals are limited to idle USDG; outstanding exits return liquidity at confirmation.
