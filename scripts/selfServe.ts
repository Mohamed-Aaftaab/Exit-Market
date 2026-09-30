/**
 * Finish or undo a gasless exit without the hosted relayer. Both paths are permissionless on-chain; this script
 * only needs some Arbitrum Sepolia ETH for gas in the signing key (RELAYER_PRIVATE_KEY, KEEPER_PRIVATE_KEY or
 * DEPLOYER_PRIVATE_KEY, in that order).
 *
 *   node scripts/selfServe.ts settle <intent.json>   settle a signed order yourself (you earn its relayer fee)
 *   node scripts/selfServe.ts reclaim <withdrawalTx>  hand a router-owned exit back to its sender. The sender may do
 *                                                     this at any time; anyone else after RECLAIM_GRACE (3 days)
 *
 * intent.json: { "withdrawalTx": "0x…", "order": { gateway, exitNum, buyer, minProceeds, relayerFee, deadline },
 *                "signature": "0x…" } — the shape the web app keeps in localStorage and scripts/demo/gaslessExit.ts saves.
 */
import { readFileSync } from "node:fs";
import { getAddress, type Hex } from "viem";
import { exitIntentRouterAbi } from "./lib/abis.ts";
import { getClients, loadDeployment } from "./lib/clients.ts";
import { buildExitProof } from "./lib/exitProof.ts";
import { claimOf } from "./lib/hookData.ts";
import { XAI_TESTNET } from "./lib/networks.ts";
import { revertReason, trySettle, type SellOrder } from "./lib/relay.ts";

const KEYS = ["RELAYER_PRIVATE_KEY", "KEEPER_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY"] as const;

function routerAddress() {
  const { router } = loadDeployment();
  if (!router) throw new Error("No router in deployments/arbitrumSepolia.json");
  return getAddress(router);
}

async function settle(file: string) {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { withdrawalTx: Hex; order: Record<keyof SellOrder, string>; signature: Hex };
  const order: SellOrder = {
    gateway: getAddress(raw.order.gateway),
    exitNum: BigInt(raw.order.exitNum),
    buyer: getAddress(raw.order.buyer),
    minProceeds: BigInt(raw.order.minProceeds),
    relayerFee: BigInt(raw.order.relayerFee),
    deadline: BigInt(raw.order.deadline),
  };
  const { parent, child, parentWallet } = getClients(KEYS);
  const result = await trySettle({
    parent,
    child,
    wallet: parentWallet,
    router: routerAddress(),
    rollup: XAI_TESTNET.ethBridge.rollup,
    childGateway: XAI_TESTNET.tokenBridge.childErc20Gateway,
    withdrawalTx: raw.withdrawalTx,
    order,
    signature: raw.signature,
  });
  console.log(JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

async function reclaim(withdrawalTx: Hex) {
  const { account, parent, child, parentWallet } = getClients(KEYS);
  const router = routerAddress();
  const w = await buildExitProof({
    parent,
    child,
    rollup: XAI_TESTNET.ethBridge.rollup,
    childGateway: XAI_TESTNET.tokenBridge.childErc20Gateway,
    withdrawalTx,
  });
  if (w.initialDestination.toLowerCase() !== router.toLowerCase()) throw new Error("That withdrawal was not sent to the router");
  try {
    const { request } = await parent.simulateContract({
      account,
      address: router,
      abi: exitIntentRouterAbi,
      functionName: "reclaim",
      args: [XAI_TESTNET.tokenBridge.parentErc20Gateway, w.exitNum, claimOf(w)],
    });
    const hash = await parentWallet.writeContract(request);
    const receipt = await parent.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Reclaim reverted: ${hash}`);
    console.log(`Exit #${w.exitNum} returned to ${w.proof.from}: ${hash}`);
  } catch (err) {
    const reason = revertReason(err);
    throw reason ? new Error(`Reclaim would revert: ${reason}`) : err;
  }
}

const [command, arg] = process.argv.slice(2);
const run = command === "settle" && arg ? settle(arg) : command === "reclaim" && arg ? reclaim(arg as Hex) : undefined;
if (!run) {
  console.error("Usage: node scripts/selfServe.ts settle <intent.json> | reclaim <withdrawalTx>");
  process.exitCode = 1;
} else {
  run.catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
