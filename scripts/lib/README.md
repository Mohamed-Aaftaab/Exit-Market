# Exit Market TypeScript library

What a wallet, a bridge UI, a relayer or a keeper needs to prove, sell and settle a pending Arbitrum withdrawal.
The web app (`web/`, imported as `@shared/*`) and every script in this repository use exactly this code. It is
plain TypeScript on [viem](https://viem.sh); entry point [`index.ts`](index.ts).

| Module | What it gives you |
|---|---|
| `exitProof.ts` | `buildExitProof`: from a child-chain withdrawal tx hash to the full claim (Outbox leaf fields, Merkle proof from `NodeInterface.constructOutboxProof`, and the **earliest still-pending** rollup node whose send root covers it). Typed errors: `NotYetAssertedError` (retry after the next node), `InvalidWithdrawalError` (not a gateway withdrawal) |
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

## Scope today

Legacy (pre-BOLD) rollups, which covers Xai Testnet and most live Orbit L3s. The contracts also verify BOLD
assertions (`BoldRootVerifier`, proven on an Arbitrum One mainnet fork), but this library does not yet build BOLD
claims or register assertion chains. Another Orbit chain is a new `networks.ts` entry with its gateway and rollup
addresses.
