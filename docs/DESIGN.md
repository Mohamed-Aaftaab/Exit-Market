# Exit Market — Design

Current state: **v4** (rival-node check and buyer consent, after round 6). Every review round, finding and residual risk is in
[`SECURITY.md`](SECURITY.md).

## Problem

Withdrawing tokens from an Arbitrum chain to its parent through the canonical token bridge locks them for the
challenge period: **45,818 L1 blocks ≈ 6.4 days** on Arbitrum One and most mainnet Orbit chains (Xai, ApeChain,
RARI, Sanko, EDU…).

Arbitrum's gateways shipped a way out that nobody used: **tradeable exits**.
`L1ArbitrumExtendedGateway.transferExitAndCall(exitNum, initialDestination, newDestination, "", data)` lets the
current owner of a pending withdrawal redirect it and call `onExitTransfer` on the receiver. `WithdrawRedirected`
had been emitted zero times on the Arbitrum One and Nova L1 gateways (reproduce:
[`research/stranded/redirects.mjs`](../research/stranded/redirects.mjs)).

Why: the gateway **does not verify that the exit exists, its token or amount, or that it was not already
executed** (source comment: "It is assumed the `_exitNum` is validated off-chain"). A buyer cannot trust a seller.

## Core idea: verify the exit on the parent chain, before it confirms

`ExitMarket.onExitTransfer` runs inside the seller's `transferExitAndCall` and proves:

1. **Ownership**: `gateway.getExternalCall(exitNum, initialDestination, "")` returns the market. `exitNum` and
   the gateway come from the gateway call itself, never from the seller.
2. **Content**: the Outbox item is rebuilt exactly as the child gateway produced it
   (`finalizeInboundTransfer(l1Token, from, initialDestination, amount, abi.encode(exitNum, ""))`, hashed with
   child gateway, parent gateway, L2/L1 block, timestamp and value; `value = amount` is retried for WETH-style
   gateways) and folded through the Merkle proof to `sendRoot`, with `index < 2**proof.length` so the spent-bitmap
   slot is the one the Outbox would use.
3. **Root authenticity** (`IRootVerifier`, one per gateway, frozen): confirmed in `Outbox.roots`, or pending:
   - **legacy rollups** (`LegacyRootVerifier`): an unresolved node (`firstUnresolvedNode ≤ n ≤ latestNodeCreated`)
     with `getNode(n).confirmData == keccak256(blockHash, sendRoot)`; rejected legacy nodes are not deleted, hence
     the range check, repeated at buy time. Since v4 the whole pending chain must also be **uncontested**: walking
     `prevNum` from `n` to `latestConfirmed`, every parent must be unresolved (or the latest confirmed node) and
     have no live rival child. RollupCore records each parent's `latestChildNumber` and `firstChildBlock`, and
     nodes are numbered in creation order, so a newer sibling shows in `latestChildNumber`, an older one from an
     earlier block in `firstChildBlock`, and an older one from the same block in the contiguous run of nodes
     created in that block (scanned, at most 16). A resolved sibling of a node on a pending chain can only have
     been rejected. Anything that cannot be ruled out fails closed: the exit then sells once confirmed;
   - **BOLD** (`BoldRootVerifier`): assertion preimages registered once (permissionless), and a pending root is
     accepted only if every pending ancestor up to the latest confirmed assertion is registered and has no rival.
4. **Not yet executed**: `!Outbox.isSpent(index)`. After the redirect, any later execution of this item pays a
   destination the market controls.

Verification sources are derived from the gateway (`inbox → bridge → rollup → outbox`, `bridge.allowedOutboxes`)
and frozen with the verifier when the gateway is allowed.

## Components

| Piece | Role |
|---|---|
| `ExitMarket` | the hook; listings (`list`/`buy`/`cancel`/`settle`) and one-transaction sale to any `IExitBuyer`. Payment is **pulled** from the buyer (`transferFrom` of the price it reports), never measured as a balance change, and only after the buyer returns `IExitBuyer.buyExit.selector` (its consent); the seller's `minPayout` is net of the fee. On the live deployment ownership is renounced |
| `ExitVault` | ERC-4626 USDG vault and the default buyer: prices an exit at `face − baseFee − APR × timeToDeadline`, carries it at cost plus linearly accrued discount, values it at zero if its node is rejected, collects face value after execution. At most 32 open exits; exits below `minExitAmount` refused |
| `ExitIntentRouter` | gasless exits: users withdraw to the router, sign an EIP-712 `SellOrder` (buyer, minimum proceeds, relayer fee, deadline); anyone settles it. `reclaim` and `recoverExecuted` return an exit or its tokens to the proven sender |
| `scripts/keeper.ts` | permissionless: executes every exit the market verified once its root confirms (the Outbox pays its owner), collects the vault's, settles listings that paid out while listed, writes off rejected ones (decision table `keeperStep` in `scripts/lib/keeperPlan.ts`, tested). Reads confirmed roots from the Outbox's `SendRootUpdated`, so it is the same for legacy and BOLD. Runs every 10 minutes on GitHub Actions (`.github/workflows/keeper.yml`) with its own testnet key |
| `web/` | desk (instant sale, gasless, listings: list/buy/cancel, LP deposit/withdraw, test funds), live Explorer, relayer API (`/api/relay`), test faucet (`/api/faucet`), security headers |
| `scripts/lib/` | the TypeScript both share: proof builders for legacy nodes and BOLD assertions (a covering confirmed root first, else the earliest pending one the verifier accepts), hook encoding, listings, relayer, ABIs generated from the compiled contracts |

## Flows

- **Instant sale**: `gateway.transferExitAndCall(exitNum, initialDest, market, "", abi.encode(SELL_TO_BUYER, claim,
  abi.encode(vault, minPayout)))`. The market proves the exit, asks the vault for its price, pulls it, redirects
  the exit to the vault and pays the seller minus the 0.25% fee, all in one transaction.
- **Gasless sale**: withdraw on the child chain to the router, sign one order; a relayer calls
  `router.settle(claim, order, signature)`, which runs the instant sale with the router as seller and forwards
  proceeds minus the relayer fee to the signer (the proven child-chain sender).
- **Listing**: the same hook with `LIST` records a fixed-price listing; `buy` pays the seller, redirects the exit
  to the buyer; the buyer can list it again. If the exit executes while listed, `settle` forwards the tokens
  (only after proving the spent slot holds this item under a confirmed root).
- **Settlement**: after the challenge period anyone executes the exit through the Outbox; the owner (vault or
  buyer) receives the tokens; the vault's `collect` books them once `isExitPaidOut` proves it.

## Trust model

- Validity: only the rollup's own commitments (Outbox proof against a pending node or assertion, spent bitmap).
- No admin can move funds: the live market has no owner; the router has no owner; the vault owner tunes pricing
  inside hard caps only.
- Buyer risk: a pending node being rejected. The vault prices time to confirmation, values rejected exits at
  zero immediately and keeps the record so a genuine exit re-committed by the honest node can still be collected.
  A disputed node (a rival at any pending level) stops trading at once: no sale, no listing purchase.

## History

- **v0.2**: rejected legacy nodes are not deleted → range check; `settle` path for listings executed while held;
  source snapshot per gateway; the escrowed bid book was replaced by the vault.
- **v1/v2 (2026-09-29/30)**: gasless router, BOLD verifier, WETH-style leaves, vault LP-fairness fixes, router
  balance-delta fix (R4-C1).
- **v3 (2026-10-01)**: market pulls payment (R5-H1), ownership renounced at deployment (R5-H2), vault
  `minExitAmount` (R5-M1), `minPayout` net of fee (R5-M2).
- **v4 (2026-10-01)**: legacy verifier refuses a contested pending chain; buyers consent with a magic value;
  listings in the app, a keeper that completes every verified exit, BOLD proofs in the TypeScript library.

## Deployment (hackathon)

- Parent: Arbitrum Sepolia (421614). Child: Xai Testnet (37714555429), a pre-BOLD Orbit L3 with a node about every
  15 minutes and `confirmPeriodBlocks = 150` (about 30 minutes), so the whole lifecycle fits in an hour.
- Payment token: Paxos USDG on Arbitrum Sepolia `0xFFC95faa3d63Cde504a05B567C600B78C0b41892`.
- Addresses: [`deployments/arbitrumSepolia.json`](../deployments/arbitrumSepolia.json).
