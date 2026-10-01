# Exit Market TypeScript library

What a wallet, a bridge UI, a relayer or a keeper needs to prove, sell and settle a pending Arbitrum withdrawal.
The web app (`web/`, imported as `@shared/*`) and every script in this repository use exactly this code. It is
plain TypeScript on [viem](https://viem.sh); entry point [`index.ts`](index.ts).

| Module | What it gives you |
|---|---|
| `exitProof.ts` | Legacy (pre-BOLD) rollups. `buildExitProof`: from a child-chain withdrawal tx hash to the full claim (Outbox leaf fields, Merkle proof from `NodeInterface.constructOutboxProof`, and the covering node: a **confirmed** one if it exists, else the **earliest still-pending** one). `decodeWithdrawal` reads any gateway withdrawal. Typed errors: `NotYetAssertedError` (retry after the next node), `InvalidWithdrawalError` (not a gateway withdrawal) |
| `boldProof.ts` | BOLD rollups (Arbitrum One/Nova, Arbitrum Sepolia, new Orbit chains). `buildBoldExitProof`: the claim against a **confirmed** assertion if one covers the withdrawal, else the earliest pending one `BoldRootVerifier` accepts (uncontested back to the latest confirmed one), plus the chain of assertions to register first (`unregistered` filters the ones the verifier already knows). `pickCovering` is that rule on its own (tested); `assertionHashOf` mirrors the verifier's hash |
| `listings.ts` | `loadOpenListings` (live open listings with liveness), `listingIdOf` (mirrors `ExitKeys.id`), `listingEconomics` (seller net, buyer discount and annualised return) |
| `marketReads.ts` | `exitRecordFor`: the `ExitRecord` the market will build for a claim (pending or confirmed, deadline), from the verifier the market froze for that gateway; `rootVerdict` is the verdict alone |
| `outbox.ts` | `latestConfirmedRoot` (from the Outbox's `SendRootUpdated`, so the same for legacy and BOLD), `outboxMessage` and `outboxProof` for `Outbox.executeTransaction`, `outboxRootOf` to check that a confirmed root holds a given exit at its index |
| `keeperPlan.ts` | `keeperStep`: the keeper's decision table for one exit (execute and collect, settle, write off, wait), pure and tested |
| `hookData.ts` | `encodeSellToBuyer` / `encodeList`: the `data` for `gateway.transferExitAndCall`; `netOfMarketFee` for the seller's floor; `toExitRecord` for `ExitVault.quote` |
| `relay.ts` | EIP-712 `SellOrder` types and `routerDomain` for gasless orders; `trySettle` (idempotent: reports `waiting`, `settled` or `done-elsewhere`); `revertReason` decodes custom errors |
| `abis.ts` | ABIs generated from the compiled contracts (`npm run abis`); CI fails if they drift |
| `networks.ts` | Xai Testnet and Arbitrum Sepolia config, and the viem chain for Xai |
| `logScan.ts` | bounded, bisecting `eth_getLogs` over public RPCs |

## Sell a pending withdrawal (one transaction)

```ts
import { createPublicClient, http, parseAbi } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { buildExitProof, encodeSellToBuyer, exitMarketAbi, exitRecordFor, exitVaultAbi, netOfMarketFee,
  XAI_TESTNET, xaiTestnet } from "./index.ts";

// market and vault from deployments/arbitrumSepolia.json; withdrawalTx is the seller's withdrawal on Xai Testnet;
// wallet is the seller's viem WalletClient on Arbitrum Sepolia.
const parent = createPublicClient({ chain: arbitrumSepolia, transport: http() });
const child = createPublicClient({ chain: xaiTestnet, transport: http() });
const gateways = { parent: XAI_TESTNET.tokenBridge.parentErc20Gateway, child: XAI_TESTNET.tokenBridge.childErc20Gateway };

// 1. Prove the withdrawal: against a confirmed root if one covers it, else the earliest pending node
//    (throws NotYetAssertedError until a node posts).
const w = await buildExitProof({ parent, child, rollup: XAI_TESTNET.ethBridge.rollup,
  childGateway: gateways.child, withdrawalTx });

// 2. The record the market will build (its own verifier decides pending or confirmed, and the deadline), the
//    vault's price for it, and the seller's floor net of the market fee.
const { record, verdict } = await exitRecordFor(parent, market, gateways, w);
if (!verdict.valid) throw new Error("Its rollup node is disputed: it sells once a covering root confirms");
const [quote, feeBps] = await Promise.all([
  parent.readContract({ address: vault, abi: exitVaultAbi, functionName: "quote", args: [record] }),
  parent.readContract({ address: market, abi: exitMarketAbi, functionName: "feeBps" }),
]);

// 3. One signature: redirect the exit to the market, which proves it and sells it to the vault atomically.
const gatewayAbi = parseAbi([
  "function transferExitAndCall(uint256 exitNum, address initialDestination, address newDestination, bytes newData, bytes data)",
]);
await wallet.writeContract({ address: gateways.parent, abi: gatewayAbi, functionName: "transferExitAndCall",
  args: [w.exitNum, w.initialDestination, market, "0x", encodeSellToBuyer(w, vault, netOfMarketFee(quote, feeBps))] });
```

`scripts/demo/sellExit.ts` is the runnable version.

## Relay a gasless order

```ts
import { trySettle } from "./index.ts";

const result = await trySettle({ parent, child, wallet, router, rollup, childGateway, withdrawalTx, order, signature });
// { status: "waiting" } until a node covers it, then { status: "settled", txHash },
// or { status: "done-elsewhere" } if another relayer settled it first (no gas spent).
```

`web/src/app/api/relay/route.ts` (hosted relayer) and `scripts/selfServe.ts` (be your own relayer) use it.

## Prove a BOLD withdrawal

```ts
import { buildBoldExitProof, loadAssertions, unregistered, boldRootVerifierAbi } from "./index.ts";

const assertions = await loadAssertions(parent, rollup, fromBlock, toBlock); // back past the latest confirmed one
const { withdrawal, covering } = await buildBoldExitProof({ parent, child, rollup, childGateway, withdrawalTx, assertions });
// covering.chain is empty when a confirmed assertion covers the withdrawal: nothing to register then.
for (const a of await unregistered(parent, boldVerifier, rollup, covering.chain)) {
  await wallet.writeContract({ address: boldVerifier, abi: boldRootVerifierAbi, functionName: "register",
    args: [rollup, a.parent, a.afterState, a.inboxAcc] });
}
// then sell or list exactly as above: the claim carries the assertion hash in blockHash.
```

`scripts/dev/makeArbOneFixture.ts` runs this against Arbitrum One mainnet (a real pending withdrawal under a
134-deep pending chain) and the fork tests check the result through the real L1 gateway.

## Scope today

Legacy rollups (Xai Testnet and most live Orbit L3s) end to end on testnet, including the keeper. BOLD claims are
built and verified on an Arbitrum One mainnet fork; no BOLD gateway is allowed on the live testnet market, and
proving a BOLD rejection (`BoldRootVerifier.markRejected`) is not automated yet. Another Orbit chain is a new
`networks.ts` entry with its gateway and rollup addresses.