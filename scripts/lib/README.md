# Exit Market TypeScript library

What a wallet, a bridge UI, a relayer or a keeper needs to prove, sell and settle a pending Arbitrum withdrawal.
The web app (`web/`, imported as `@shared/*`) and every script in this repository use exactly this code. It is
plain TypeScript on [viem](https://viem.sh); entry point [`index.ts`](index.ts).

| Module | What it gives you |
|---|---|
| `exitProof.ts` | Legacy (pre-BOLD) rollups. `buildExitProof`: from a child-chain withdrawal tx hash to the full claim (Outbox leaf fields, Merkle proof from `NodeInterface.constructOutboxProof`, and the covering node: a **confirmed** one if it exists, else the **earliest still-pending** one). `decodeWithdrawal` reads any gateway withdrawal. Typed errors: `NotYetAssertedError` (retry after the next node), `InvalidWithdrawalError` (not a gateway withdrawal) |
| `boldProof.ts` | BOLD rollups (Arbitrum One/Nova, Arbitrum Sepolia, new Orbit chains). `buildBoldExitProof`: the claim against the earliest pending assertion `BoldRootVerifier` accepts (uncontested back to the latest confirmed one), plus the chain of assertions to register first (`unregistered` filters the ones the verifier already knows); `assertionHashOf` mirrors the verifier's hash |
| `listings.ts` | `loadOpenListings` (live open listings with liveness), `listingIdOf` (mirrors `ExitKeys.id`), `listingEconomics` (seller net, buyer discount and annualised return) |
| `outbox.ts` | `latestConfirmedRoot` (from the Outbox's `SendRootUpdated`, so the same for legacy and BOLD), `outboxMessage` and `outboxProof` for `Outbox.executeTransaction` |
| `hookData.ts` | `encodeSellToBuyer` / `encodeList`: the `data` for `gateway.transferExitAndCall`; `netOfMarketFee` for the seller's floor; `toExitRecord` for `ExitVault.quote` |
| `relay.ts` | EIP-712 `SellOrder` types and `routerDomain` for gasless orders; `trySettle` (idempotent: reports `waiting`, `settled` or `done-elsewhere`); `revertReason` decodes custom errors |
| `abis.ts` | ABIs generated from the compiled contracts (`npm run abis`); CI fails if they drift |
| `networks.ts` | Xai Testnet and Arbitrum Sepolia config, and the viem chain for Xai |
| `logScan.ts` | bounded, bisecting `eth_getLogs` over public RPCs |

## Sell a pending withdrawal (one transaction)

```ts
import { createPublicClient, createWalletClient, http } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { buildExitProof, encodeSellToBuyer, netOfMarketFee, toExitRecord, exitVaultAbi, exitMarketAbi,
  XAI_TESTNET, xaiTestnet } from "./index.ts";

const parent = createPublicClient({ chain: arbitrumSepolia, transport: http() });
const child = createPublicClient({ chain: xaiTestnet, transport: http() });

// 1. Prove the withdrawal against the rollup's pending commitments (throws NotYetAssertedError until a node posts).
const w = await buildExitProof({ parent, child, rollup: XAI_TESTNET.ethBridge.rollup,
  childGateway: XAI_TESTNET.tokenBridge.childErc20Gateway, withdrawalTx });

// 2. Price it and set the seller's floor, net of the market fee.
const record = toExitRecord(w, { parent: XAI_TESTNET.tokenBridge.parentErc20Gateway,
  child: XAI_TESTNET.tokenBridge.childErc20Gateway }, deadlineBlock, true);
const quote = await parent.readContract({ address: vault, abi: exitVaultAbi, functionName: "quote", args: [record] });
const feeBps = await parent.readContract({ address: market, abi: exitMarketAbi, functionName: "feeBps" });

// 3. One signature: redirect the exit to the market, which proves it and sells it to the vault atomically.
await wallet.writeContract({ address: XAI_TESTNET.tokenBridge.parentErc20Gateway, abi: gatewayAbi,
  functionName: "transferExitAndCall",
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