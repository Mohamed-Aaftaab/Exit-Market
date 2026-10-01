/**
 * Waits until a Xai withdrawal is committed by a rollup node, then sells it via sellExit.ts.
 * Usage: node scripts/demo/waitAndSell.ts <xai-withdrawal-tx-hash>
 */
import { execFileSync } from "node:child_process";
import type { Hex } from "viem";
import { getClients } from "../lib/clients.ts";
import { decodeWithdrawal, findLatestNode } from "../lib/exitProof.ts";
import { XAI_TESTNET } from "../lib/networks.ts";

const POLL_MS = 60_000;
const TIMEOUT_MS = 90 * 60_000;

const tx = process.argv[2] as Hex | undefined;
if (!tx) throw new Error("Usage: node scripts/demo/waitAndSell.ts <xai-withdrawal-tx-hash>");

const { parent, child } = getClients();
// The same decoding sellExit.ts proves with: fails fast on a tx that is not a USDG gateway withdrawal.
const { exitNum, position } = await decodeWithdrawal(child, XAI_TESTNET.tokenBridge.childErc20Gateway, tx);
console.log(`Waiting for exit #${exitNum} (outbox position ${position}) to be asserted…`);

const started = Date.now();
for (;;) {
  const node = await findLatestNode(parent, child, XAI_TESTNET.ethBridge.rollup);
  console.log(`${new Date().toISOString()} latest node #${node.nodeNum} covers ${node.sendCount} sends`);
  if (position < node.sendCount) break;
  if (Date.now() - started > TIMEOUT_MS) throw new Error("Timed out waiting for assertion");
  await new Promise((r) => setTimeout(r, POLL_MS));
}
execFileSync(process.execPath, ["scripts/demo/sellExit.ts", tx], { stdio: "inherit" });
