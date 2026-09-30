// Step 10. Cross-checks: (a) every withdrawal's L2->L1 message targets the emitter's L1 counterpart gateway;
// (b) the Multicall3 isSpent flags agree with direct eth_calls on an independent RPC (top 20 unclaimed + spent sample).
// usage: node validate.mjs <rows json> <unclaimed json>
import { rpc, ARB1_OUTBOX, encodeFunctionData, parseAbi, sleep, readJson, say } from './lib.mjs';

/** L2 gateway -> L1 counterpart, from emitters.mjs (counterpartGateway() + L1 router cross-check). */
const COUNTERPART = {
  '0x09e9222e96e7b4ae2a407b98d48e330053351eee': '0xa3a7b6f88361f48403514059f1f16c8e78d60eec',
  '0x096760f208390250649e3e8763348e783aef5562': '0xcee284f754e854890e311e3280b767f80797180d',
  '0x6c411ad3e74de3e7bd422b94a27770f5b86c623b': '0xd92023e9d9911199a6711321d1277285e6d4e2db',
  '0x07d4692291b9e30e326fd31706f686f83f331b82': '0x0f25c1dc2a9922304f2eac71dca9b07e310e8e5a',
  '0x6d2457a4ad276000a615295f7a80f79e48ccd318': '0x6142f1c8bbf02e6a6bd074e8d564c9a5420a0676',
  '0x467194771dae2967aef3ecbedd3bf9a310c76c65': '0xd3b5b60020504bc3489d6949d545893982ba3011',
  '0xcad7828a19b363a2b44717afb1786b5196974d8e': '0xbbce8aa77782f13d4202a230d978f361b011db27',
  '0x13f7f24ca959359a4d710d32c715d4bce273c793': '0x84b9700e28b23f873b82c1beb23d86c091b6079e',
  '0xd9f64ee3dd6f552c1bcfc8862dbd130bc6697a66': '0x6e808d5f92799b6a1e8142d5facae510559a0f76',
  '0x65e1a5e8946e7e87d9774f5288f41c30a99fd302': '0x01cdc91b0a9ba741903aa3699bf4ce31d6c5cc06',
};
const INDEPENDENT_RPCS = ['https://eth.drpc.org', 'https://1rpc.io/eth', 'https://eth.llamarpc.com', 'https://cloudflare-eth.com'];
const abi = parseAbi(['function isSpent(uint256) view returns (bool)']);

async function pickRpc() {
  for (const u of INDEPENDENT_RPCS) {
    try {
      await rpc(u, 'eth_blockNumber', [], 1);
      return u;
    } catch (e) {
      say('rpc fail', u, e.message.slice(0, 80));
    }
  }
  throw new Error('no independent Ethereum RPC reachable');
}

async function recheckSpent(url, sample) {
  let mismatches = 0;
  for (const r of sample) {
    const data = encodeFunctionData({ abi, functionName: 'isSpent', args: [BigInt(r.position)] });
    const direct = BigInt(await rpc(url, 'eth_call', [{ to: ARB1_OUTBOX, data }, 'latest'], 4)) === 1n;
    if (direct !== r.spent) {
      mismatches++;
      say('MISMATCH', r.position, r.tx, 'multicall', r.spent, 'direct', direct);
    }
    await sleep(250);
  }
  return mismatches;
}

const { rows } = readJson(process.argv[2]);
const bad = rows.filter((r) => COUNTERPART[r.gateway] !== r.dest);
say('rows', rows.length, 'dest != L1 counterpart:', bad.length, bad.slice(0, 3).map((r) => [r.gateway, r.dest, r.tx]));
const url = await pickRpc();
say('using', url);
const top = [...readJson(process.argv[3])].sort((a, b) => (b.usd || 0) - (a.usd || 0)).slice(0, 20);
const spentSample = rows.filter((r) => r.spent).filter((_, i) => i % 500 === 0).slice(0, 15);
const mismatches = await recheckSpent(url, [...top, ...spentSample]);
say('checked', top.length + spentSample.length, 'mismatches', mismatches);
