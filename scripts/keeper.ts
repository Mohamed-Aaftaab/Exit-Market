/**
 * Exit Market keeper: completes the lifecycle of every exit the market verified.
 *   pending  -> nothing to do yet
 *   held by a confirmed root -> Outbox.executeTransaction, which pays whoever owns the exit (the vault, a
 *               listing's buyer, a seller who cancelled), then: vault.collect if the vault holds it, or
 *               market.settle if it was still listed (the seller gets face value)
 *   node rejected, vault-held, not paid out under the confirmed root -> vault.writeOff, so it stops being carried
 *               at cost (it stays collectable if it pays out later), whether or not the confirmed root has reached
 *               its index yet. The decision table is keeperStep (scripts/lib/keeperPlan.ts, tested)
 * Permissionless: anyone can run it with any funded key (KEEPER_PRIVATE_KEY, else DEPLOYER_PRIVATE_KEY).
 * Usage: node scripts/keeper.ts [--loop | --minutes N]   (a pass every 5 minutes; --minutes stops after about N)
 */
import { BaseError, encodeAbiParameters, formatUnits, getAbiItem, keccak256, type Hash, type Hex } from "viem";
import { exitMarketAbi, exitVaultAbi } from "./lib/abis.ts";
import { getClients, loadDeployment, type Deployment } from "./lib/clients.ts";
import { keeperStep } from "./lib/keeperPlan.ts";
import { ListingStatus } from "./lib/listings.ts";
import { getLogsChunked } from "./lib/logScan.ts";
import { XAI_TESTNET } from "./lib/networks.ts";
import { latestConfirmedRoot, outboxAbi, outboxMessage, outboxProof, outboxRootOf, type ConfirmedRoot } from "./lib/outbox.ts";

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

/** Who holds the exit on our side right now: decides what follows its Outbox execution. */
async function holderOf({ parent }: Clients, d: Deployment, id: Hex, exit: ExitRecord) {
  const [[storedHash, cost, writtenOff], listing] = await Promise.all([
    parent.readContract({ address: d.vault, abi: exitVaultAbi, functionName: "purchases", args: [id] }),
    parent.readContract({ address: d.market, abi: exitMarketAbi, functionName: "getListing", args: [id] }),
  ]);
  return {
    vault: storedHash === recordHash(exit) ? { cost, writtenOff } : undefined,
    listed: listing.status === ListingStatus.Listed && recordHash(listing.exit) === recordHash(exit),
  };
}

async function processExit(clients: Clients, d: Deployment, confirmed: ConfirmedRoot, id: Hex, exit: ExitRecord, tag: string) {
  const { parent, parentWallet, child } = clients;
  const [holder, spent] = await Promise.all([holderOf(clients, d, id, exit), isSpent(parent, exit.index)]);
  // Executed and nothing of ours holds it: the Outbox already paid its owner (most historical exits end here).
  if (spent && !holder.vault && !holder.listed) return;

  const covered = exit.index < confirmed.sendCount;
  const [rejected, path] = await Promise.all([
    parent.readContract({ address: d.market, abi: exitMarketAbi, functionName: "isExitRejected", args: [exit] }),
    // Proof against the latest confirmed root (may differ from the pending root the exit was proven against).
    covered ? outboxProof(child, confirmed.sendCount, exit.index) : undefined,
  ]);
  if (path && path.root !== confirmed.sendRoot) throw new Error("NodeInterface root mismatch");
  const itemConfirmed = path !== undefined && outboxRootOf(exit.itemHash, path.proof, exit.index) === confirmed.sendRoot;
  const step = keeperStep({ spent, covered, itemConfirmed, vault: holder.vault, listed: holder.listed, rejected });

  if (step.kind === "done") return;
  if (step.kind === "wait") {
    const where = holder.vault ? `vault, cost ${formatUnits(holder.vault.cost, 6)}` : holder.listed ? "listed" : "owner's";
    console.log(`  ${tag}: ${step.why} (${where})`);
    return;
  }
  if (step.kind === "write-off") {
    const hash = await parentWallet.writeContract({ address: d.vault, abi: exitVaultAbi, functionName: "writeOff", args: [exit] });
    console.log(`  ${tag}: node rejected -> writeOff ${await waitSuccess(parent, hash, "writeOff")}`);
    return;
  }

  // collect / settle / execute: the confirmed root holds this exit, so run its Outbox message if nobody has.
  const payout = { index: exit.index, confirmedRoot: confirmed.sendRoot, proof: path!.proof };
  if (!spent) await executeOutbox(clients, exit, confirmed, payout.proof, tag);
  if (step.kind === "collect") {
    const hash = await parentWallet.writeContract({ address: d.vault, abi: exitVaultAbi, functionName: "collect", args: [exit, payout] });
    console.log(`  ${tag}: collected ${await waitSuccess(parent, hash, "collect")}`);
  } else if (step.kind === "settle") {
    const hash = await parentWallet.writeContract({ address: d.market, abi: exitMarketAbi, functionName: "settle", args: [id, payout] });
    console.log(`  ${tag}: paid out while listed -> settled to the seller ${await waitSuccess(parent, hash, "settle")}`);
  }
}
/** One pass over every exit the market verified. A failing exit is logged and skipped, never aborts the pass. */
export async function runOnce({ clients = getClients(KEEPER_KEYS), deployment = loadDeployment() } = {}): Promise<KeeperRun> {
  const { parent, child } = clients;
  const d = deployment;
  const head = await parent.getBlockNumber();
  const [scan, confirmed] = await Promise.all([
    scanVerified(parent, d.market, startBlock(d, head), head),
    latestConfirmedRoot(parent, child, XAI_TESTNET.ethBridge.outbox),
  ]);
  console.log(`${new Date().toISOString()} ${scan.logs.length} verified exits; latest confirmed root covers ${confirmed.sendCount} sends`);

  // An exit listed, cancelled and listed again is verified twice: only its latest record matters.
  const latest = new Map<Hex, ExitRecord>();
  for (const log of scan.logs) latest.set(log.args.id!, log.args.exit!);

  let failed = 0;
  for (const [id, exit] of latest) {
    const tag = `exit #${exit.exitNum} (${formatUnits(exit.amount, 6)} USDG, index ${exit.index})`;
    try {
      await processExit(clients, d, confirmed, id, exit, tag);
    } catch (err) {
      // Another keeper may have finished it between our reads and our transaction.
      const holder = await holderOf(clients, d, id, exit).catch(() => undefined);
      if (holder && !holder.vault && !holder.listed && (await isSpent(parent, exit.index).catch(() => false))) {
        console.log(`  ${tag}: completed by someone else meanwhile`);
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
  return { verified: latest.size, failed };
}

/** `--minutes N`: loop like --loop, but stop once another pass would start after N minutes (a CI job's budget). */
function loopMinutes(argv: readonly string[]): number | undefined {
  const at = argv.indexOf("--minutes");
  if (at < 0) return undefined;
  const minutes = Number(argv[at + 1]);
  if (!(minutes > 0)) throw new Error("--minutes needs a positive number");
  return minutes;
}

if (import.meta.main) {
  const minutes = loopMinutes(process.argv);
  const loop = process.argv.includes("--loop") || minutes !== undefined;
  const stopAt = minutes === undefined ? Number.POSITIVE_INFINITY : Date.now() + minutes * 60_000;
  for (;;) {
    try {
      const run = await runOnce();
      if (run.failed > 0 && !loop) process.exitCode = 1;
    } catch (err) {
      console.error(errorMessage(err));
      if (!loop) process.exitCode = 1;
    }
    if (!loop || Date.now() + LOOP_MS > stopAt) break;
    await new Promise((r) => setTimeout(r, LOOP_MS));
  }
}
