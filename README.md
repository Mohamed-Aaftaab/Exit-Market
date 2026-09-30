# Exit Market

**The safest way out of Arbitrum, now instant.** Sell a canonical-bridge withdrawal that is still inside its
6.4-day challenge period — proven on-chain against the rollup's own commitments, using a hook Arbitrum shipped
years ago that had never been used on mainnet.

Live on **Arbitrum Sepolia** with **Xai Testnet** (Orbit L3) as the child chain · BOLD verifier proven on an
**Arbitrum One mainnet fork** · proof core also in **Stylus** (Rust)

[Demo video](#) · [Live app](#) · [Exit Explorer](#) · [Pitch deck](#) — links added at submission

---

## The problem

Leaving Arbitrum through the canonical bridge — the only exit that needs no trust beyond the rollup — takes
**45,818 L1 blocks ≈ 6.4 days**. Once a withdrawal has started, nothing can speed it up.

| Arbitrum One → Ethereum (snapshot 2026-09-29) | |
|---|---|
| Token withdrawals in the last 30 days | **$51.0M** (760 exits) |
| Tokens sitting in the challenge window that day | **$10.2M** (177 exits), plus 24,675 ETH that bypasses the token gateway |
| Exits that finished the wait and were **never claimed** | **3,276 exits, $5.06M** ($1.92M of it in the last 12 months) |

Reproducible from chain data: [`research/stranded/`](research/stranded/README.md). The
[Exit Explorer](web/src/app/explorer/page.tsx) shows the same states live for every Xai Testnet withdrawal.

**Why it is still unsolved** ([full comparison with sources](docs/pitch/COMPETITION.md)):

- **Fast bridges** (Across, CCTP, Stargate, Relay, Hop) are a route you must pick *before* withdrawing, with their
  own relayers, oracles or attesters. Across lists **none** of Xai, ApeChain, RARI, Sanko or EDU Chain.
- **Native Orbit fast withdrawals** shorten the window chain-wide through a validator committee — per Arbitrum's
  docs such a chain "would technically no longer be a Rollup" — and L2BEAT still shows 6d 8h for Xai and ApeChain.
- **Nobody rescues a canonical withdrawal already in flight.** Exit Market does, per withdrawal, on the chain as
  deployed.

## The primitive nobody used

Every Arbitrum token gateway inherits `L1ArbitrumExtendedGateway.transferExitAndCall`: the owner of a pending
withdrawal can redirect it to a new address and call `onExitTransfer` on it. Its `WithdrawRedirected` event had
been emitted **zero times** on the Arbitrum One and Nova mainnet gateways. The reason is in the source:

> "It is assumed the `_exitNum` is validated off-chain"

The gateway cannot tell a real withdrawal from a fake one, so nobody could safely buy one. Exit Market is the
missing on-chain validation. Prior art: Moosavi, Salehi, Goldman & Clark, *Fast and Furious Withdrawals from
Optimistic Rollups*, AFT 2023 ([doi:10.4230/LIPIcs.AFT.2023.22](https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.AFT.2023.22))
proposed tradeable exits on a modified Nitro; Exit Market runs on the bridge that is already deployed.

## How it works

```
Child chain (Xai / Arbitrum One)        Parent chain (Arbitrum Sepolia / Ethereum)
────────────────────────────────        ──────────────────────────────────────────────────────────────
withdraw 10 USDG ─► L2→L1 message       gateway.transferExitAndCall(exit, market, …)      ← 1 signature
  (exitNum, outbox index)                 │  redirect the exit, call the hook
                                          ▼
rollup node / BOLD assertion           ExitMarket.onExitTransfer — verified in the same transaction:
  commits the send root while            1. the market now owns the exit            (gateway.getExternalCall)
  still PENDING                          2. leaf == this withdrawal                  (rebuild Outbox item + Merkle path)
                                         3. root is real, even while pending         (legacy: node.confirmData;
                                                                                      BOLD: registered assertion chain,
                                                                                      no rival at any pending level)
                                         4. not claimed yet                          (!Outbox.isSpent(index))
                                          │
                                          ▼
                                       ExitVault (ERC-4626, USDG) pays face − 0.10% − 10% APR × time left
                                       now; owns the exit. After confirmation a permissionless keeper
                                       executes it through the Outbox and the vault collects face value.
```

**Gasless exits.** Withdraw on the child chain straight to `ExitIntentRouter`, sign one EIP-712 order (no gas),
and any relayer settles it into the vault, paying the parent-chain gas for a fee. The seller never needs ETH on
the parent chain.

## Live on testnet — every step is a real transaction

| Step | Transaction |
|---|---|
| Exit #4: 10 USDG withdrawn on Xai Testnet | [`0x28be09a9…06e5`](https://testnet-explorer-v2.xai-chain.net/tx/0x28be09a989c685f363b6577cab191333470cf56ab890c6fc009884edde1806e5) |
| Sold while pending, one signature (seller got 9.965 USDG) | [`0x1b724139…f430`](https://sepolia.arbiscan.io/tx/0x1b7241398b497ee83b045a6ee8e05256a3c7bae07884e75b9c02e6427db1f430) |
| Keeper executed it through the Outbox | [`0xdf2df47a…f2ed`](https://sepolia.arbiscan.io/tx/0xdf2df47afe6a7dd8430d6269c5e30477bc9e17885fb7cae425935c238e66f2ed) |
| Vault collected face value (LP yield realized) | [`0x7d817f58…91f3`](https://sepolia.arbiscan.io/tx/0x7d817f5894c4a831c62e65c580c9a114107d9f5b3a5fc034191eb4745baf91f3) |
| Exit #5: gasless — withdrawn to the router by a wallet with **0 ETH** on Arbitrum Sepolia | [`0x6e7906ca…7781`](https://testnet-explorer-v2.xai-chain.net/tx/0x6e7906ca311ee8217a5d1365cb1521671945e61db58f6b4eab65bf43a3827781) |
| Settled by the app's relayer; the seller received 9.945 USDG | [`0xd11f3260…719d`](https://sepolia.arbiscan.io/tx/0xd11f3260936bd5231a430cec999489f7da4b724a65a282c27e4500f7195e719d) |
| Keeper executed, vault collected | [`0x3f0dbc0d…cba47`](https://sepolia.arbiscan.io/tx/0x3f0dbc0dd818d09a45bed71d0c2d8c0abfa5e7d983903a930e5eefd5875cba47) · [`0x2cf84c1a…c7e0`](https://sepolia.arbiscan.io/tx/0x2cf84c1a15fffdbad17e20b5429867e12273bca0389d2ccbbd237a235648c7e0) |
| **v2 contracts** — Exit #6: 10 USDG sold in the app while pending (seller got 9.96 USDG) | [`0xfc3a6c28…d87d`](https://sepolia.arbiscan.io/tx/0xfc3a6c284974612332fb8e1ff2667a52e9c6415c7e9d23a96f00e1c174a6d87d) |
| Exit #7: gasless through router v2, settled by the app's relayer | [`0x06a3978b…b3eb`](https://sepolia.arbiscan.io/tx/0x06a3978b263d3f9743b3a2fb30fa81889b7732b3ea5d2ca668589975dca1b3eb) |
| Keeper executed and collected both (vault v2: 19 → 19.015 USDG) | [`0xd4453202…becb`](https://sepolia.arbiscan.io/tx/0xd44532020be37c7f2e72fbcff55fd1912c3a8de27a8105e5453252f1696ebecb) · [`0xd329b47b…bfd9`](https://sepolia.arbiscan.io/tx/0xd329b47b64202458c5f9513a562defd7777c6db2eb7031328348e615103cbfd9) · [`0x69dca567…335a`](https://sepolia.arbiscan.io/tx/0x69dca56778de309be49cff611818afad58e0c4ed563402006260afcde5ee335a) · [`0xa1d4794b…ea6e`](https://sepolia.arbiscan.io/tx/0xa1d4794b70c60c693a5aeaeb8c01723a39a1fc4cc18ed68fa38bc2e2e8ecea6e) |

## Arbitrum technology used

| | |
|---|---|
| **Token bridge** | `transferExitAndCall` / `onExitTransfer` on the real parent gateways; sources derived on-chain (gateway → inbox → bridge → rollup → outbox) |
| **Outbox + NodeInterface** | leaf rebuilt byte-for-byte (`ExitLeaf.sol`), proofs from `NodeInterface.constructOutboxProof` against a *pending* node |
| **Legacy rollups** (Xai, most live Orbit L3s) | a pending node's `confirmData == keccak256(blockHash, sendRoot)` commits to its withdrawals |
| **BOLD** (Arbitrum One/Nova, Arbitrum Sepolia) | `BoldRootVerifier` registers assertion preimages and walks every pending ancestor; on an Ethereum mainnet fork a **real pending Arbitrum One withdrawal** (504.7 LINK) is proven and listed through the **real L1 gateway**, over the real 137-deep pending chain in **1.37M gas** |
| **Orbit L3** | live end to end on Xai Testnet → Arbitrum Sepolia |
| **Stylus** | the proof core in Rust/WASM, activated at [`0x30ac…1394`](https://sepolia.arbiscan.io/address/0x30ac015003186f187b9a11fff2781d55cc9e1394), checked on-chain against a real Xai send root. Honest benchmark: Solidity is cheaper at these depths (37.8k vs 69.0k gas at depth 7; 123.0k vs 131.7k at depth 64) — [`docs/audit/STYLUS_BENCH.json`](docs/audit/STYLUS_BENCH.json) |

## Security and quality

- **406 Solidity tests + 9 fork tests** against the real Xai and Arbitrum One contracts: unit, fuzz, stateful
  invariants (market, router, vault) and exploit regressions. **99.4% line coverage** of the production
  contracts; the three uncovered lines are defensive reverts, each explained in the coverage report.
- **Four internal review rounds** by specialised AI review agents (not a third-party audit). Every High/Critical
  finding — including a critical router bug found after its first deployment and fixed the same day — has a
  regression test that reproduced the loss before the fix: [`docs/SECURITY.md`](docs/SECURITY.md).
- **Slither: 0 high, 0 medium** ([`docs/audit/SLITHER.md`](docs/audit/SLITHER.md)).
- Coverage and gas: [`docs/audit/COVERAGE.md`](docs/audit/COVERAGE.md), [`docs/audit/GAS.md`](docs/audit/GAS.md).

## Business model and first-month KPIs

Protocol revenue is the 0.25% market fee; the vault discount (≈0.27% for a full window) goes to LPs, ≈15.7% APR
gross at full utilisation. First 30 days on mainnet: ≥ 20 exits from ≥ 10 sellers and ≥ $100K face value;
≥ $50K vault TVL from ≥ 5 LPs at ≥ 40% utilisation with zero write-offs; ≥ 5% of eligible in-window face value
bought. Details and honest limits (price vs CCTP, ETH and gas-token exits): [`docs/pitch/COMPETITION.md`](docs/pitch/COMPETITION.md).

## Repository

| Path | What |
|---|---|
| `contracts/ExitMarket.sol` | hook verification, listings (list/buy/cancel/settle), one-transaction sale to any `IExitBuyer` |
| `contracts/ExitVault.sol` | ERC-4626 USDG vault: instant buyer, live NAV with accrued discount, fraud-proof write-offs |
| `contracts/ExitIntentRouter.sol` | gasless sign-once exits, reclaim, recovery of executed exits |
| `contracts/verifiers/` | `LegacyRootVerifier` (node-based rollups) and `BoldRootVerifier` (BOLD) |
| `contracts/libraries/` | `ExitLeaf` (Outbox item + Merkle, byte-for-byte), `ExitAccrual`, `ExitKeys` |
| `stylus/exit-proof/` | the proof core in Rust (Stylus SDK 0.9) |
| `scripts/` | deploy, keeper, demo flows, proof builder (`lib/exitProof.ts`) |
| `web/` | Next.js app: seller desk, gasless exits, vault, live Exit Explorer, relayer API |
| `research/stranded/` | the mainnet stranded-exit and challenge-window research |
| `video/` | the demo video as code: Blender (Cycles) shots, live-app capture harness, cards, assembler |

## Run it

```bash
npm install
npx hardhat test solidity                      # 406 tests
FORK_TESTS=1 npx hardhat test solidity         # + fork tests against Xai and Arbitrum One mainnet
npm run web:dev                                # http://localhost:3000
node scripts/keeper.ts --loop                  # permissionless keeper
```

## Deployments (Arbitrum Sepolia, all source-verified)

| Contract | Address |
|---|---|
| ExitMarket | [`0xd112ea99a2664d65de013fcaf3a6ce1604a8c51b`](https://sepolia.arbiscan.io/address/0xd112ea99a2664d65de013fcaf3a6ce1604a8c51b) |
| ExitVault v2 (evUSDG) | [`0xb5aad1dfb95f4362121164f86dd9b69094ee492c`](https://sepolia.arbiscan.io/address/0xb5aad1dfb95f4362121164f86dd9b69094ee492c) |
| ExitIntentRouter v2 | [`0xa1b07789799b1b961b8b554b49429b0e97806c33`](https://sepolia.arbiscan.io/address/0xa1b07789799b1b961b8b554b49429b0e97806c33) |
| LegacyRootVerifier | [`0xb06028304345d9ed295d812aca5f1430ec9808c9`](https://sepolia.arbiscan.io/address/0xb06028304345d9ed295d812aca5f1430ec9808c9) |
| BoldRootVerifier v2 | [`0xa44d3b2dd5d3ac2990dd9d4fd848576f210fc903`](https://sepolia.arbiscan.io/address/0xa44d3b2dd5d3ac2990dd9d4fd848576f210fc903) |
| Stylus ExitProof | [`0x30ac015003186f187b9a11fff2781d55cc9e1394`](https://sepolia.arbiscan.io/address/0x30ac015003186f187b9a11fff2781d55cc9e1394) |
| Payment token (Paxos USDG) | `0xFFC95faa3d63Cde504a05B567C600B78C0b41892` |

v1 vault `0x4b1f…afed` and router `0x383b…a065` ran the live transactions above and are superseded (see
[`docs/SECURITY.md`](docs/SECURITY.md), round 4). Allowlisted gateways: Xai Testnet standard `0xCcB451…1256` and
custom `0x04e14E…5D88`.

Built for the Arbitrum Open House Singapore Online Buildathon. Payments in Paxos **USDG**.
