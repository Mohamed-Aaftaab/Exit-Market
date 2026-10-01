# Test coverage and invariant evidence

Date: 2026-10-01 (v4 contracts, after round 6). Hardhat 3.18.0, solc 0.8.28 (viaIR, optimizer 200 runs), forge-std 1.10.0, EDR `cancun`.
Result: **440 passing, 0 failing, 10 skipped** (the 10 skipped are the fork tests against Arbitrum One mainnet
and the live Xai rollup, which need `FORK_TESTS=1` and network access; with it set, all 450 pass).

## Reproduce

```bash
npx hardhat test solidity                                            # everything (about 45 s)
npx hardhat test solidity --coverage                                 # everything, instrumented (about 8 min)
npx hardhat test solidity --coverage --grep-exclude "invariant_"     # unit + fuzz suites only (about 4 min)
npx hardhat test solidity contracts/test/invariant/ExitMarketInvariant.t.sol
npx hardhat test solidity contracts/test/invariant/ExitIntentRouterInvariant.t.sol
```

Coverage output: console table, `coverage/html/index.html`, `coverage/lcov.info` (the `coverage/` directory is
git-ignored).

## What Hardhat 3 reports, and what it does not

Hardhat 3.18 coverage is **line and statement only** (the two columns are nearly identical). Branch and function
counters are `0/0` in both `lcov.info` and the HTML summary: branch coverage and function coverage are not
supported. Two substitutes are given below, both derived from the same lcov file and clearly weaker than real
branch coverage:

* function coverage: a function counts as hit if any executable line inside its body was hit;
* revert-path proxy: for every `revert CustomError(...)` in a contract, whether some test names that error
  (`CustomError.selector` or `CustomError(...)` in an assertion). It shows which failure modes are asserted; it
  does not prove the branch itself executed.

## Production contracts

| Contract | Lines, full suite (v4, 2026-10-01) | Lines, full suite (v3) | Functions hit (derived, v2) | Custom-error reverts named by a test (v2) |
|---|---|---|---|---|
| `ExitMarket.sol` | 178/181 (98.34%) | 177/180 (98.33%) | 26/26 | 18/20 |
| `ExitIntentRouter.sol` | 86/86 (100%) | 86/86 (100%) | 10/10 | 14/14 |
| `ExitVault.sol` | 148/148 (100%) | 137/137 (100%) | 27/27 | 16/16 |
| `verifiers/BoldRootVerifier.sol` | 48/48 (100%) | 48/48 (100%) | 6/6 | 6/6 |
| `verifiers/LegacyRootVerifier.sol` | 28/28 (100%; also 100% from its own test file alone) | 7/7 (100%) | 4/4 | 0/0 |
| `libraries/ExitLeaf.sol` | 20/20 (100%) | 20/20 (100%) | 4/4 | 2/2 |
| `libraries/ExitAccrual.sol` | 4/4 (100%) | 4/4 (100%) | 1/1 | 0/0 |
| `libraries/ExitKeys.sol` | 1/1 (100%) | 1/1 (100%) | 1/1 | 0/0 |
| **Production total** | **513/516 (99.42%)** | **480/483 (99.38%)** | **79/79** | **56/58** |

Not counted above: `contracts/bench/ExitLeafBench.sol` (0%, a benchmark twin deployed only on Arbitrum Sepolia by
`scripts/stylus/bench.ts`, no unit test) and the test scaffolding (mocks, fixtures, handlers).

### The three uncovered production lines

All are in `ExitMarket.sol`, all are defensive reverts that cannot be reached through a correct gateway, and they
are exactly the two custom errors no test names:

| Line | Statement | Why unreachable |
|---|---|---|
| 242 | `if (owner_ != address(this)) revert ExitNotHeld();` in `_verifyExit` | The hook runs after the gateway redirected the exit to the market; only a hostile allowlisted gateway could call it otherwise |
| 365 | same check in `_requireLive` | A listed exit is owned by the market by construction |
| 301 | `if (_listings[id].status == Status.Listed) revert ListingExists(id);` in `_list` | While Listed the market owns the exit, so the gateway refuses a second redirect (`hostileRelistWhileListed` in the market invariant campaign asserts exactly that) |

One further line, `if (price == 0) revert ZeroPrice();` in `_sellToBuyer`, is not reached by the unit suites but is
by the invariant campaign (`hostile:sellTerms`), which is why the full-suite figure is one line higher.

## Invariant and stateful-fuzz suites (new)

Hardhat 3's Solidity runner supports forge-std handler-based `invariant_*` functions, `targetContract` /
`targetSelector`, counterexample output and shrinking, and inline configuration through
`/// forge-config: default.invariant.runs = N` (used here; no change to `hardhat.config.ts`).
Each `invariant_*` function is its own campaign, so a file's cost is (number of invariants) x runs x depth.

| Suite | Invariants | Runs x depth per invariant | Non-vacuity walk |
|---|---:|---|---|
| `ExitMarketInvariant.t.sol` (handler: `MarketHandler.sol`, 24 exits, 6 traders, 2 tokens) | 7 | 64 x 120 | 24 worlds x 200 steps, 23 outcomes |
| `ExitIntentRouterInvariant.t.sol` (handler: `RouterHandler.sol`, 20 exits, 3 signers, real vault) | 5 | 100 x 150 | 24 worlds x 150 steps, 15 outcomes |

Each file also has `test_handlerReachesEveryOutcomeWithoutViolations`: a deterministic pseudo-random walk over 24
fresh deployments that must reach every legal, hostile and unsolicited outcome the invariants depend on (at
least once each) with zero violations, so a handler edit cannot silently turn an invariant vacuous.

Both handlers keep an independent model (shadow owner per exit, token ledger, fee ledger, listing status
machine) and record every divergence in a `violations` counter instead of reverting, because a revert inside a
handler is silently discarded by the fuzzer. Legal actions that revert unexpectedly, hostile actions that
succeed, and status changes on an exit an action did not touch all count as violations.

### ExitMarket

| Invariant | Asserts |
|---|---|
| `invariant_marketPaymentBalanceEqualsFeesPlusEscrow` (a) | market payment-token balance >= accrued fees + payouts of Listed-and-executed exits (never insolvent), and exactly equal once unsolicited tokens (donations, payouts of exits redirected without a hook) are added; same for the second token |
| `invariant_feesAreConservedAcrossSalesAndWithdrawals` (a) | fees earned (floor(price x snapshot bps)) = still accrued + withdrawn; recipients hold exactly what was withdrawn |
| `invariant_everyBalanceMatchesTheIndependentLedger` (a) | every participant's balance in both tokens equals the model ledger; total supply = minted; nothing created or destroyed |
| `invariant_exitHasExactlyOneOwnerConsistentWithListingStatus` (b) | the gateway's owner equals the model's; Listed implies market-owned; the market owns an exit only while Listed, Settled or misdirected (never Sold or Cancelled); spent bit equals the model |
| `invariant_statusMachineAndHostileActionsBehave` (b) | no illegal status move (Sold<->Cancelled, Sold->Settled, None->Sold), none on an untouched exit; every hostile call reverted with the expected error |
| `invariant_feeBpsSnapshotNeverExceedsCapAndNeverChanges` (d) | live `feeBps` and every listing's snapshot <= 200; a snapshot equals the fee at listing time forever |
| `invariant_listingTermsNeverChangeAfterListing` | seller, price, expiry and exit amount of a listing never change |

Actions: list, buy, cancel (seller, or anyone after expiry), settle, Outbox execution, instant sale to an
`IExitBuyer` that lies about its price, fee withdrawal, fee change, direct exit transfer, donation, exit
redirected without hook data, time travel. Hostile: buy/cancel/settle a non-listed exit, list or sell a spent
exit, buy an expired listing or above the buyer's max price, re-list while the market owns the exit, fee above the
cap, fee change by a stranger, instant sale below the seller's minimum or paying zero.

### ExitIntentRouter (with the vault as the only buyer, as enforced since the round-4 fix)

| Invariant | Asserts |
|---|---|
| `invariant_routerHoldsOnlyUnrecoveredPayoutsAndDonations` (c) | router payment-token balance = payouts of executed, still router-owned, unrecovered exits + donations; it always covers what it owes; a settlement never leaves or takes a token |
| `invariant_sellersAndRelayersReceiveWhatTheVaultPaidMinusMarketFee` (c) | per settlement and cumulatively: vault paid = seller + relayer + floor(paid x market bps); the market holds only its fees |
| `invariant_paymentTokenSupplyIsFullyAccountedFor` (c) | every token is with a tracked participant; supply = LP deposit + minted |
| `invariant_exitOwnershipMatchesTheModel` (b) | one owner per exit, equal to the model: router until settled (vault) or reclaimed (sender); a settled exit is with the vault |
| `invariant_settlementsAndHostileCallsBehave` (c) | see below |

Per call, inside the handler: the router's balance is unchanged across `settle`; the market's balance and
`accruedFees` grow by exactly floor(paid x bps); the seller gets received - relayerFee and the relayer gets
relayerFee (or the seller-relayer gets received); proceeds below the seller's minimum revert `ProceedsBelowMin`
and change nothing; the vault refusing an exit (too large, pending not accepted, price zero) reverts atomically.
Hostile and must revert with the exact error: wrong signer, tampered relayer fee, expired order, foreign buyer
(`BuyerNotAllowed`), foreign gateway (`GatewayNotAllowed`), replay of a settled order, `reclaim` before the grace
period (`ReclaimLocked`) and after Outbox execution (`ExitAlreadySpent`), second or premature or wrong-owner
`recoverExecuted`.

### Do the invariants have teeth? (mutation check)

Each mutant below was injected into a scratch copy of the project (never into this tree) and the matching
invariant file was run with the committed campaign sizes. **All 17 mutants were caught.**

| Mutant | Caught by |
|---|---|
| M1 `buy` charges the live fee instead of the listing's snapshot | status/hostile, fee conservation, ledger |
| M2 `buy` forgets to accrue the fee | status/hostile, balance = fees + escrow, fee conservation, ledger |
| M3 `cancel` marks the listing Sold | status machine |
| M4 `settle` leaves the listing Listed (settle twice) | status machine, balance = fees + escrow |
| M5 fee cap removed from `setFee` | status/hostile, fee snapshot cap, fee conservation, ledger |
| M6 instant sale trusts the buyer's reported price | status/hostile, balance = fees + escrow, fee conservation, ledger |
| M7 `buy` pays the seller the full price | status/hostile, ledger |
| M8 anyone may cancel before expiry | status/hostile, ownership, ledger |
| M9 `withdrawFees` does not reset `accruedFees` | status/hostile, balance = fees + escrow, fee conservation, ledger |
| R1 relayer fee is never paid | hostile/behave, router balance |
| R2 buyer allowlist removed | hostile/behave |
| R3 `reclaim` allowed after Outbox execution (the round-4 H1 bug) | hostile/behave, router balance, ownership |
| R4 `recoverExecuted` never marks the item recovered | hostile/behave, router balance |
| R5 seller is also paid the relayer's fee | hostile/behave, router balance |
| R6 any valid signer accepted, not only the exit's sender | hostile/behave, value split, router balance, ownership |
| R7 gateway allowlist removed | hostile/behave |
| R8 seller's minimum proceeds ignored | hostile/behave, value split, router balance, ownership |

## Test inventory (full run)

| Kind | Count |
|---|---:|
| Unit / scenario tests | 405 |
| Property fuzz tests (`testFuzz_*`, 256 runs each unless stated) | 18 |
| Invariant campaigns (7 market + 5 router + 5 vault) | 17 |
| **Total passing** | **440** |
| Skipped (fork tests, `FORK_TESTS` unset) | 10 |

v4 added 27: 20 legacy-verifier tests (`LegacyRootVerifier.t.sol`, including a property fuzz that checks the
verifier against a brute-force model of random node trees: never valid for a contested or doomed node, always
valid for an honest chain) and 7 market-level hardening tests (`Round6Hardening.t.sol`), plus one fork test on
the live Xai rollup.

Of these, 21 are new in this evidence pack: the 12 market and router invariants and 9 gas-budget tests
(`GasBudget.t.sol`, see GAS.md). The vault has its own invariant suite (`ExitVaultInvariant.t.sol`, 5 invariants,
not part of this pack).

## Hardhat 3.18 limitations and quirks met while building this

* No branch or function coverage (lines and statements only); see above.
* Coverage runs about 10x slower than a plain run because every test, including the invariant campaigns, is
  instrumented (the whole suite: about 45 s plain, about 8 min instrumented).
* `--gas-stats` reports top-level calls only, with no per-line or internal-call breakdown and no USD cost, and
  there is no `--gas-report` / gas-reporter plugin. Storage is warm inside a single test transaction, so
  meaningful per-operation numbers need `isolate = true` (`/// forge-config: default.isolate = true`), which is
  what `GasBudget.t.sol` does.
* Inline `/// forge-config: default.invariant.runs = N` and `default.invariant.depth = N` work at contract level
  (also `default.isolate`); the invariant defaults are otherwise set only in `hardhat.config.ts`, which was left
  untouched. There is no CLI flag for campaign size.
* Every `invariant_*` function is a separate campaign, so the runtime scales with the number of invariants.
* `console.log` from `afterInvariant` and from handlers is not shown for passing invariant campaigns, so
  campaign statistics cannot be printed from inside a campaign. The walk tests above replace that.
* forge-std's `bound()` prints a `Bound result` line on every call in ordinary (non-fuzz) tests. The handlers
  use their own silent `_clamp` so the walk tests do not flood the output.
* After a `--coverage` run, a plain `npx hardhat test solidity <invariant file>` failed for every invariant with
  `failed to set up invariant testing environment: [targetSelectors] address does not have an associated
  contract` until `npx hardhat build --force` was run. Treat `build --force` as the fix whenever that error
  appears.
* viaIR is sensitive to stack depth in test code: a `setUp` with many locals, an 11-argument constructor call and
  a constant loop bound of 24 each triggered `Yul ... too deep in the stack`; the fixtures use a struct
  (`Wiring`), small helpers and a storage variable for the loop bound to stay clear of it.
* `IntentFixture.setUp` is not `virtual`, so a test that needs its own setup after the standard router
  deployment cannot extend it; the router invariant test repeats the six deployment lines on top of
  `ExitTreeFixture` instead.

## Function-level coverage script

`lcov.info` from `--coverage` in, table out (Python 3):

```python
import re, sys
lcov, src = sys.argv[1], sys.argv[2]            # e.g. coverage/lcov.info contracts/ExitMarket.sol
da, cur = {}, None
for line in open(lcov, encoding="utf-8"):
    line = line.strip()
    if line.startswith("SF:"):
        cur = line[3:].replace("\\", "/")
        da[cur] = {}
    elif line.startswith("DA:") and cur:
        n, h = line[3:].split(",")[:2]
        da[cur][int(n)] = int(h)
hits = next(v for k, v in da.items() if k.endswith(src.replace("\\", "/")))
lines = open(src, encoding="utf-8").read().split("\n")
total = covered = 0
i = 0
while i < len(lines):
    m = re.match(r"\s*(function\s+(\w+)|constructor)", lines[i])
    if not m:
        i += 1
        continue
    depth, started, j = 0, False, i
    while j < len(lines):
        for ch in lines[j]:
            depth += (ch == "{") - (ch == "}")
            started = started or ch == "{"
        if started and depth == 0 or (not started and lines[j].rstrip().endswith(";")):
            break
        j += 1
    body = [h for n, h in hits.items() if i + 1 <= n <= j + 1]
    if started and body:
        total += 1
        covered += any(h > 0 for h in body)
        if not any(h > 0 for h in body):
            print("NOT HIT:", m.group(2) or "constructor")
    i = j + 1
print(f"{covered}/{total} functions with executable code were hit")
```
