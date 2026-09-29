# Exit Market

**Sell a pending Arbitrum Orbit withdrawal instantly — verified on-chain, using a primitive Arbitrum shipped
years ago and nobody has ever used.**

Withdrawing through the canonical bridge of an Orbit L3 (Xai, ApeChain, RARI, Sanko, EDU Chain…) to Arbitrum One
locks your tokens for the challenge period: **45,818 L1 blocks ≈ 6.4 days**. Exit Market turns that locked
withdrawal into USDG *now*, in one signature, and turns the wait into yield for liquidity providers.

## The primitive nobody used

Every Arbitrum token gateway inherits `L1ArbitrumExtendedGateway.transferExitAndCall`: the owner of a pending
withdrawal can redirect it to a new address and trigger a hook. It is live on Arbitrum One, Nova and every Orbit
chain's parent gateways — and `WithdrawRedirected` has been emitted **zero times** (Arbitrum One/Nova L1 gateways,
Xai Testnet gateways; checked on Blockscout and Routescan).

Why? The gateway **does not validate the exit** — the source literally says *"it is assumed the `_exitNum` is
validated off-chain"*. Nobody could safely buy one. Exit Market is the missing piece: it proves the exit on-chain.

## How it works

```
Xai Testnet (L3)                     Arbitrum Sepolia (parent)
────────────────                     ─────────────────────────────────────────────────────────────
withdraw 100 USDG ─► L2→L1 message   gateway.transferExitAndCall(exit, market, proofData)   ← 1 signature
   (exitNum, index)   in send tree        │ redirect exit to market, call hook
                                          ▼
                     rollup node #N   ExitMarket.onExitTransfer
                     (pending, commits   1. market owns exit          (gateway.getExternalCall)
                      sendRoot)          2. leaf == your withdrawal   (rebuild Outbox item + merkle proof)
                                         3. root in unresolved node   (node.confirmData == keccak(blockHash, sendRoot))
                                         4. not yet claimed           (Outbox.isSpent(index) == false)
                                          │
                                          ▼
                                      ExitVault (ERC-4626, USDG) pays face − fee − APR×timeToConfirm
                                      and becomes the exit's owner; collects face value at confirmation
```

The proof can be built ~15 minutes after withdrawing (as soon as the next rollup node is posted) — not 6.4 days
later. The key observation, verified against live Xai Testnet nodes: a legacy node's
`confirmData == keccak256(blockHash, sendRoot)`, so a pending node already commits to its withdrawals.

## What's in the repo

| Path | What |
|---|---|
| `contracts/ExitMarket.sol` | hook verification, fixed-price listings (list/buy/cancel/settle), one-tx sale to any `IExitBuyer` |
| `contracts/ExitVault.sol` | ERC-4626 USDG vault: instant buyer, cost-basis accounting, fraud-proof write-offs |
| `contracts/libraries/ExitLeaf.sol` | byte-for-byte mirror of nitro `AbsOutbox` item hashing and merkle folding |
| `contracts/verifiers/LegacyRootVerifier.sol` | confirmed root or unresolved legacy node (BOLD adapter next) |
| `scripts/lib/exitProof.ts` | builds the proof from a withdrawal tx using `NodeInterface.constructOutboxProof` against a pending node |
| `web/` | Next.js app: your withdrawals, live proof trace, instant sale, vault |
| `docs/SECURITY.md` | threat model, audit findings (incl. two high-severity bugs found and fixed), residual risks |

## Verified against live chain data

- `ExitLeaf.t.sol` reproduces the **live Xai Testnet send root** for a real withdrawal (golden vector).
- `scripts/dev/checkProof.ts` replays the market's verification against the real Outbox and rollup on
  Arbitrum Sepolia: root ✓, `confirmData` ✓, minimal path ✓, client `itemHash` == `Outbox.calculateItemHash` ✓.

## Run it

```bash
npm install
npx hardhat test solidity          # contract suite (unit, fuzz, exploit regressions)
npm run web:dev                    # http://localhost:3000
```

Deploy to Arbitrum Sepolia (needs `.env`, see `.env.example`):

```bash
npx hardhat run scripts/deploy.ts --network arbitrumSepolia
node scripts/demo/withdrawFromXai.ts 100
node scripts/demo/sellExit.ts <withdrawal-tx-hash>
```

## Deployments (Arbitrum Sepolia)

| Contract | Address |
|---|---|
| ExitMarket | [`0xd112ea99a2664d65de013fcaf3a6ce1604a8c51b`](https://sepolia.arbiscan.io/address/0xd112ea99a2664d65de013fcaf3a6ce1604a8c51b) |
| ExitVault (evUSDG) | [`0x4b1f94e45ff6fc5b3c105806d2ca4e2bede6afed`](https://sepolia.arbiscan.io/address/0x4b1f94e45ff6fc5b3c105806d2ca4e2bede6afed) |
| LegacyRootVerifier | [`0xb06028304345d9ed295d812aca5f1430ec9808c9`](https://sepolia.arbiscan.io/address/0xb06028304345d9ed295d812aca5f1430ec9808c9) |
| Payment token (Paxos USDG) | `0xFFC95faa3d63Cde504a05B567C600B78C0b41892` |

Allowlisted gateways: Xai Testnet standard `0xCcB451…1256` and custom `0x04e14E…5D88` (sources derived on-chain).

Built for the Arbitrum Open House Singapore Online Buildathon. Payments in Paxos **USDG**.
