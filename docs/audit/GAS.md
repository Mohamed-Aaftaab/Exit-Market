# Gas report

Date: 2026-09-30. Hardhat 3.18.0, solc 0.8.28 (viaIR, optimizer 200 runs), EDR `cancun`, mock Arbitrum
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
| **ExitMarket** list: `gateway.transferExitAndCall` -> `onExitTransfer` (LIST, pending root) | 430,134 | 560,000 |
| ExitMarket sell-to-buyer, trivial mock buyer (hook overhead only) | 255,688 | 335,000 |
| ExitMarket sell-to-buyer, real ExitVault as buyer | 429,578 | 560,000 |
| ExitMarket `buy` | 204,790 | 270,000 |
| ExitMarket `cancel` (exit returned to seller) | 90,067 | 120,000 |
| ExitMarket `settle` (exit executed while listed) | 105,171 | 140,000 |
| **ExitVault** `deposit` (second LP, 100,000 USDG) | 104,288 | 140,000 |
| ExitVault `collect` (1 open position) | 112,477 | 150,000 |
| ExitVault `redeem` (0 open positions) | 84,289 | 110,000 |
| **ExitIntentRouter** `settle` (EIP-712 check + market hook + vault purchase + seller and relayer payouts) | 477,655 | 620,000 |
| ExitIntentRouter `reclaim` | 120,240 | 160,000 |

Readings:

* A listing costs about 430k because `Listing` embeds the whole `ExitRecord`: roughly 14 fresh storage slots,
  about 22.1k gas each for a zero-to-nonzero write, which is most of the total. An instant sale to the vault
  is the same order because the market verifies the exit and the vault records its purchase.
* The gasless router path (477k) is barely more than a direct sale to the vault (430k): the signature check,
  balance reads and two transfers add about 48k.
* Vault cost grows with open positions (`MAX_OPEN_POSITIONS = 32`): with 32 open exits, cold, `totalAssets`
  costs 302,991, `deposit` 620,766 and `redeem` 622,702 (`ExitVaultOpenPositions.t.sol`,
  `test_gas_depositAndRedeemWithFullOpenSet`).

## 2. Hardhat `--gas-stats` ranges over the whole suite

Top-level calls only; the spread mixes scenarios (warm/cold, pending/confirmed roots, tree sizes).

| Function | Min | Avg | Median | Max | Calls |
|---|---:|---:|---:|---:|---:|
| ExitMarket `buy` | 167,492 | 195,998 | 201,680 | 206,682 | 12 |
| ExitMarket `cancel` | 84,972 | 87,315 | 84,972 | 98,979 | 6 |
| ExitMarket `settle` | 87,040 | 98,998 | 99,340 | 102,639 | 10 |
| ExitMarket `withdrawFees` | 55,123 | 55,123 | 55,123 | 55,123 | 5 |
| ExitMarket `allowGateway` | 67,927 | 139,878 | 144,091 | 144,401 | 18 |
| Mock gateway `transferExitAndCall` (includes the market hook: list / sell) | 152,804 | 377,155 | 337,676 | 465,751 | 300 |
| ExitVault `deposit` | 71,820 | 162,410 | 157,332 | 887,854 | 59 |
| ExitVault `redeem` | 55,799 | 147,829 | 69,479 | 873,466 | 11 |
| ExitVault `collect` | 67,315 | 80,290 | 79,824 | 88,450 | 42 |
| ExitVault `writeOff` | 71,194 | 109,433 | 113,342 | 133,724 | 37 |
| ExitVault `totalAssets` | 4,440 | 32,772 | 16,820 | 610,773 | 52 |
| ExitVault `quote` | 4,094 | 4,139 | 4,143 | 4,143 | 41 |
| ExitIntentRouter `settle` | 368,483 | 460,910 | 473,695 | 477,433 | 21 |
| ExitIntentRouter `reclaim` | 93,417 | 113,394 | 114,352 | 118,308 | 12 |
| ExitIntentRouter `recoverExecuted` | 104,421 | 121,925 | 119,467 | 147,009 | 13 |
| LegacyRootVerifier `verifyRoot` | 3,354 | 25,914 | 27,761 | 27,761 | 385 |
| BoldRootVerifier `verifyRoot` | 3,370 | 132,299 | 32,508 | 4,474,607 | 96 |
| BoldRootVerifier `register` | 45,206 | 124,751 | 124,818 | 124,890 | 1,312 |

The 4,474,607 maximum is the deliberate worst case: a 512-level pending chain (`MAX_PENDING_DEPTH`) in
`test_verifyRoot_pendingChainDepthIsBoundedByMaxPendingDepth`; the 513th level is refused.

### Deployment

| Contract | Deployment gas | Runtime size (bytes) |
|---|---:|---:|
| ExitMarket | 2,813,859 | 12,304 |
| ExitVault | 2,711,756 - 2,711,996 | 11,445 |
| ExitIntentRouter | 1,861,672 | 8,155 |
| BoldRootVerifier | 688,645 | 2,938 |
| LegacyRootVerifier | 370,311 | 1,466 |

## 3. Invariant campaigns

The invariant suites are not part of the gas figures; for scale, the full suite including them runs in about
45 s on a quiet machine (see COVERAGE.md for the campaign sizes).

## 4. Measured against real Arbitrum One state (Arbitrum One mainnet fork)

| What | Before commit 678a4c1 | Now | Saved |
|---|---:|---:|---:|
| BOLD `verifyRoot` over Arbitrum One's real 137-deep pending assertion chain | 2,117,406 | **1,366,113** | 751,293 (-35.5%) |
| Full listing of a real Arbitrum One exit through the real L1 gateway | 2,506,807 | **1,755,514** | 751,293 (-30.0%) |

Both savings are the same 751,293 gas, i.e. the ancestor-walk optimisation in `BoldRootVerifier` accounts for
the whole difference. The fork tests live in `contracts/test/fork/ArbOneBoldFork.t.sol` and need network
access (`FORK_TESTS=1 npx hardhat test solidity --grep arbOne`); they are skipped by default and were not run
for this report.

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
