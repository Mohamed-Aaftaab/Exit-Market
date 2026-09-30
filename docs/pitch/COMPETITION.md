# Competitive landscape (researched 2026-09-29)

Tags: **[V]** checked against a primary source that day · **[S]** secondary source · **[U]** unverified.
Claims that something is "not supported" come from each project's published chain lists. Re-check a list
before quoting one of those claims publicly.

## Positioning

Every fast exit today is either **a route you choose before you withdraw** (Across, CCTP, Stargate, Relay, Hop,
Orbiter), or **a chain-level change backed by a committee** (native Orbit fast withdrawals). Exit Market is the
only option we found that pays out a canonical withdrawal **already in flight**, on a chain **as deployed**. It
relies only on the rollup's own commitments: no committee, oracle or relayer decides whether an exit is valid.

## Comparison

| | Works on an already-started canonical withdrawal | Extra trust for exit validity | Assets | Chains | Liquidity | Fees |
|---|---|---|---|---|---|---|
| **Exit Market** | **Yes: the core use case.** Sellable once the next node or assertion is posted (~15 min on Xai Testnet). | None: the proof is checked against the rollup's own commitments. The buyer or LP carries the risk of a pending node being rejected, and that risk is priced into the discount. | Any ERC-20 on an allowlisted token gateway, including WETH. Vaults are per asset (USDG today). | Live: Arbitrum Sepolia ← Xai Testnet (legacy rollup). Fork-proven: Ethereum ← Arbitrum One (BOLD). | Any buyer, and ERC-4626 vaults | 0.25% market fee; vault discount 0.10% plus 10% APR on time left (≈0.52% all-in for a full window) |
| Across [V] | No: you deposit into Across instead of the canonical bridge | Relayers plus the UMA optimistic oracle | Broad ERC-20 set | 22 mainnet chains; **none of Xai, ApeChain, RARI, Sanko, EDU Chain** | Relayers and a HubPool | LP fee plus relayer fee |
| Native Orbit fast withdrawals [V] | **Yes, but only on chains that enabled it** (it shortens the chain's own window) | A unanimous validator committee (`anytrustFastConfirmer`). The docs say a rollup using it "would technically no longer be a Rollup". | All | Opt-in per chain; L2BEAT still shows 6d 8h for Xai and ApeChain | None needed | Gas |
| Circle CCTP [V] | No (burn and mint instead) | Circle attestation | USDC only | ~20 chains; no Orbit L3 | Circle | Standard free; fast 1.4 bps from Arbitrum |
| Hop [V] | No | Bonders; falls back to the rollup's exit time | ETH, stablecoins | Arbitrum One, Nova, OP, Base, Linea, Gnosis | Bonders and AMM LPs | Bonder fee plus AMM fee |
| Stargate [V/S] | No | LayerZero plus pool contracts | USDC, USDT, ETH… | ~60 chains incl. ApeChain; not Xai, RARI, Sanko, EDU | Pool LPs | ~6 bps plus rebalancing [S] |
| Relay [V] | No | Solvers, oracle, allocator, security council | Route-dependent | Includes ApeChain | Solvers | Route-dependent |
| Everclear (ex-Connext) | — | — | — | **Shut down 2026-05-21** [V] | — | — |

Sources:
- Across: [chains](https://docs.across.to/reference/supported-chains), [API](https://app.across.to/api/swap/chains), [architecture](https://docs.across.to/concepts/intents-architecture-in-across)
- Native Orbit fast withdrawals: [chain config](https://docs.arbitrum.io/launch-arbitrum-chain/chain-config/validation/fast-withdrawals), [how-to](https://docs.arbitrum.io/launch-orbit-chain/how-tos/fast-withdrawals)
- L2BEAT: [Xai](https://l2beat.com/scaling/projects/xai), [ApeChain](https://l2beat.com/scaling/projects/apechain)
- CCTP: [fees](https://developers.circle.com/cctp/concepts/fees)
- Hop: [FAQ](https://docs.hop.exchange/developer-docs/other/faq)
- Stargate: [metadata API](https://mainnet.stargate-api.com/v1/metadata?version=v2)
- Relay: [overview](https://docs.relay.link/references/protocol/overview)
- Everclear: [The Block](https://www.theblock.co/amp/post/402252/clear-token-tanks-48-everclear-winds-down-protocol-foundation-labs-unit)

## Honest limits (say these before a judge does)

- **Price.** At ≈0.52% for a full window, Exit Market costs more than CCTP fast (1.4 bps) or Stargate (~6 bps) on
  the routes they serve. It wins where those don't reach: a withdrawal that has already started, L3s and
  long-tail tokens those services don't list, very large exits, and users who want no extra trust.
- **What the hook covers.** `transferExitAndCall` lives on the token gateways. Native ETH withdrawals and
  custom-gas-token withdrawals (XAI on Xai, APE on ApeChain) don't go through it, so they aren't sellable.
  ETH becomes sellable if it is withdrawn as WETH through the WETH gateway, which we support.
- **Chains with fast withdrawals enabled** have a window of about 15–40 minutes. Exit Market adds little there.
  The market is Arbitrum One → Ethereum, plus the L3s that haven't enabled it.
- **Not a third-party audit.** Security came from five internal review rounds (AI-assisted, specialised review
  agents), Slither, fuzz and invariant tests, and fork tests against real contracts.

## Prior art

Mahsa Moosavi, Mehdi Salehi, Daniel Goldman, Jeremy Clark. **"Fast and Furious Withdrawals from Optimistic
Rollups."** AFT 2023, LIPIcs vol. 282, 22:1–22:17.
[doi:10.4230/LIPIcs.AFT.2023.22](https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.AFT.2023.22).
Three of the four authors are affiliated with Offchain Labs. The paper proposes tradeable exits and demonstrates
them "through a modified version of Arbitrum Nitro". Exit Market is an application that works on the
**deployed** token bridge and rollup contracts. We credit the paper and don't claim the idea.

## Business model and KPIs (first 30 days after mainnet)

Protocol revenue is the 0.25% market fee. The vault discount goes entirely to LPs (≈15.7% APR gross at full
utilisation, ≈6.3% at 40%, before write-offs).

| Monthly volume | Protocol fees | LP spread |
|---|---|---|
| $500K | $1,250 | ≈$1,370 |
| $2.5M | $6,250 | ≈$6,850 |
| $10M | $25,000 | ≈$27,400 |

KPIs, all measurable on-chain from `ExitVerified`, sale events and vault `totalAssets`, excluding team addresses:
1. **Exits bought:** at least 20 verified exits from at least 10 distinct sellers, at least $100K face value
   (≈0.2% of the ~$51M monthly token flow). Stretch goal: $500K.
2. **Vault depth:** peak TVL of at least $50K from at least 5 LPs, average utilisation of at least 40%, and zero
   write-offs.
3. **Coverage:** buy at least 5% of the eligible in-window face value. The eligible set is published on day 1:
   allowlisted gateway, a vault-supported asset, and above the minimum size.

Guardrails: median time from withdrawal to payout of 20 minutes or less, zero false-positive verifications,
and no loss from rejected assertions. Plan a price test (0.10% vs 0.25%) rather than assuming the fee.
