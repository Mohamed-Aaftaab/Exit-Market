// Step 3. Classify who emitted WithdrawalInitiated: real gateways report a counterpart L1 gateway and a router,
// and the L1 router maps their tokens back to that counterpart. Output feeds the allowlist in validate.mjs.
// usage: node emitters.mjs [wi json = wi_365_all.json]
import {
  rpc,
  ARB,
  ETH,
  L1_GATEWAY_ROUTER,
  encodeFunctionData,
  decodeFunctionResult,
  parseAbi,
  readJson,
  say,
} from './lib.mjs';

const abi = parseAbi([
  'function counterpartGateway() view returns (address)',
  'function router() view returns (address)',
  'function getGateway(address) view returns (address)',
  'function symbol() view returns (string)',
]);

async function call(url, to, functionName, args = []) {
  try {
    const r = await rpc(url, 'eth_call', [{ to, data: encodeFunctionData({ abi, functionName, args }) }, 'latest'], 3);
    return decodeFunctionResult({ abi, functionName, data: r });
  } catch (e) {
    return 'ERR ' + e.message.slice(0, 80);
  }
}

const logs = readJson(process.argv[2] || 'wi_365_all.json');
for (const emitter of [...new Set(logs.map((x) => x.address))]) {
  const sample = logs.filter((x) => x.address === emitter);
  const l1Tokens = [...new Set(sample.map((x) => '0x' + x.data.slice(26, 66)))];
  const counterpart = await call(ARB, emitter, 'counterpartGateway');
  const router = await call(ARB, emitter, 'router');
  const checks = [];
  for (const t of l1Tokens.slice(0, 3)) {
    const gw = await call(ETH, L1_GATEWAY_ROUTER, 'getGateway', [t]);
    checks.push(`${t}(${await call(ETH, t, 'symbol')}) L1router->${gw}`);
  }
  say(emitter, 'n', sample.length, 'distinct l1Tokens', l1Tokens.length, 'counterpart', counterpart, 'router', router);
  say('    ' + checks.join('\n    '));
}
