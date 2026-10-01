# Slither static analysis

Tool: Slither 0.11.6 (102 detectors), solc 0.8.28 `--via-ir --optimize`, dependencies and tests excluded. Run on
the **v4** sources (the deployed ones) on 2026-10-01, one entry contract at a time:

```bash
for f in ExitMarket ExitVault ExitIntentRouter verifiers/LegacyRootVerifier verifiers/BoldRootVerifier; do
  slither "contracts/$f.sol" --solc-remaps "@openzeppelin/=node_modules/@openzeppelin/" \
    --solc-args "--via-ir --optimize" --exclude-dependencies --filter-paths "node_modules|contracts/test"
done
```

Raw output: [`slither-raw.txt`](slither-raw.txt).

**Result: 0 unresolved findings.** Three detector classes that Slither rates High or Medium fire. Each is triaged
below, with the reason and the test that backs it. Nothing is suppressed in source: the deployed contracts are
source-verified on Sourcify and match this repository.

| Detector (Slither impact) | Location | Verdict |
|---|---|---|
| `arbitrary-send-erc20` (High) | `ExitMarket._sellToBuyer`: `safeTransferFrom(buyer, market, price)` | **By design, and consent-gated since v4.** The seller names the buyer, but the market pulls only after `IExitBuyer(buyer).buyExit(exit)` returns `IExitBuyer.buyExit.selector` together with a non-zero price: the buyer's explicit consent to buy this exit at this price. An EOA returns nothing, a contract without `buyExit` reverts, and a wallet whose fallback returns data cannot produce the magic value. The vault approves exactly `price` inside `buyExit`, so no allowance outlives the call. Tests: `test_aWalletWhoseFallbackReturnsADecodableReplyCannotBeCharged`, `test_aWalletWhoseFallbackReturnsAPriceCannotBeCharged`, `test_aBuyerReturningTheWrongMagicIsNotCharged` ([`Round6Hardening.t.sol`](../../contracts/test/Round6Hardening.t.sol)); `test_H1_*` ([`Round5Exploits.t.sol`](../../contracts/test/Round5Exploits.t.sol)) |
| `reentrancy-balance` (High) | `ExitIntentRouter.settle`: proceeds are a balance delta across `transferExitAndCall` | **Mitigated by the C1 fix.** Only trusted code runs between the two reads. The gateway must be allowed by the market, whose ownership is renounced, so the list is fixed to Xai's two real gateways. The buyer must equal the router's immutable buyer, the vault. `settle` is `nonReentrant`. Tests: `test_C1_hostileGatewayCannotStealAVictimsExecutedExit`, `test_C1_untrustedBuyerIsRejected`, `test_buyerIsBoundAtConstruction` ([`ExitIntentRouterExploits.t.sol`](../../contracts/test/ExitIntentRouterExploits.t.sol)) |
| `unused-return` (Medium) | `getExternalCall` (data), `verifyRoot` (pending flag, deadline), `ECDSA.tryRecover` (third value) | By design: only the owner, the validity flag and the recover error are needed. |
| `reentrancy-benign` (Low) | `ExitMarket._sellToBuyer`: `accruedFees` written after `buyExit` | Inside `nonReentrant`. The fee is taken from a price the buyer must then pay in full (`PaymentShortfall` otherwise). |
| `calls-loop` (Low) | `ExitVault._isRejected` over open positions; `BoldRootVerifier._unchallengedToConfirmed`; `LegacyRootVerifier._uncontestedToConfirmed` and `_hasLiveRival` | Bounded: `MAX_OPEN_POSITIONS` (32), `MAX_PENDING_DEPTH` (512), `MAX_SAME_BLOCK_SCAN` (16). The calls are `view` reads of the rollup the verifier was frozen with. Gas is in [`GAS.md`](GAS.md). |
| `timestamp` (Low) | listing expiry, share lock (7 d), impairment window (14 d), order deadline | Windows are hours to days; validator timestamp drift (seconds) is irrelevant. |

Gone since v3: `uninitialized-local` (the vault's two locals are now explicitly initialised), `unindexed-event-address`
(`FeeUpdated` indexes its recipient) and `pragma` (every file pins 0.8.28).

Correction to the pre-v3 version of this file: it reported "0 high, 0 medium", but `unused-return` (Medium) fired
then too. The table above lists every detector that fires, whatever its impact.
