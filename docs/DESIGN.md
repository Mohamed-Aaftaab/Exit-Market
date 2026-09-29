# Exit Market — Design (v0.2)

## v0.2 changes (architect review, each claim re-verified against source)
- Legacy rollups do NOT delete rejected nodes (`RollupCore._rejectNextNode` only bumps
  `_firstUnresolvedNode`). Pending-root proofs now also require
  `firstUnresolvedNode() <= nodeNum <= latestNodeCreated()`; re-checked at buy time.
- Once a node confirms, anyone can execute the exit and the tokens land in the market.
  Listings get a `settle` path: if `isSpent(index)`, the market pays the tokens out instead of redirecting.
- `extraData` is hard-coded to `""` (child gateway enforces `EXTRA_DATA_DISABLED`).
- WETH gateways send `value = amount` in the leaf; the verifier uses `value = 0`, so WETH exits are
  unsupported (fail closed).
- Gateway allowlisting snapshots `(childGateway, outbox, rollup)` so proxy upgrades cannot silently
  swap verification sources.
- The USDG bid book is replaced by **ExitVault** (ERC-4626 on USDG). It buys USDG exits in the same
  transaction at `face × (1 − rate × timeToConfirm)` and earns the discount. That makes instant
  exit a yield product for LPs; it needs no oracle because payout token = asset.
- Layout: `libraries/ExitLeaf.sol`, `verifiers/LegacyRootVerifier.sol` (behind `IRootVerifier`, BOLD
  later), `ExitRegistry.sol`, `ExitMarket.sol`, `ExitVault.sol`.

## Problem
Withdrawing tokens from an Arbitrum Orbit L3 (Xai, ApeChain, RARI, Sanko, EDU…) to its parent chain
(Arbitrum One) through the canonical token bridge locks funds for the challenge period:
**45,818 L1 blocks ≈ 6.4 days** on most mainnet L3s (verified from Arbitrum's orbitChainsData.json).

Arbitrum's gateways shipped a solution that has never been used: **tradeable exits**.
`L1ArbitrumExtendedGateway.transferExitAndCall(exitNum, initialDestination, newDestination, "", data)`
lets the current owner of a pending withdrawal redirect it and call `onExitTransfer` on the receiver.
`WithdrawRedirected` has been emitted **zero times ever** on Arbitrum One/Nova L1 gateways and on the
Xai Testnet gateways on Arbitrum Sepolia.

Why nobody used it: the gateway **does not verify that the exit exists, its token/amount, or that it
was not already executed** (source comment: "It is assumed the `_exitNum` is validated off-chain").
A buyer cannot trust a seller.

## Core idea: trustless exit verification on the parent chain
The market contract verifies, on-chain and **before the challenge period ends**, that an exit is real:

1. **Ownership** — `gateway.getExternalCall(exitNum, initialDestination, "")` returns the market,
   so the market is the current owner.
2. **Content** — rebuild the L2→L1 leaf exactly as the child gateway produced it:
   `data = finalizeInboundTransfer(l1Token, from, initialDestination, amount, abi.encode(exitNum, extraData))`
   `item = outbox.calculateItemHash(childGateway, parentGateway, l2Block, l1Block, l2Timestamp, 0, data)`
   and check `outbox.calculateMerkleRoot(proof, index, item) == sendRoot`.
   `exitNum` and `parentGateway` come from the gateway call itself (not from the seller).
3. **Root authenticity** — either
   - confirmed: `outbox.roots(sendRoot) != 0`, or
   - **pending assertion**: `rollup.getNode(nodeNum).confirmData == keccak256(blockHash, sendRoot)`
     (verified against live Xai Testnet nodes 61780/61781).
4. **Not already executed** — `!outbox.isSpent(index)` with `index < 2**proof.length`
   (the Outbox enforces the same minimal-path rule; without it a padded index would make
   `isSpent` read the wrong slot → double-spend).
   Once the exit is redirected to the market, any later execution pays the market-controlled
   destination, so "unspent at listing time" is sufficient.

Verification sources are **derived from the gateway**, not configured:
`gateway.inbox() → inbox.bridge() → bridge.rollup() → rollup.outbox()`.
The owner can only allowlist gateways (verified on Arbitrum Sepolia for Xai Testnet).

## Flows
- **List**: seller calls `gateway.transferExitAndCall(exitNum, initialDest, market, "", abi.encode(LIST, initialDest, proof, params))`
  → hook verifies and records a listing (price in USDG or any ERC20, expiry).
  `buy(id)` pays the seller (minus fee) and redirects the exit to the buyer. `cancel`/`reclaim` return it.
- **Instant sell into a bid** (one signature): bidders escrow USDG with
  `(gateway, l1Token, rate, budget, minAmount, expiry)`. Seller transfers the exit with `FILL_BID`;
  hook verifies, redirects the exit to the bidder and pays the seller from escrow — atomically.
- **Resale**: the buyer is now the current destination and can list again (the leaf is still keyed to
  the original `initialDestination`).

## Trust / risk model
- Pending-node proofs inherit optimistic-rollup risk: if the assertion is later rejected (invalid
  state), the exit may not exist. Listings record `nodeNum` so buyers can price this.
- Owner can allowlist a malicious "gateway"; bids are pinned to a specific gateway address and
  listings expose it, so a bad allowlist entry cannot touch bids on genuine gateways.
- Pre-BOLD rollups supported now (Xai Testnet and most L3s). BOLD adapter is roadmap.

## Deployment (hackathon)
- Parent: Arbitrum Sepolia (421614). L3: Xai Testnet (37714555429, ~15-min node cadence,
  confirmPeriodBlocks = 150 → full lifecycle demo in < 1 h).
- Payment token: USDG on Arbitrum Sepolia `0xFFC95faa3d63Cde504a05B567C600B78C0b41892`.
