/** Prints Xai Testnet's rollup progress and the bridge's Outbox allowance. Usage: node scripts/dev/checkRollupViews.ts */
import { createPublicClient, http, parseAbi } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { ARBITRUM_SEPOLIA, XAI_TESTNET } from "../lib/networks.ts";

const { bridge, outbox, rollup } = XAI_TESTNET.ethBridge;
const c = createPublicClient({ chain: arbitrumSepolia, transport: http(ARBITRUM_SEPOLIA.rpcUrl) });
const a = parseAbi([
  "function allowedOutboxes(address) view returns (bool)",
  "function firstUnresolvedNode() view returns (uint64)",
  "function latestNodeCreated() view returns (uint64)",
  "function latestConfirmed() view returns (uint64)",
]);
console.log("allowedOutboxes:", await c.readContract({ address: bridge, abi: a, functionName: "allowedOutboxes", args: [outbox] }));
for (const f of ["latestConfirmed", "firstUnresolvedNode", "latestNodeCreated"] as const) {
  console.log(f, await c.readContract({ address: rollup, abi: a, functionName: f }));
}
// Rollup deadlines count Ethereum (L1) blocks: inside the EVM, block.number on Arbitrum is the L1 block number.
const block = (await c.getBlock()) as { number: bigint; l1BlockNumber?: string };
console.log("Arbitrum Sepolia block:", block.number, "L1 block:", block.l1BlockNumber ? BigInt(block.l1BlockNumber) : "n/a");