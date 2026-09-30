// Spot check before simall.mjs: simulate the claim of the N largest stranded exits and confirm the Outbox knows
// the confirmed send root.
// usage: node simulate.mjs <l2tol1 json> <unclaimed json> <confirmed L2 block> [n = 8]
import { rpc, ETH, ARB1_OUTBOX, encodeFunctionData, sleep, readJson, say } from './lib.mjs';
import { outboxAbi, sendTreeAt, executeCalldata, simulateClaim, messagesByKey } from './outbox.mjs';

const [msgF, unF, confBlk, nArg] = process.argv.slice(2);
if (!confBlk) throw new Error('usage: node simulate.mjs <l2tol1 json> <unclaimed json> <confirmed L2 block> [n]');

const tree = await sendTreeAt(confBlk);
const rootsCall = encodeFunctionData({ abi: outboxAbi, functionName: 'roots', args: [tree.sendRoot] });
const known = await rpc(ETH, 'eth_call', [{ to: ARB1_OUTBOX, data: rootsCall }, 'latest']);
say('confirmed L2 block', confBlk, 'sendCount', tree.size, 'sendRoot', tree.sendRoot, 'outbox.roots(sendRoot)=', known);

const msgs = messagesByKey(readJson(msgF));
const top = readJson(unF).sort((a, b) => (b.usd || 0) - (a.usd || 0)).slice(0, +(nArg || 8));
for (const r of top) {
  const { root, calldata } = await executeCalldata(msgs.get(r.tx + ':' + r.position), BigInt(r.position), tree.size);
  const status = await simulateClaim(calldata, 2);
  say(`${r.symbol} ${r.human} pos=${r.position} root==sendRoot:${root === tree.sendRoot} -> ${status === 'OK' ? 'SIMULATION OK (claimable now)' : status}`);
  await sleep(300);
}
