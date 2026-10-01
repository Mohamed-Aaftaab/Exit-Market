# Gas report

Date: 2026-10-01 (v4 contracts). Hardhat 3.18.0, solc 0.8.28 (viaIR, optimizer 200 runs), EDR `cancun`, mock Arbitrum
gateway/outbox stack. Fork tests skipped (`FORK_TESTS` unset); the two on-chain figures in section 4 were
measured earlier on an Arbitrum One mainnet fork and are quoted, not re-run here.

## Reproduce

```bash
# 1. Per-function table for the whole suite (invariant campaigns excluded: their handler traffic would skew it)
npx hardhat test solidity --gas-stats --grep-exclude "invariant_"

# 2. Same, machine-readable
npx hardhat test solidity --gas-stats-json gas.json --grep-exclude "invariant_"

# 3. Each user-facing operation in isolation (prints the numbers below; also fails on a >30% regression)
npx hardhat test solidity contracts/test/invariant/GasBudget.t.sol -vv
```

Hardhat 3 has no `gas-reporter` plugin and no `--gas-report`; `--gas-stats` / `--gas-stats-json` are the
built-in equivalents. `--snapshot` / `--snapshot-check` (gas snapshots via `vm.snapshotGas*`) exist but were not
used, to avoid writing a `snapshots/` directory.

## 1. User-facing operations, measured in isolation

`contracts/test/invariant/GasBudget.t.sol` runs each operation as its own transaction (`isolate = true`, so
storage is cold like on-chain), fresh listing per test, `gasleft()` around the single call. The 21,000 base
cost and calldata gas are not included. Each row asserts a ceiling about 30% above the measured value.

| Operation | Gas | Ceiling |
|---|---:|---:|
| **ExitMarket** list: `gateway.transferExitAndCall` -> `onExitTransfer` (LIST, pending root) | 465,375 | 605,000 |
| ExitMarket sell-to-buyer, trivial mock buyer (hook overhead only) | 298,732 | 390,000 |
| ExitMarket sell-to-buyer, real ExitVault as buyer | 472,512 | 615,000 |
| ExitMarket `buy` (re-verifies the exit) | 240,053 | 315,000 |
| ExitMarket `cancel` (exit returned to seller) | 90,067 | 120,000 |
| ExitMarket `settle` (exit executed while listed) | 105,171 | 140,000 |
| **ExitVault** `deposit` (second LP, 100,000 USDG) | 104,313 | 140,000 |
| ExitVault `collect` (1 open position) | 112,522 | 150,000 |
| ExitVault `redeem` (0 open positions) | 84,276 | 110,000 |
| **ExitIntentRouter** `settle` (EIP-712 check + market hook + vault purchase + seller and relayer payouts) | 520,590 | 680,000 |
| ExitIntentRouter `reclaim` | 155,502 | 205,000 |

Measured 2026-10-01 on the v4 contracts. Against v3, every operation that verifies a pending root costs
35-43k more: the v4 legacy verifier also reads the node's parent (and, in the mock, a same-block neighbour) to rule
out a rival, and `buyExit` returns a consent value. Ceilings were re-set to about 30% above these figures.
Readings:

* A listing costs about 430k because `Listing` embeds the whole `ExitRecord`: roughly 14 fresh storage slots,
  about 22.1k gas each for a zero-to-nonzero write, which is most of the total. An instant sale to the vault
  is the same order because the market verifies the exit and the vault records its purchase.
* The gasless router path (521k) is barely more than a direct sale to the vault (473k): the signature check,
  balance reads and two transfers add about 48k.
* Vault cost grows with open positions (`MAX_OPEN_POSITIONS = 32`): with 32 open exits, cold, `totalAssets`
  costs 210,642, `deposit` 464,999 and `redeem` 436,557 (`ExitVaultOpenPositions.t.sol`,
  `test_gas_depositAndRedeemWithFullOpenSet`).

## 2. Hardhat `--gas-stats` ranges over the whole suite

Top-level calls only; the spread mixes scenarios (warm/cold, pending/confirmed roots, tree sizes).

| Function | Min | Avg | Median | Max | Calls |
|---|---:|---:|---:|---:|---:|
| ExitMarket `buy` | 179,789 | 223,564 | 236,942 | 241,742 | 13 |
| ExitMarket `cancel` | 84,972 | 86,729 | 84,972 | 98,979 | 8 |
| ExitMarket `settle` | 87,040 | 99,443 | 99,340 | 104,128 | 13 |
| ExitMarket `withdrawFees` | 55,123 | 55,123 | 55,123 | 55,123 | 5 |
| ExitMarket `allowGateway` | 68,043 | 141,042 | 144,207 | 144,401 | 24 |
| Mock gateway `transferExitAndCall` (includes the market hook: list / sell) | 188,045 | 524,670 | 464,877 | 920,603 | 312 |
| ExitVault `deposit` | 71,842 | 161,176 | 157,354 | 898,564 | 63 |
| ExitVault `redeem` | 55,788 | 143,048 | 74,346 | 884,141 | 12 |
| ExitVault `collect` | 67,350 | 79,915 | 79,860 | 88,485 | 42 |
| ExitVault `writeOff` | 71,376 | 109,795 | 113,524 | 133,906 | 38 |
| ExitVault `totalAssets` | 4,440 | 32,946 | 16,812 | 616,117 | 52 |
| ExitVault `quote` | 4,138 | 4,152 | 4,138 | 4,187 | 371 |
| ExitIntentRouter `settle` | 411,417 | 505,168 | 516,629 | 520,367 | 22 |
| ExitIntentRouter `reclaim` | 93,471 | 146,019 | 149,614 | 153,570 | 13 |
| ExitIntentRouter `recoverExecuted` | 104,475 | 124,689 | 119,521 | 182,271 | 13 |
| LegacyRootVerifier `verifyRoot` | 1,408 | 48,279 | 5,908 | 8,691,791 | 2,221 |
| BoldRootVerifier `verifyRoot` | 3,370 | 132,030 | 32,508 | 4,474,607 | 96 |
| BoldRootVerifier `register` | 45,206 | 124,750 | 124,818 | 124,890 | 1,309 |

The two maxima are deliberate worst cases: 512-level pending chains (`MAX_PENDING_DEPTH`) in
`test_pendingChainDepthIsBounded` (legacy) and `test_verifyRoot_pendingChainDepthIsBoundedByMaxPendingDepth`
(BOLD); the 513th level is refused. A real Xai pending chain is a couple of levels (section 4b).

### Deployment

| Contract | Deployment gas | Runtime size (bytes) |
|---|---:|---:|
| ExitMarket | 2,843,283 | 12,440 |
| ExitVault | 2,843,651 - 2,843,891 | 11,928 |
| ExitIntentRouter | 1,861,672 | 8,155 |
| BoldRootVerifier | 688,657 | 2,938 |
| LegacyRootVerifier | 556,066 | 2,325 |
## 3. Invariant campaigns

The invariant suites are not part of the gas figures; for scale, the full suite including them runs in about
45 s on a quiet machine (see COVERAGE.md for the campaign sizes).

## 4. Measured against real Arbitrum One state (Arbitrum One mainnet fork)

| What | Before commit 678a4c1 | Now | Saved |
|---|---:|---:|---:|
| BOLD `verifyRoot` over Arbitrum One's real 137-deep pending assertion chain | 2,117,406 | **1,366,113** | 751,293 (-35.5%) |
| Full listing of a real Arbitrum One exit through the real L1 gateway | 2,506,807 | **1,755,514** | 751,293 (-30.0%) |

Both savings are the same 751,293 gas, i.e. the ancestor-walk optimisation in `BoldRootVerifier` accounts for
the whole difference. Those figures were measured on 2026-09-29, when the fixture's withdrawal sat under 137
pending assertions.

The fork tests follow mainnet's latest block, and the pending chain shortens as ancestors confirm. On
2026-10-01 the fixture was regenerated through the TypeScript library (`scripts/lib/boldProof.ts`, via
`scripts/dev/makeArbOneFixture.ts`): a real pending withdrawal under a **134-deep** pending chain costs
**1,344,244** gas for `verifyRoot` and **1,733,628** for the full listing. Once the fixture's own assertion
confirms (about 6.4 days later) the tests skip with a message pointing at the generator. Run them with
`FORK_TESTS=1 npx hardhat test solidity contracts/test/fork/ArbOneBoldFork.t.sol`.

## 4b. The legacy rival walk on the live Xai rollup (Arbitrum Sepolia fork)

v4's `LegacyRootVerifier` walks `prevNum` from the exit's node to the latest confirmed node, reading each parent's
node once (plus a same-block scan only when siblings share a block). For a real pending Xai Testnet withdrawal
(fixture regenerated 2026-10-01, node 61962): **2 pending levels, 56,226 gas cold** for `verifyRoot`. Each extra
pending level adds one `getNode` read (roughly 15k gas cold); a 7-day window with hourly nodes is about 170 levels.
`FORK_TESTS=1 npx hardhat test solidity contracts/test/fork/XaiFork.t.sol` (the fork block must be recent unless
`ARB_SEPOLIA_RPC_URL` points at an archive node).

## 5. Stylus vs Solidity Merkle verifier

Source: `docs/audit/STYLUS_BENCH.json`, produced by `scripts/stylus/bench.ts` on Arbitrum Sepolia. It compares
the Stylus `ExitProof` program (`0x30ac015003186f187b9a11fff2781d55cc9e1394`) with its Solidity twin
`ExitLeafBench` (`0xa36aaa3ed116fe25f56bf3acf24ccdd9688981ce`, same ABI) by `eth_estimateGas` of
`rootFromItem(item, proof, index)`. Figures include the transaction base cost and the parent-chain data
component that `eth_estimateGas` reports on Arbitrum, equal for both.

| Proof depth | Solidity gas | Stylus gas | Stylus / Solidity |
|---:|---:|---:|---:|
| 7 (typical Xai) | 37,780 | 69,002 | 1.83x |
| 18 (typical Arbitrum One) | 54,290 | 80,892 | 1.49x |
| 32 | 75,497 | 96,681 | 1.28x |
| 64 | 123,016 | 131,713 | 1.07x |

Solidity is cheaper at every depth measured, so the market uses it. A straight-line fit through the depth 32 and
64 points gives Stylus a higher fixed cost (intercept about 61k gas vs about 27k for Solidity) but a lower
per-level cost (about 1,095 vs 1,485 gas per level), which puts the crossover near 86 levels, far beyond any
real send tree. That is an extrapolation, not a measurement.
