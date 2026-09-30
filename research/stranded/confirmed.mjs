// Step 6. Latest CONFIRMED Arbitrum One block: the Outbox's newest SendRootUpdated on Ethereum names the L2 block
// hash whose send root was confirmed. Every L2->L1 message at or below that block is claimable today.
// usage: node confirmed.mjs   -> data/confirmed.json
import { rpc, ETH, ARB, ARB1_OUTBOX, TOPIC_SEND_ROOT_UPDATED, hex, num, say, writeJson } from './lib.mjs';

async function latestSendRootLogs(head) {
  for (let back = 2000; back <= 64000; back *= 2) {
    try {
      const filter = { address: ARB1_OUTBOX, topics: [TOPIC_SEND_ROOT_UPDATED], fromBlock: hex(head - back), toBlock: hex(head) };
      const logs = await rpc(ETH, 'eth_getLogs', [filter], 2);
      say('lookback', back, 'logs', logs.length);
      if (logs.length > 0) return logs;
    } catch (e) {
      say('lookback', back, 'err', e.message.slice(0, 200));
    }
  }
  throw new Error('No SendRootUpdated in the last 64k Ethereum blocks');
}

const head = num(await rpc(ETH, 'eth_blockNumber', []));
const logs = await latestSendRootLogs(head);
const last = logs[logs.length - 1];
const l2 = await rpc(ARB, 'eth_getBlockByHash', [last.topics[2], false]);
const l1 = await rpc(ETH, 'eth_getBlockByNumber', [last.blockNumber, false]);
const out = {
  l1Block: num(last.blockNumber),
  l1Time: new Date(num(l1.timestamp) * 1000).toISOString(),
  l1tx: last.transactionHash,
  l2BlockHash: last.topics[2],
  l2Block: num(l2.number),
  l2Time: new Date(num(l2.timestamp) * 1000).toISOString(),
  sendCount: num(l2.sendCount),
};
say(JSON.stringify(out, null, 1));
writeJson('confirmed.json', out, true);
