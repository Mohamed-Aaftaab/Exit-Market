# Security model and review log

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
| Root is real | confirmed in `Outbox.roots`, **or** committed by an unresolved legacy node: `firstUnresolvedNode ≤ n ≤ latestNodeCreated`, `getNode(n).confirmData == keccak256(blockHash, sendRoot)`, and **no live rival at any level** of its pending chain up to the latest confirmed node | rejected legacy nodes are **not deleted** (`RollupCore._rejectNextNode` only bumps a counter); a rival node is how a validator disputes a branch |
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

### Round 5 (2026-10-01): full-codebase review, fixed and redeployed as v3

Four reviewers in parallel (contracts, architecture/decentralization, TypeScript/relayer, product claims). Both
High findings were reproduced as exploits before the fix; regressions in `Round5Exploits.t.sol`. The market,
vault and router were redeployed as **v3** (addresses in the README); v1/v2 stay listed under `history` in
`deployments/arbitrumSepolia.json`.

| ID | Severity | Finding | Status |
|---|---|---|---|
| R5-H1 | **High** | `_sellToBuyer` paid the seller the market's USDG *balance delta* around `buyer.buyExit()`. The buyer is chosen by the seller, so it could execute a **listed** exit through the Outbox mid-call (paying the market) and have that victim's payout counted as its own price | Fixed: the market **pulls exactly the price the buyer reports** (`transferFrom`), so no other inflow can be counted; the vault approves instead of transferring. `test_H1_*` |
| R5-H2 | **High** | A single owner key could `allowGateway` a hostile gateway (one contract posing as gateway, inbox, bridge, rollup and outbox) and fake exits into the vault, draining its idle USDG. Contradicted "the owner cannot move funds" | Fixed: the v3 deployment allows Xai's two real gateways and then **renounces market ownership** (`owner() == 0`), so nobody can add a gateway, change the fee or pause. `test_H2_*` |
| R5-M1 | Medium | Dust exits could fill all 32 vault slots for ~32 base units, blocking sales (router included) | Fixed: `minExitAmount` (default one whole token, never zero). `test_M1_*` |
| R5-M2 | Medium | Seller slippage bound `minPayout` was checked against the gross price, so a fee change could front-run a sale | Fixed: checked **net of the fee**; the fee is also immutable now (ownership renounced) |
| R5-M3 | Medium | Relayer returned an empty revert reason and 422 for infrastructure failures; clients retried failed orders forever | Fixed: custom errors decoded from generated ABIs; "done elsewhere" detected before any gas is spent; 422 only for the order's own faults, 502 for the relayer's, 202 while waiting for a node or vault liquidity |
| R5-M4 | Medium | Gasless flow could strand an exit (withdrawal sent before the order was signed; amounts below the fee accepted) | Fixed: minimum amount checked before the withdrawal; the exit is saved before signing and can be signed later; store merges instead of overwriting |
| R5-L1 | Low | Proofs used the newest node instead of the earliest pending one covering the withdrawal (worse price) | Fixed: `findCoveringNode` picks the earliest unresolved covering node |

Slither (re-run on the v4 sources): three detector classes rated High or Medium fire, all triaged with reasons and
tests in [`audit/SLITHER.md`](audit/SLITHER.md); none is open.

Not changed in v3 (documented below): fee-on-transfer listing tokens; an exit redirected to the market with empty
hook data has no owner record. The missing legacy rival check was fixed in round 6.

### Round 6 (2026-10-01): v4 hardening, redeployed as v4

Closed the residual risks round 5 left open, and reviewed the new app surface (listings, faucet, keeper, BOLD
library). The two review agents launched for this round were cut off by a usage limit before reporting, so the
review was done by hand against the code, backed by the tests below; treat it as one reviewer, not a panel. The
market, vault, router and legacy verifier were redeployed as **v4**; v3 stays under `history`.

| ID | Severity | Finding | Status |
|---|---|---|---|
| R6-M1 | Medium | `LegacyRootVerifier` accepted a pending node even after a validator disputed it with a rival node, so exits under a fraudulent node stayed sellable while the dispute ran (the BOLD verifier already refused this) | Fixed: the verifier walks `prevNum` to the latest confirmed node and refuses the root if any level has a live rival (from RollupCore's `latestChildNumber`, `firstChildBlock` and same-block numbering); every uncertain case fails closed. Re-checked on every listing purchase. 20 unit tests incl. a brute-force property fuzz (`LegacyRootVerifier.t.sol`), market-level tests (`Round6Hardening.t.sol`), and a fork test on the live Xai rollup (passes for the real pending node, fails once its parent records a rival) |
| R6-L1 | Low | A buyer contract whose fallback returns data and that holds a standing allowance to the market could be named as a buyer and charged | Fixed: `buyExit` returns `(magic, price)` and the market pulls nothing unless `magic == IExitBuyer.buyExit.selector`. `test_aWallet*`, `test_aBuyerReturningTheWrongMagicIsNotCharged` |
| R6-L2 | Low | The proof builder used a pending node even when a confirmed node already covered the withdrawal, so a late seller was priced for a wait that was over | Fixed: a covering confirmed root wins; the desk and scripts take pending/deadline from the market's own verifier (`exitRecordFor`), not from a local guess |
| R6-L3 | Low | The site sent no security headers, and the relayer's per-IP limiter never forgot clients | Fixed: CSP limited to the origins the site uses, `X-Frame-Options: DENY`, `nosniff`, referrer and permissions policies, HSTS (checked on a production build: no violations); the limiter prunes expired clients beyond 10,000 |

New surface reviewed: **listings in the app** (exact approval, `buy` capped at the listed price, the market re-proves
the exit on purchase), **the keeper** (executes any verified exit once its root confirms, then collects or settles
only what it positively identifies as the vault's or a still-listed exit), **the test faucet** (below).

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

- **Slot griefing.** Filling the 32 open slots now costs 32 × `minExitAmount` (one USDG each by default), locked
  for a challenge period; the vault refuses sales until those exits are collected. Nothing is lost.
- **Rejection is priced when observable on L1**, not when fraud becomes provable; `SHARE_LOCK` bounds early exits.
- **Unrealized discount is at risk.** NAV includes the accrued discount before the tokens arrive.
- **Rejection-check failure degrades to "carry as before"** instead of bricking deposits and redemptions.
- `deposit`/`redeem` with a full open set cost about 0.45M gas (32 market reads per NAV evaluation).

## Residual risks (accepted, documented)

- **Optimistic-rollup risk on pending proofs.** A listing proven against a node that is later rejected may be
  fake; buyers see `pending`/`nodeNum`, `buy` re-checks liveness, and the vault can cap size or refuse pending
  exits (`acceptPending`). Both verifiers refuse a root as soon as any level of its pending chain is disputed, so
  what remains is a fraudulent node that **no one disputes**. On L3s with allowlisted validators (Xai Testnet is
  one) that requires the validators themselves to be malicious, the same party the chain's own bridge trusts until
  confirmation. The legacy rival check fails closed where it cannot rule a rival out (an older sibling from an
  earlier block while nodes below are unresolved, or more than 16 nodes created in one block): such exits wait for
  confirmation instead of selling early.
- **Admin keys.** The live market has **no owner** (renounced in the v4 deployment, tx in
  `deployments/arbitrumSepolia.json`): its gateways, their verifiers and the 0.25% fee are frozen. The router
  has no owner. The vault's owner can only call `setParams`/`setMinExitAmount` (base fee ≤ 5%, APR ≤ 50%, exit
  size limits, accept pending exits): it can make the vault stop buying or price less generously, bounded by
  each seller's `minPayout`/`minProceeds`, but it cannot move deposits or exits.
- **WETH gateway exits** (leaf callvalue = amount) are verified by trying `value = amount` after `value = 0`: safe
  because a gateway that never sends callvalue can never have such a leaf.
- **BOLD rollups** (Arbitrum One/Nova, Arbitrum Sepolia, new Orbit chains) are verified by `BoldRootVerifier`: an
  assertion's preimage is registered once, and a pending root is accepted only if every pending ancestor up to
  the latest confirmed one is registered and has no rival child. The TypeScript library builds these claims
  (`scripts/lib/boldProof.ts`); on an Ethereum mainnet fork it proves a real pending Arbitrum One withdrawal under
  its real pending chain (134 assertions deep when recorded on 2026-10-01; the walk cost 1.34M gas) and it is
  listed through the real L1 gateway. Rejection is not automatic for BOLD: someone must register the rival chain
  and call `markRejected` before the vault values the exit at zero; the keeper does not do this yet, and no BOLD
  gateway is allowed on the live market.
- **Bogus pending roots and the router (R4-L1).** Router exits all share `initialDestination = router`, so a root
  forged by a validator could redirect a *future* router exit number, not just the forger's own. It needs the
  same malicious-validator assumption as any pending proof; confirmed-only mode would remove it at the cost of
  instant gasless exits.
- **Unsupported:** native ETH and custom-gas-token withdrawals (they do not go through the token gateway, so they
  are not transferable exits). The payment token must not take a transfer fee (a short payment reverts
  `PaymentShortfall`). Listings of a fee-on-transfer *exit* token are not blocked: `settle` pays the full amount
  from the market's pool of that token, so a taxed token's shortfall would fall on other sellers of the same token.
- **Test faucet** (`/api/faucet`, Xai Testnet only). A server-side key sends 1.5 USDG and up to 0.01 sXAI to an
  address once: the faucet's own Transfer logs are the record, so the rule holds across serverless instances, plus
  a per-IP limit and one drip at a time per instance. Two requests for the same address landing on two instances at
  the same moment could both pass before either transfer lands (at most one extra drip); many fresh addresses can
  drain it, after which it answers 503. It holds a few testnet dollars by design.
- **Empty hook data.** `transferExitAndCall(…, market, "", "")` with no hook data hands the exit to the market
  without a listing, and the tokens are then stuck. The app and scripts always send hook data.
- **Outbox upgrades.** Sources are frozen per gateway; a rollup outbox swap would require a new market deployment.
- **Vault liquidity.** Withdrawals are limited to idle USDG; outstanding exits return liquidity at confirmation.
