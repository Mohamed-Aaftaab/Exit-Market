// Probe an Orbit chain's RPC before collecting: head, block time, send count and max eth_getLogs span.
// usage: node l3probe.mjs <name> <rpc>   (default: Superposition)
import { rpc, ARB_SYS, TOPIC_L2_TO_L1_TX, hex, num, say } from './lib.mjs';

const [name = 'Superposition', url = 'https://rpc-superposition-1v9rjalnat.t.conduit.xyz'] = process.argv.slice(2);
const SAMPLE = 100_000;

try {
  const bn = num(await rpc(url, 'eth_blockNumber', [], 2));
  const b = await rpc(url, 'eth_getBlockByNumber', [hex(bn), false], 2);
  const b2 = await rpc(url, 'eth_getBlockByNumber', [hex(bn - SAMPLE), false], 2);
  const blockTime = (num(b.timestamp) - num(b2.timestamp)) / SAMPLE;
  say(name, 'head', bn, new Date(num(b.timestamp) * 1000).toISOString(), 'avg block time', blockTime.toFixed(3), 's', 'sendCount', b.sendCount);
  for (const span of [100_000, 1_000_000, 10_000_000]) {
    try {
      const filter = { address: ARB_SYS, topics: [TOPIC_L2_TO_L1_TX], fromBlock: hex(Math.max(0, bn - span)), toBlock: hex(bn) };
      say('  span', span, 'L2ToL1Tx', (await rpc(url, 'eth_getLogs', [filter], 1)).length);
    } catch (e) {
      say('  span', span, 'err', e.message.slice(0, 200));
    }
  }
} catch (e) {
  say(name, 'ERR', e.message.slice(0, 200));
}
