// Orbit L3 variant (Xai, ApeChain, …): same stranded-exit analysis for a chain settling to Arbitrum One.
// Inputs are logs collected from the L3 with `RPC=<l3 rpc> node collect.mjs … l2tol1` and `… wi`.
// usage: node l3.mjs <name> <l3 rpc> <outbox on Arb1> <msgs json> <wi json> <native price key> <child gws csv> <parent gws csv>
//   native price key = a DefiLlama coin key for the L3's gas token, e.g. "arbitrum:<its token address on Arbitrum One>"
import {
  rpc,
  ARB,
  MULTICALL3,
  TOPIC_SEND_ROOT_UPDATED,
  L2_TO_L1_DATA,
  encodeFunctionData,
  decodeFunctionResult,
  parseAbi,
  decodeAbiParameters,
  sleep,
  hex,
  num,
  fmt,
  readJson,
  writeJson,
  say,
} from './lib.mjs';

const [name, L3, OUTBOX, msgF, wiF, nativeKey, childGws, parentGws] = process.argv.slice(2);
if (!parentGws) throw new Error('usage: node l3.mjs <name> <l3 rpc> <outbox> <msgs json> <wi json> <native key> <child gws> <parent gws>');
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const MIN_AGE_DAYS = 14;
const abi = parseAbi([
  'function isSpent(uint256) view returns (bool)',
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

async function multicall(calls) {
  const data = encodeFunctionData({ abi, functionName: 'aggregate3', args: [calls] });
  return decodeFunctionResult({ abi, functionName: 'aggregate3', data: await rpc(ARB, 'eth_call', [{ to: MULTICALL3, data }, 'latest']) });
}

/** Latest confirmed L3 block, from the newest SendRootUpdated of the L3's Outbox on Arbitrum One. */
async function latestConfirmedL3() {
  const head = num(await rpc(ARB, 'eth_blockNumber', []));
  let logs = [];
  for (let back = 2_000_000; back <= 64_000_000 && logs.length === 0; back *= 2) {
    logs = await rpc(ARB, 'eth_getLogs', [{ address: OUTBOX, topics: [TOPIC_SEND_ROOT_UPDATED], fromBlock: hex(head - back), toBlock: hex(head) }]);
  }
  const last = logs[logs.length - 1];
  if (!last) throw new Error('no SendRootUpdated found for ' + OUTBOX);
  const cb = await rpc(L3, 'eth_getBlockByHash', [last.topics[2], false]);
  const arbT = num((await rpc(ARB, 'eth_getBlockByNumber', [last.blockNumber, false])).timestamp);
  say(`[${name}] latest confirmed L3 block ${num(cb.number)} (L3 time ${new Date(num(cb.timestamp) * 1000).toISOString()}), confirmed on Arb1 block ${num(last.blockNumber)} at ${new Date(arbT * 1000).toISOString()} tx ${last.transactionHash}; sendCount@confirmed=${num(cb.sendCount)}`);
  return num(cb.number);
}

async function spentFlags(positions) {
  const spent = {};
  for (let i = 0; i < positions.length; i += 400) {
    const chunk = positions.slice(i, i + 400);
    const res = await multicall(chunk.map((p) => ({ target: OUTBOX, allowFailure: false, callData: encodeFunctionData({ abi, functionName: 'isSpent', args: [p] }) })));
    res.forEach((x, k) => (spent[chunk[k].toString()] = BigInt(x.returnData) === 1n));
    await sleep(200);
  }
  return spent;
}

function decodeMessages(msgs, spent) {
  return msgs.map((m) => {
    const [caller, , , ts, value, data] = decodeAbiParameters(L2_TO_L1_DATA, m.data);
    const pos = BigInt(m.topics[3]).toString();
    return { tx: m.transactionHash, block: num(m.blockNumber), pos, dest: '0x' + m.topics[1].slice(26), caller: caller.toLowerCase(), ts: Number(ts), value, dataLen: (data.length - 2) / 2, spent: spent[pos] };
  });
}

/** Withdrawals whose message was sent by a known child gateway to its known parent gateway. */
function validWithdrawals(wi, byKey) {
  const cg = childGws.toLowerCase().split(',');
  const pg = parentGws.toLowerCase().split(',');
  const emitters = {};
  for (const x of wi) emitters[x.address] = (emitters[x.address] || 0) + 1;
  say(`[${name}] WI emitters`, emitters, 'known child gateways', cg);
  const all = wi.map((x) => {
    const [l1Token, , amount] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], x.data);
    return { tx: x.transactionHash, gw: x.address.toLowerCase(), token: l1Token.toLowerCase(), amount, m: byKey.get(x.transactionHash + ':' + BigInt(x.topics[3])) };
  });
  const valid = all.filter((w) => w.m && w.m.caller === w.gw && cg.includes(w.gw) && pg.includes(w.m.dest));
  say(`[${name}] WI valid (matched msg, caller=known child gw, dest=known parent gw): ${valid.length}/${all.length}`);
  return valid;
}

async function tokenMeta(toks) {
  const meta = {};
  for (let i = 0; i < toks.length; i += 100) {
    const chunk = toks.slice(i, i + 100);
    const res = await multicall(chunk.flatMap((a) => [
      { target: a, allowFailure: true, callData: encodeFunctionData({ abi, functionName: 'decimals' }) },
      { target: a, allowFailure: true, callData: encodeFunctionData({ abi, functionName: 'symbol' }) },
    ]));
    chunk.forEach((a, k) => {
      let d = null;
      let s = null;
      try { d = Number(BigInt(res[2 * k].returnData.slice(0, 66))); } catch {}
      try { s = decodeFunctionResult({ abi, functionName: 'symbol', data: res[2 * k + 1].returnData }); } catch {}
      meta[a] = { d, s };
    });
  }
  return meta;
}

async function prices(keys) {
  const px = {};
  for (let i = 0; i < keys.length; i += 60) {
    const j = await (await fetch('https://coins.llama.fi/prices/current/' + keys.slice(i, i + 60).join(','))).json();
    Object.assign(px, j.coins);
  }
  return px;
}

function reportTokens(conf, meta, px) {
  const un = conf.filter((w) => !w.m.spent);
  const rows = un.map((w) => {
    const mm = meta[w.token] || {};
    const h = mm.d != null ? Number(w.amount) / 10 ** mm.d : null;
    const p = px['arbitrum:' + w.token];
    return { sym: mm.s, h, usd: h != null && p ? h * p.price : null, age: (NOW - w.m.ts) / DAY, tx: w.tx, pos: w.m.pos };
  });
  say(`[${name}] TOKENS all-time, initiated >=${MIN_AGE_DAYS}d ago: confirmed ${conf.length}, unclaimed ${un.length}, unclaimed USD(priced) $${fmt(rows.reduce((a, r) => a + (r.usd || 0), 0))}, unpriced rows ${rows.filter((r) => r.usd == null).length}`);
  const agg = {};
  for (const r of rows) agg[r.sym] = [(agg[r.sym]?.[0] || 0) + 1, (agg[r.sym]?.[1] || 0) + (r.h || 0), (agg[r.sym]?.[2] || 0) + (r.usd || 0)];
  say('   by token', Object.entries(agg).sort((a, b) => b[1][2] - a[1][2]).slice(0, 8).map(([s, [n, h, u]]) => `${s}: n=${n} amt=${fmt(h)} $${fmt(u)}`).join(' | '));
  for (const r of rows.sort((a, b) => (b.usd || 0) - (a.usd || 0)).slice(0, 4)) say(`   top: ${r.sym} ${fmt(r.h)} $${fmt(r.usd || 0)} age ${r.age.toFixed(0)}d pos ${r.pos} ${r.tx}`);
}

function reportNative(M, C, nat) {
  const nconf = M.filter((m) => m.value > 0n && m.dataLen === 0 && m.block <= C && NOW - m.ts >= MIN_AGE_DAYS * DAY);
  const nun = nconf.filter((m) => !m.spent);
  const nsum = nun.reduce((a, m) => a + Number(m.value) / 1e18, 0);
  say(`[${name}] NATIVE all-time, initiated >=${MIN_AGE_DAYS}d ago: confirmed ${nconf.length}, unclaimed ${nun.length}, amount ${fmt(nsum)} (~$${fmt(nsum * (nat ? nat.price : 0))})`);
  for (const m of [...nun].sort((a, b) => (b.value > a.value ? 1 : -1)).slice(0, 3)) say(`   top native: ${fmt(Number(m.value) / 1e18)} age ${((NOW - m.ts) / DAY).toFixed(0)}d pos ${m.pos} ${m.tx}`);
  return nconf;
}

const C = await latestConfirmedL3();
const headL3 = await rpc(L3, 'eth_getBlockByNumber', ['latest', false]);
const msgs = readJson(msgF);
const wi = readJson(wiF);
say(`[${name}] L2ToL1Tx collected ${msgs.length}, head sendCount ${num(headL3.sendCount)}; WithdrawalInitiated ${wi.length}`);
const spent = await spentFlags(msgs.map((m) => BigInt(m.topics[3])));
const M = decodeMessages(msgs, spent);
const valid = validWithdrawals(wi, new Map(M.map((m) => [m.tx + ':' + m.pos, m])));
const toks = [...new Set(valid.map((w) => w.token))];
const [meta, px] = await Promise.all([tokenMeta(toks), prices([...toks.map((a) => 'arbitrum:' + a), nativeKey])]);
say(`[${name}] native ${nativeKey} price ${px[nativeKey]?.price} (${px[nativeKey]?.symbol})`);
const conf = valid.filter((w) => w.m.block <= C && NOW - w.m.ts >= MIN_AGE_DAYS * DAY);
reportTokens(conf, meta, px);
const nconf = reportNative(M, C, px[nativeKey]);
const validSet = new Set(valid.map((w) => w.m));
const other = M.filter((m) => !(m.value > 0n && m.dataLen === 0) && !validSet.has(m) && m.block <= C);
say(`[${name}] other msgs (not token/native) confirmed ${other.length}, unspent ${other.filter((m) => !m.spent).length}`);
const recent = (ts) => NOW - ts < 365 * DAY;
say(`[${name}] last-365d subset: token confirmed ${conf.filter((w) => recent(w.m.ts)).length} unclaimed ${conf.filter((w) => recent(w.m.ts) && !w.m.spent).length}; native confirmed ${nconf.filter((m) => recent(m.ts)).length} unclaimed ${nconf.filter((m) => recent(m.ts) && !m.spent).length}`);
writeJson(name + '_result.json', { C, spent });
