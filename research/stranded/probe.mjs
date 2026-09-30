// Step 0 (optional). Check the public RPCs and how wide an eth_getLogs span they accept.
// usage: node probe.mjs
import { rpc, ARB, ETH, TOPIC_WI, hex, num, say } from './lib.mjs';

const GATEWAYS = [
  '0x09e9222E96E7B4AE2a407B98d48e330053351EEe', // L2 standard ERC20 gateway
  '0x096760F208390250649E3e8763348E783AEF5562', // L2 custom gateway
  '0x6c411aD3E74De3E7Bd422b94A27770f5B86C623B', // L2 WETH gateway
];

const bn = num(await rpc(ARB, 'eth_blockNumber', []));
const blk = await rpc(ARB, 'eth_getBlockByNumber', [hex(bn), false]);
say('arb head', bn, new Date(num(blk.timestamp) * 1000).toISOString(), 'l1BlockNumber', num(blk.l1BlockNumber));
say('eth head', num(await rpc(ETH, 'eth_blockNumber', [])));
say('WithdrawalInitiated topic', TOPIC_WI);

for (const span of [100_000, 1_000_000, 5_000_000, 20_000_000]) {
  const t = Date.now();
  try {
    const filter = { address: GATEWAYS, topics: [TOPIC_WI], fromBlock: hex(bn - span), toBlock: hex(bn) };
    const logs = await rpc(ARB, 'eth_getLogs', [filter], 1);
    say('span', span, 'logs', logs.length, Date.now() - t + 'ms');
  } catch (e) {
    say('span', span, 'err', e.message.slice(0, 300));
  }
}
