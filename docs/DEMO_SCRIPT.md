# Demo video — 3 minutes

Judging: smart-contract quality · product-market fit · innovation · real problem · use of Arbitrum tech · USDG.
Every beat below maps to one of those.

| Time | Screen | Say |
|---|---|---|
| 0:00–0:20 | Bridge UI showing "~6.4 days" on an L3 withdrawal | "Leaving an Orbit chain like Xai, ApeChain or EDU through the canonical bridge locks your tokens for 6.4 days. Your money just sits there." (real problem; TODO verify fast-bridge L3 coverage before claiming anything about it) |
| 0:20–0:45 | `L1ArbitrumExtendedGateway.sol` → `transferExitAndCall` + the source comment; explorer showing 0 `WithdrawRedirected` events | "Arbitrum shipped a way to sell a pending withdrawal years ago. It has been used zero times, because the gateway doesn't check the exit. Nobody could safely buy one." (innovation, Arbitrum tech) |
| 0:45–1:30 | App: withdrawals list → select → price breakdown → **proof trace** ticking green | "Exit Market proves the exit on-chain *before* the challenge period ends: it rebuilds your withdrawal leaf, checks it against the Outbox tree committed by a *pending* rollup node, and confirms nobody claimed it." Point at node #, index, root. |
| 1:30–1:55 | Click **Get X USDG now** → one signature → Arbiscan tx | "One signature. The vault pays me USDG now and becomes the owner of my withdrawal." (USDG, PMF) |
| 1:55–2:20 | Vault panel: total assets, APR pricing | "LPs earn the discount: 10% APR on the time left to confirmation, recognized only when the exit actually pays out." |
| 2:20–2:45 | `docs/SECURITY.md` table + terminal `npm run test:fork` passing | "We audited it with specialised review agents, found and fixed two high-severity bugs — including a spent-index aliasing drain — and the fork tests run against the real Xai gateway, rollup and Outbox." (contract quality) |
| 2:45–3:00 | Architecture diagram from README | "Works for every Orbit L3 on Arbitrum One today; a BOLD verifier is next. Exit Market: your withdrawal, liquid now." |

Record at 1080p; keep the wallet in the same browser profile; pre-run the withdrawal ~20 min earlier so it is
already asserted (Xai Testnet posts a node about every 15 minutes).
