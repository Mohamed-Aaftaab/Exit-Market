/**
 * Exit Market keeper: completes the lifecycle of every exit the vault bought.
 *   pending  -> nothing to do yet
 *   rejected -> vault.writeOff (stop carrying at cost; still collectable if it pays out later)
 *   covered by a confirmed root -> Outbox.executeTransaction (tokens land in the vault), then vault.collect
 * Permissionless: anyone can run it. Usage: node scripts/keeper.ts [--loop]
 */
import { encodeAbiParameters, formatUnits, keccak256, parseAbi, parseAbiItem, type Hex } from "viem";
import { getClients, loadDeployment } from "./lib/clients.ts";
import { XAI_TESTNET } from "./lib/networks.ts";
import { latestConfirmedRoot, outboxAbi, outboxMessage, outboxProof } from "./lib/outbox.ts";

const RECORD =
  "(address gateway, uint256 exitNum, address initialDestination, address l1Token, uint256 amount, uint256 index, bytes32 itemHash, bytes32 sendRoot, uint64 nodeNum, bytes32 blockHash, bool pending, uint64 deadlineBlock)";
const EXIT_VERIFIED = parseAbiItem(`event ExitVerified(bytes32 indexed id, ${RECORD} exit)`);
const MARKET_DEPLOY_LOOKBACK = 5_000_000n;
const LOOP_MS = 5 * 60_000;

const vaultAbi = parseAbi([
  `struct ExitRecord { address gateway; uint256 exitNum; address initialDestination; address l1Token; uint256 amount; uint256 index; bytes32 itemHash; bytes32 sendRoot; uint64 nodeNum; bytes32 blockHash; bool pending; uint64 deadlineBlock; }`,
  "struct PayoutProof { uint256 index; bytes32 confirmedRoot; bytes32[] proof; }",
  "function purchases(bytes32 key) view returns (bytes32 recordHash, uint256 cost, bool writtenOff, uint64 writtenOffAt, bool finalized)",
  "function collect(ExitRecord exit, PayoutProof payout)",
  "function writeOff(ExitRecord exit)",
  "function totalAssets() view returns (uint256)",
  "function idleAssets() view returns (uint256)",
]);
const marketAbi = parseAbi([
  `struct ExitRecord { address gateway; uint256 exitNum; address initialDestination; address l1Token; uint256 amount; uint256 index; bytes32 itemHash; bytes32 sendRoot; uint64 nodeNum; bytes32 blockHash; bool pending; uint64 deadlineBlock; }`,
  "function isExitRejected(ExitRecord exit) view returns (bool)",
]);

type ExitRecord = {
  gateway: Hex; exitNum: bigint; initialDestination: Hex; l1Token: Hex; amount: bigint; index: bigint;
  itemHash: Hex; sendRoot: Hex; nodeNum: bigint; blockHash: Hex; pending: boolean; deadlineBlock: bigint;
};

const recordHash = (r: ExitRecord) => keccak256(encodeAbiParameters([{ type: "tuple", components: EXIT_VERIFIED.inputs[1].components }], [r]));

async function runOnce() {
  const { parent, parentWallet, child } = getClients();
  const d = loadDeployment();
  const head = await parent.getBlockNumber();

  const verified = await parent.getLogs({ address: d.market, event: EXIT_VERIFIED, fromBlock: head - MARKET_DEPLOY_LOOKBACK, toBlock: head });
  const confirmed = await latestConfirmedRoot(parent, child, XAI_TESTNET.ethBridge.rollup);
  console.log(`${new Date().toISOString()} ${verified.length} verified exits; confirmed node #${confirmed.nodeNum} covers ${confirmed.sendCount} sends`);

  for (const log of verified) {
    const exit = log.args.exit as ExitRecord;
    const [storedHash, cost, writtenOff] = await parent.readContract({ address: d.vault, abi: vaultAbi, functionName: "purchases", args: [log.args.id!] });
    if (storedHash !== recordHash(exit)) continue; // not held by the vault (listing, or already collected)
    const tag = `exit #${exit.exitNum} (${formatUnits(exit.amount, 6)} USDG, index ${exit.index})`;

    const spent = await parent.readContract({ address: XAI_TESTNET.ethBridge.outbox, abi: outboxAbi, functionName: "isSpent", args: [exit.index] });
    if (!spent && exit.index >= confirmed.sendCount) {
      if (!writtenOff && (await parent.readContract({ address: d.market, abi: marketAbi, functionName: "isExitRejected", args: [exit] }))) {
        const hash = await parentWallet.writeContract({ address: d.vault, abi: vaultAbi, functionName: "writeOff", args: [exit] });
        console.log(`  ${tag}: node rejected -> writeOff ${hash}`);
      } else {
        console.log(`  ${tag}: pending (cost ${formatUnits(cost, 6)}), waiting for confirmation`);
      }
      continue;
    }

    // Proof against the latest confirmed root (may differ from the pending root the exit was bought against).
    const { root, proof } = await outboxProof(child, confirmed.sendCount, exit.index);
    if (root !== confirmed.sendRoot) throw new Error("NodeInterface root mismatch");

    if (!spent) {
      const m = await outboxMessage(child, exit.index);
      const hash = await parentWallet.writeContract({
        address: XAI_TESTNET.ethBridge.outbox,
        abi: outboxAbi,
        functionName: "executeTransaction",
        args: [proof, exit.index, m.caller, m.destination, m.arbBlockNum, m.ethBlockNum, m.timestamp, m.callvalue, m.data],
      });
      await parent.waitForTransactionReceipt({ hash });
      console.log(`  ${tag}: executed via Outbox ${hash}`);
    }

    const payout = { index: exit.index, confirmedRoot: confirmed.sendRoot, proof };
    const hash = await parentWallet.writeContract({ address: d.vault, abi: vaultAbi, functionName: "collect", args: [exit, payout] });
    await parent.waitForTransactionReceipt({ hash });
    console.log(`  ${tag}: collected ${hash}`);
  }

  const [total, idle] = await Promise.all([
    parent.readContract({ address: d.vault, abi: vaultAbi, functionName: "totalAssets" }),
    parent.readContract({ address: d.vault, abi: vaultAbi, functionName: "idleAssets" }),
  ]);
  console.log(`  vault: totalAssets ${formatUnits(total, 6)} USDG, idle ${formatUnits(idle, 6)} USDG`);
}

const loop = process.argv.includes("--loop");
do {
  try {
    await runOnce();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    if (!loop) process.exitCode = 1;
  }
  if (loop) await new Promise((r) => setTimeout(r, LOOP_MS));
} while (loop);
