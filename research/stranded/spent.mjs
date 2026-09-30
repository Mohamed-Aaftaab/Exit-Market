// Step 4. Outbox.isSpent(position) on Ethereum for every L2->L1 message, 400 per Multicall3 eth_call.
// Resumable: positions already in <out json> are skipped.
// usage: node spent.mjs <l2tol1 json> <out json>
import fs from 'node:fs';
import {
  rpc,
  ETH,
  ARB1_OUTBOX,
  MULTICALL3,
  encodeFunctionData,
  decodeFunctionResult,
  parseAbi,
  sleep,
  dataPath,
  readJson,
  writeJson,
  progress,
  say,
} from './lib.mjs';

const [inF, outF] = process.argv.slice(2);
if (!outF) throw new Error('usage: node spent.mjs <l2tol1 json> <out json>');

const abi = parseAbi([
  'function isSpent(uint256) view returns (bool)',
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
]);
const CHUNK = 400;

async function spentChunk(positions) {
  const calls = positions.map((p) => ({
    target: ARB1_OUTBOX,
    allowFailure: false,
    callData: encodeFunctionData({ abi, functionName: 'isSpent', args: [BigInt(p)] }),
  }));
  const data = encodeFunctionData({ abi, functionName: 'aggregate3', args: [calls] });
  const r = await rpc(ETH, 'eth_call', [{ to: MULTICALL3, data }, 'latest'], 8);
  return decodeFunctionResult({ abi, functionName: 'aggregate3', data: r }).map((x, k) => {
    if (!x.success) throw new Error('isSpent failed for position ' + positions[k]);
    return BigInt(x.returnData) === 1n;
  });
}

const logs = readJson(inF);
const positions = [...new Set(logs.map((x) => BigInt(x.topics[3]).toString()))];
const out = fs.existsSync(dataPath(outF)) ? readJson(outF) : {};
const todo = positions.filter((p) => out[p] === undefined);
say('positions', positions.length, 'todo', todo.length);
for (let i = 0; i < todo.length; i += CHUNK) {
  const chunk = todo.slice(i, i + CHUNK);
  (await spentChunk(chunk)).forEach((spent, k) => (out[chunk[k]] = spent));
  progress(`${i + chunk.length}/${todo.length}`);
  writeJson(outF, out);
  await sleep(300);
}
const vals = Object.values(out);
say('done; spent', vals.filter(Boolean).length, 'unspent', vals.filter((v) => !v).length);
