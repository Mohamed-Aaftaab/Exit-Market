// Step 11. Prove the stranded exits are really claimable: build each Outbox proof with NodeInterface at the confirmed
// L2 block's send tree, then eth_call Outbox.executeTransaction on Ethereum (from 0x…dEaD). Resumable.
// usage: node simall.mjs <l2tol1 json> <list json (rows with tx, position[, usd])> <confirmed L2 block> <out json> [min usd]
import fs from 'node:fs';
import { sleep, dataPath, readJson, writeJson, progress, say } from './lib.mjs';
import { sendTreeAt, executeCalldata, simulateClaim, messagesByKey } from './outbox.mjs';

const [msgF, listF, confBlk, outF, minUsd] = process.argv.slice(2);
if (!outF) throw new Error('usage: node simall.mjs <l2tol1 json> <list json> <confirmed L2 block> <out json> [min usd]');

async function simulateOne(m, position, tree) {
  try {
    const { root, calldata } = await executeCalldata(m, position, tree.size);
    if (root !== tree.sendRoot) throw new Error('root mismatch');
    return await simulateClaim(calldata);
  } catch (e) {
    return 'ERROR ' + e.message.slice(0, 150);
  }
}

const tree = await sendTreeAt(confBlk);
const msgs = messagesByKey(readJson(msgF));
const list = readJson(listF).filter((r) => minUsd === undefined || (r.usd || 0) >= +minUsd);
const out = fs.existsSync(dataPath(outF)) ? readJson(outF) : {};
for (const [i, r] of list.entries()) {
  if (out[r.position]) continue;
  const m = msgs.get(r.tx + ':' + r.position);
  out[r.position] = m ? await simulateOne(m, BigInt(r.position), tree) : 'ERROR message not found';
  if ((i + 1) % 20 === 0) {
    writeJson(outF, out);
    progress(`${i + 1}/${list.length}`);
  }
  await sleep(200);
}
writeJson(outF, out);
const v = Object.values(out);
say('OK', v.filter((s) => s === 'OK').length, 'REVERT', v.filter((s) => s.startsWith('REVERT')).length, 'ERROR', v.filter((s) => s.startsWith('ERROR')).length);
