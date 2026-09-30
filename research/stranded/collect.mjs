// Step 2. Collect raw logs over a block range with an adaptive span (shrinks on timeouts, grows when sparse).
// usage: node collect.mjs <from> <to> <outfile> [topic0 | "wi" | "l2tol1" | "-"] [address csv]
//   "wi"     = WithdrawalInitiated from ANY emitter (default; emitters are classified later)
//   "l2tol1" = ArbSys L2ToL1Tx (address defaults to 0x64)
// RPC defaults to Arbitrum One; set RPC=<url> to collect from another chain (e.g. an Orbit L3).
import { rpc, ARB, ARB_SYS, TOPIC_WI, TOPIC_L2_TO_L1_TX, hex, sleep, progress, say, writeJson } from './lib.mjs';

const [from, to, outfile, topicArg, addrArg] = process.argv.slice(2);
if (!outfile) throw new Error('usage: node collect.mjs <from> <to> <outfile> [topic0|wi|l2tol1|-] [address csv]');

const TOPICS = { wi: TOPIC_WI, l2tol1: TOPIC_L2_TO_L1_TX, '-': TOPIC_WI };
const topic = TOPICS[topicArg ?? '-'] ?? topicArg;
const addresses = addrArg ? addrArg.split(',') : topicArg === 'l2tol1' ? [ARB_SYS] : undefined;
const url = process.env.RPC || ARB;

const MAX_SPAN = 20_000_000;
const MIN_SPAN = 1_000;
const DENSE = 3_000; // grow the span only while chunks stay below this many logs

async function collect(first, last) {
  const all = [];
  let f = first;
  let span = 10_000_000;
  while (f <= last) {
    const e = Math.min(f + span - 1, last);
    try {
      const q = { topics: [topic], fromBlock: hex(f), toBlock: hex(e) };
      if (addresses) q.address = addresses;
      const logs = await rpc(url, 'eth_getLogs', [q], 4);
      all.push(...logs);
      progress(`${f}-${e} span ${span}: ${logs.length} (total ${all.length})`);
      f = e + 1;
      if (logs.length < DENSE && span < MAX_SPAN) span = Math.floor(span * 1.5);
    } catch (err) {
      progress(`err ${f}-${e} span ${span}: ${err.message.slice(0, 200)}`);
      span = Math.max(MIN_SPAN, Math.floor(span / 3));
      await sleep(1000);
    }
  }
  return all;
}

const logs = await collect(parseInt(from), parseInt(to));
writeJson(outfile, logs);
say('done', logs.length);
