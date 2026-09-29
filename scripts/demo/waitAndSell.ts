/**
 * Waits until a Xai withdrawal is committed by a rollup node, then sells it via sellExit.ts.
 * Usage: node scripts/demo/waitAndSell.ts <xai-withdrawal-tx-hash>
 */
import { execFileSync } from "node:child_process";
import { parseAbiItem, type Hex } from "viem";
import { getClients } from "../lib/clients.ts";
import { findLatestNode } from "../lib/exitProof.ts";
import { XAI_TESTNET } from "../lib/networks.ts";

const POLL_MS = 60_000;
const TIMEOUT_MS = 90 * 60_000;

const tx = process.argv[2] as Hex | undefined;
if (!tx) throw new Error("Usage: node scripts/demo/waitAndSell.ts <xai-withdrawal-tx-hash>");

const { parent, child } = getClients();
const receipt = await child.getTransactionReceipt({ hash: tx });
const ev = parseAbiItem("event L2ToL1Tx(address caller, address indexed destination, uint256 indexed hash, uint256 indexed position, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data)");
const log = receipt.logs.find((l) => l.address.toLowerCase() === "0x0000000000000000000000000000000000000064" && l.topics[0] === "0x3e7aafa77dbf186b7fd488006beff893744caa3c4f6f299e8a709fa2087374fc");
if (!log) throw new Error("No L2ToL1Tx in tx");
const position = BigInt(log.topics[3]!);
console.log(`Waiting for outbox position ${position} to be asserted…`, ev.name);

const started = Date.now();
for (;;) {
  const node = await findLatestNode(parent, child, XAI_TESTNET.ethBridge.rollup);
  console.log(`${new Date().toISOString()} latest node #${node.nodeNum} covers ${node.sendCount} sends`);
  if (position < node.sendCount) break;
  if (Date.now() - started > TIMEOUT_MS) throw new Error("Timed out waiting for assertion");
  await new Promise((r) => setTimeout(r, POLL_MS));
}
execFileSync("node", ["scripts/demo/sellExit.ts", tx], { stdio: "inherit" });
