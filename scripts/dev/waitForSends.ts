/**
 * Blocks until the latest Xai Testnet rollup node commits at least `n` L2→L1 sends (i.e. outbox index n-1 is
 * provable). Usage: node scripts/dev/waitForSends.ts <n>
 */
import { findLatestNode } from "../lib/exitProof.ts";
import { getClients } from "../lib/clients.ts";
import { XAI_TESTNET } from "../lib/networks.ts";

const POLL_MS = 60_000;

async function main() {
  const target = BigInt(process.argv[2] ?? "0");
  if (target <= 0n) throw new Error("Usage: waitForSends.ts <n>");
  const { parent, child } = getClients();
  for (;;) {
    const node = await findLatestNode(parent, child, XAI_TESTNET.ethBridge.rollup);
    console.log(`${new Date().toISOString()} node #${node.nodeNum}: ${node.sendCount} sends`);
    if (node.sendCount >= target) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
