# Stranded exits on Arbitrum One

How much value sits in Arbitrum One → Ethereum withdrawals that finished their challenge window but were never
claimed, and how much is waiting in the window right now? These scripts answer that from public chain data only.
Their output (`mainnet-snapshot.json`) feeds the "Mainnet opportunity" panel on `/explorer` in the web app.

## Headline results (snapshot 2026-09-29, Arbitrum One block 510,076,438)

| Metric | Value |
| --- | --- |
| Confirmed, never-claimed **token** withdrawals, all time (Nitro, initiated ≥ 14 days before the snapshot) | **3,276 exits, ~$5.06M** |
| of which initiated in the last 12 months | 400 exits, ~$1.92M |
| Largest stranded exit of the last 12 months | 228.73 weETH ≈ $676K ([`0x8e8acd3a…842a`](https://arbiscan.io/tx/0x8e8acd3a5d2f0583e2b867db92a8ba941e4743c5bc19c9db8219e01b99e4842a)) |
| Largest stranded exits all time | 720M POND ≈ $1.45M (2023-07-13), 1.2M USDC ≈ $1.20M (2023-11-01) |
| Token withdrawals in the last 30 days | 760 exits, ~$51.0M |
| In the challenge window at snapshot time | 177 token exits ~$10.2M + 65 ETH withdrawals, 24,675 ETH (~$66.0M) |
| Also stranded (not in the token figure) | 477.6 ETH in 20,392 unclaimed `withdrawEth` messages (~$1.28M) |
| Claimability check | `Outbox.executeTransaction` simulates successfully for 651 of 664 stranded exits checked |

USD values use DefiLlama prices on the snapshot date (ETH $2,673.30). 487 of the 3,276 stranded token exits have no
DefiLlama price and count as $0, so the USD figures are a floor. 21 of the 3,276 (≈ $1.6K) come from three contracts
that emit `WithdrawalInitiated` but are not among the 10 gateways validated in `validate.mjs`; through validated
gateways only it is 3,255 exits (≈ $5.05M).

## Methodology

1. **Pin the snapshot** (`findblocks.mjs`): Arbitrum One head and the blocks exactly 365 / 30 / 14 / 7 days earlier
   (binary search on block timestamps).
2. **Collect logs** (`collect.mjs`): every `WithdrawalInitiated` log on Arbitrum One from any emitter, and every
   ArbSys `L2ToL1Tx` (the message the Outbox executes), from the first Nitro block (22,207,818) to the head. The
   span adapts to the RPC (shrinks on timeouts, grows on sparse ranges).
3. **Classify emitters** (`emitters.mjs`): real gateways answer `counterpartGateway()` and `router()`, and the L1
   gateway router maps their tokens back to that counterpart. `validate.mjs` then checks that every message a
   gateway sent targets its L1 counterpart.
4. **Spent flags** (`spent.mjs`): `Outbox.isSpent(position)` on Ethereum for every message, 400 per Multicall3 call.
5. **Tokens and prices** (`tokens.mjs`): `decimals()` / `symbol()` via Multicall3 on Ethereum, USD from DefiLlama.
6. **Confirmation point** (`confirmed.mjs`): the Outbox's latest `SendRootUpdated` on Ethereum names the newest
   confirmed Arbitrum One block. Messages at or below it are claimable today.
7. **Join** (`build.mjs`, `merge.mjs`): each withdrawal is matched to its `L2ToL1Tx` by (tx hash, position).
   Every one of the 66,573 token withdrawals matched, with no caller mismatch.
8. **Report** (`report.mjs`, `flow.mjs`, `summary.mjs`): *stranded* = confirmed (L2 block ≤ confirmed block),
   initiated at least 14 days before the snapshot (well past the ~6.4-day window), and `isSpent == false`.
   *Challenge window* = initiated after the confirmed block.
9. **Prove claimability** (`simulate.mjs`, `simall.mjs`): build each Outbox proof with NodeInterface at the confirmed
   block's send tree and `eth_call` `Outbox.executeTransaction` on Ethereum. The 13 failures revert inside the
   token's own transfer logic: 11 AXGT exits (`UniswapV2Library: INSUFFICIENT_LIQUIDITY` inside the token's
   transfer), one paused token (SPOOL) and one transfer to the zero address (TPY), together worth under $500.
10. **Orbit L3s** (`l3probe.mjs`, `l3.mjs`): the same analysis for a chain settling to Arbitrum One (Xai, ApeChain),
    with logs collected from the L3 RPC and spent flags read from its Outbox on Arbitrum One.

## Data sources

- Arbitrum One public RPC `https://arb1.arbitrum.io/rpc` (logs, blocks, NodeInterface proofs). Override with `ARB_RPC`.
- Ethereum public RPC `https://ethereum-rpc.publicnode.com` (Outbox state, Multicall3, simulations). Override with
  `ETH_RPC`. `validate.mjs` re-checks spent flags on independent endpoints (drpc, 1rpc, llamarpc, cloudflare).
- DefiLlama coins API (`coins.llama.fi`) for USD prices.
- For the L3 step, chain addresses (rollup, outbox, gateways) come from Offchain Labs' token-bridge
  `orbitChainsData.json`; L3 logs come from each chain's public RPC.
- No script depends on an indexer. Blockscout explorers (Arbiscan / Xai's Blockscout) are handy for spot-checking a
  single transaction, but every number above is computed from JSON-RPC data.

## How to run

Requires Node 20+ and the repo's dependencies (`npm install` at the root; the scripts import `viem` from it).
Outputs go to `research/stranded/data/` (gitignored), or to `$STRANDED_DATA` if set. The full run makes a few thousand
RPC calls and took under an hour on public endpoints; `spent.mjs` and `simall.mjs` are resumable.

```sh
cd research/stranded
node findblocks.mjs                                  # data/blocks.json (note head, d365.block)
node confirmed.mjs                                   # data/confirmed.json (l2Block = latest confirmed block)

# logs: pre-365d and last-365d ranges (use the block numbers from blocks.json)
node collect.mjs 22207818 <d365-1> wi_old.json wi
node collect.mjs 22207818 <d365-1> l2tol1_old.json l2tol1
node collect.mjs <d365> <head> wi_365_all.json wi
node collect.mjs <d365> <head> l2tol1_365.json l2tol1

node emitters.mjs wi_365_all.json                    # optional: inspect emitters
node spent.mjs l2tol1_old.json spent_old.json
node spent.mjs l2tol1_365.json spent.json
node tokens.mjs wi_old.json wi_365_all.json          # data/tokens.json

node build.mjs wi_old.json l2tol1_old.json spent_old.json rows_old.json
node build.mjs wi_365_all.json l2tol1_365.json spent.json rows_365.json
node merge.mjs rows_all.json rows_old.json rows_365.json

# reports (now = blocks.json headTs, confirmed = confirmed.json l2Block)
node report.mjs rows_all.json 22207818 <d14> <confirmed> <headTs>   # all time
node report.mjs rows_all.json <d365> <d14> <confirmed> <headTs>     # last 12 months
node flow.mjs rows_365.json                                         # 30-day flow + challenge window
node validate.mjs rows_all.json unclaimed_22207818_<d14>.json

# claimability (resumable)
node simulate.mjs l2tol1_365.json unclaimed_<d365>_<d14>.json <confirmed>
node simall.mjs l2tol1_365.json unclaimed_<d365>_<d14>.json <confirmed> sim_tok_365.json
node report.mjs rows_all.json 22207818 <d365-1> <confirmed> <headTs>   # pre-365d stranded list
node simall.mjs l2tol1_old.json unclaimed_22207818_<d365-1>.json <confirmed> sim_old_big.json 100

# the JSON used by the web app (also writes web/src/data/mainnet-snapshot.json)
node summary.mjs rows_all.json <confirmed> --web
```

The 2026-09-29 snapshot used head 510,076,438, d365 384,299,670, d30 499,995,661, d14 505,467,950 and confirmed
block 508,004,407. `sim_old_big.json` covers pre-365-day stranded exits worth at least $100 (the `100` argument):
264 in the snapshot, which also left out 2 small ones from a non-validated emitter.

For an Orbit L3, collect from its RPC with `RPC=<l3 rpc> node collect.mjs …`, then run `l3.mjs` (usage in the file).

## Caveats

- "Current" prices: old exits are valued at snapshot-date prices, not at withdrawal time.
- Token amounts use the L1 token's `decimals()`; DefiLlama confidence is recorded per token in `tokens.json`.
- The 14-day minimum age keeps only withdrawals that are unambiguously past their window; a few claimable
  withdrawals between 6.4 and 14 days old are excluded.
- Classic-era (pre-Nitro) withdrawals use a different Outbox and are not counted.
