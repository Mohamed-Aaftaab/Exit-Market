# Slither static analysis

Tool: Slither 0.11.6 (102 detectors), solc 0.8.28 `--via-ir --optimize`, dependencies excluded.
Raw output: [`slither-raw.txt`](slither-raw.txt).

**Result: 0 high, 0 medium.** Every informational finding triaged below.

| Detector | Location | Verdict |
|---|---|---|
| reentrancy-no-eth / reentrancy-events | `ExitMarket._sellToBuyer`, `ExitIntentRouter.settle` | False positive. Both run inside `nonReentrant`; the price is *measured* as a balance delta after `IExitBuyer.buyExit`, so the dependent state cannot be written before the call. Covered by malicious-buyer re-entry tests. |
| incorrect-equality | `price == 0` in `_sellToBuyer` | Intended zero-payment guard. |
| unused-return | `getExternalCall` (data), `buyExit` (price), `verifyRoot` (pending/deadline), `ECDSA.tryRecover` (3rd value) | By design. Notably the market ignores the buyer-reported price and trusts only the measured balance delta. |
| timestamp | listing expiry, share lock (7 d), impairment window (14 d), order deadline | Windows are hours to days; validator timestamp drift (seconds) is irrelevant. |
| unindexed-event-address | `FeeUpdated(uint16,address)` | Cosmetic. Left unchanged so the deployed contract keeps an exact verified-source match. |
| pragma | `^0.8.28` in shared interface/library vs pinned `0.8.28` in contracts | Cosmetic; everything compiles with 0.8.28. Same reason as above. |
