/**
 * Exit Market keeper: completes the lifecycle of every exit the vault bought.
 *   pending  -> nothing to do yet
 *   rejected -> vault.writeOff (stop carrying at cost; still collectable if it pays out later)
 *   covered by a confirmed root -> Outbox.executeTransaction (tokens land in the vault), then vault.collect
 * Permissionless: anyone can run it with any funded key (KEEPER_PRIVATE_KEY, else DEPLOYER_PRIVATE_KEY).
 * Usage: node scripts/keeper.ts [--loop]
 */
import { BaseError, encodeAbiParameters, formatUnits, getAbiItem, keccak256, type Hash, type Hex } from "viem";
import { exitMarketAbi, exitVaultAbi } from "./lib/abis.ts";
import { getClients, loadDeployment, type Deployment } from "./lib/clients.ts";
import { getLogsChunked } from "./lib/logScan.ts";
import { XAI_TESTNET } from "./lib/networks.ts";
import { latestConfirmedRoot, outboxAbi, outboxMessage, outboxProof, type ConfirmedRoot } from "./lib/outbox.ts";

const EXIT_VERIFIED = getAbiItem({ abi: exitMarketAbi, name: "ExitVerified" });
const KEEPER_KEYS = ["KEEPER_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY"];
/** Scan window used when the deployment file records no deployBlock. */
const FALLBACK_LOOKBACK = 5_000_000n;
/** Arbitrum Sepolia getLogs span for the market's ExitVerified events (a failing chunk is bisected). */
const PARENT_LOG_CHUNK = 1_000_000n;
const LOOP_MS = 5 * 60_000;

type Clients = ReturnType<typeof getClients>;
type ExitRecord = NonNullable<Awaited<ReturnType<typeof scanVerified>>["logs"][number]["args"]["exit"]>;

export interface KeeperRun {
  verified: number;
  /** Exits whose step failed this run; they are retried on the next one. */
  failed: number;
}

const recordHash = (r: ExitRecord) => keccak256(encodeAbiParameters([{ type: "tuple", components: EXIT_VERIFIED.inputs[1].components }], [r]));
const errorMessage = (err: unknown) => (err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err));

function startBlock(d: Deployment, head: bigint): bigint {
  if (d.deployBlock === undefined) return head > FALLBACK_LOOKBACK ? head - FALLBACK_LOOKBACK : 0n;
  if (!Number.isSafeInteger(d.deployBlock) || d.deployBlock < 0) {
    throw new Error(`Invalid deployBlock ${d.deployBlock} in deployments/arbitrumSepolia.json`);
  }
  return BigInt(d.deployBlock);
}

function scanVerified(parent: Clients["parent"], market: Hex, fromBlock: bigint, toBlock: bigint) {
  return getLogsChunked(
    (from, to) => parent.getLogs({ address: market, event: EXIT_VERIFIED, fromBlock: from, toBlock: to }),
    fromBlock,
    toBlock,
    PARENT_LOG_CHUNK,
  );
}

async function waitSuccess(parent: Clients["parent"], hash: Hash, what: string): Promise<Hash> {
  const receipt = await parent.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${what} reverted (${hash})`);
  return hash;
}

async function isHeld(parent: Clients["parent"], vault: Hex, id: Hex, exit: ExitRecord): Promise<boolean> {
  const [storedHash] = await parent.readContract({ address: vault, abi: exitVaultAbi, functionName: "purchases", args: [id] });
  return storedHash === recordHash(exit);
}

async function isSpent(parent: Clients["parent"], index: bigint): Promise<boolean> {
  return parent.readContract({ address: XAI_TESTNET.ethBridge.outbox, abi: outboxAbi, functionName: "isSpent", args: [index] });
}

/** Executes the exit's Outbox message; losing that race to another keeper is fine (the tokens still land in the vault). */
async function executeOutbox({ parent, parentWallet, child }: Clients, exit: ExitRecord, confirmed: ConfirmedRoot, proof: Hex[], tag: string) {
  const m = await outboxMessage(child, exit.index, { toBlock: confirmed.childBlock });
  try {
    const hash = await parentWallet.writeContract({
      address: XAI_TESTNET.ethBridge.outbox,
      abi: outboxAbi,
      functionName: "executeTransaction",
      args: [proof, exit.index, m.caller, m.destination, m.arbBlockNum, m.ethBlockNum, m.timestamp, m.callvalue, m.data],
    });
    console.log(`  ${tag}: executed via Outbox ${await waitSuccess(parent, hash, "executeTransaction")}`);
  } catch (err) {
    if (!(await isSpent(parent, exit.index))) throw err;
    console.log(`  ${tag}: Outbox message already executed by someone else`);
  }
}

async function settleExit(clients: Clients, d: Deployment, confirmed: ConfirmedRoot, id: Hex, exit: ExitRecord, tag: string) {
  const { parent, parentWallet, child } = clients;
  const [storedHash, cost, writtenOff] = await parent.readContract({ address: d.vault, abi: exitVaultAbi, functionName: "purchases", args: [id] });
  if (storedHash !== recordHash(exit)) return; // not held by the vault (listing, or already collected)

  const spent = await isSpent(parent, exit.index);
  if (!spent && exit.index >= confirmed.sendCount) {
    if (!writtenOff && (await parent.readContract({ address: d.market, abi: exitMarketAbi, functionName: "isExitRejected", args: [exit] }))) {
      const hash = await parentWallet.writeContract({ address: d.vault, abi: exitVaultAbi, functionName: "writeOff", args: [exit] });
      console.log(`  ${tag}: node rejected -> writeOff ${await waitSuccess(parent, hash, "writeOff")}`);
    } else {
      console.log(`  ${tag}: pending (cost ${formatUnits(cost, 6)}), waiting for confirmation`);
    }
    return;
  }

  // Proof against the latest confirmed root (may differ from the pending root the exit was bought against).
  const { root, proof } = await outboxProof(child, confirmed.sendCount, exit.index);
  if (root !== confirmed.sendRoot) throw new Error("NodeInterface root mismatch");
  if (!spent) await executeOutbox(clients, exit, confirmed, proof, tag);

  const payout = { index: exit.index, confirmedRoot: confirmed.sendRoot, proof };
  const hash = await parentWallet.writeContract({ address: d.vault, abi: exitVaultAbi, functionName: "collect", args: [exit, payout] });
  console.log(`  ${tag}: collected ${await waitSuccess(parent, hash, "collect")}`);
}

/** One pass over every exit the market verified. A failing exit is logged and skipped, never aborts the pass. */
export async function runOnce({ clients = getClients(KEEPER_KEYS), deployment = loadDeployment() } = {}): Promise<KeeperRun> {
  const { parent, child } = clients;
  const d = deployment;
  const head = await parent.getBlockNumber();
  const [scan, confirmed] = await Promise.all([
    scanVerified(parent, d.market, startBlock(d, head), head),
    latestConfirmedRoot(parent, child, XAI_TESTNET.ethBridge.rollup),
  ]);
  console.log(`${new Date().toISOString()} ${scan.logs.length} verified exits; confirmed node #${confirmed.nodeNum} covers ${confirmed.sendCount} sends`);

  let failed = 0;
  for (const log of scan.logs) {
    const [id, exit] = [log.args.id!, log.args.exit!];
    const tag = `exit #${exit.exitNum} (${formatUnits(exit.amount, 6)} USDG, index ${exit.index})`;
    try {
      await settleExit(clients, d, confirmed, id, exit, tag);
    } catch (err) {
      // Another keeper may have collected it between our reads and our transaction.
      if (!(await isHeld(parent, d.vault, id, exit).catch(() => true))) {
        console.log(`  ${tag}: settled by someone else meanwhile`);
        continue;
      }
      failed++;
      console.error(`  ${tag}: failed, retrying next run: ${errorMessage(err)}`);
    }
  }

  const [total, idle] = await Promise.all([
    parent.readContract({ address: d.vault, abi: exitVaultAbi, functionName: "totalAssets" }),
    parent.readContract({ address: d.vault, abi: exitVaultAbi, functionName: "idleAssets" }),
  ]);
  console.log(`  vault: totalAssets ${formatUnits(total, 6)} USDG, idle ${formatUnits(idle, 6)} USDG`);
  return { verified: scan.logs.length, failed };
}

if (import.meta.main) {
  const loop = process.argv.includes("--loop");
  do {
    try {
      const run = await runOnce();
      if (run.failed > 0 && !loop) process.exitCode = 1;
    } catch (err) {
      console.error(errorMessage(err));
      if (!loop) process.exitCode = 1;
    }
    if (loop) await new Promise((r) => setTimeout(r, LOOP_MS));
  } while (loop);
}
