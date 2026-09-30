// Step 1. Pin the snapshot: Arbitrum One head plus the blocks exactly 365/30/14/7 days before it.
// usage: node findblocks.mjs            -> data/blocks.json
import { rpc, ARB, hex, num, say, writeJson } from './lib.mjs';

const DAY = 86400;
const head = num(await rpc(ARB, 'eth_blockNumber', []));
const ts = async (n) => num((await rpc(ARB, 'eth_getBlockByNumber', [hex(n), false])).timestamp);

/** Last block whose timestamp is <= target (binary search, ~30 calls). */
async function blockAt(target) {
  let lo = 1;
  let hi = head;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await ts(mid)) <= target) lo = mid;
    else hi = mid;
  }
  return lo;
}

const headTs = await ts(head);
const out = { head, headTs, headIso: new Date(headTs * 1000).toISOString() };
for (const d of [365, 30, 14, 7]) {
  const block = await blockAt(headTs - d * DAY);
  const bts = await ts(block);
  out['d' + d] = { block, ts: bts, iso: new Date(bts * 1000).toISOString() };
}
say(JSON.stringify(out, null, 1));
writeJson('blocks.json', out, true);
