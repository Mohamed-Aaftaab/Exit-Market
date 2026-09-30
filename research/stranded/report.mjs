// Step 8. Human-readable report of confirmed-but-never-claimed withdrawals initiated in [from, to].
// "Confirmed" = L2 block <= <confirmed L2 block> (see confirmed.mjs); "unclaimed" = Outbox.isSpent == false.
// Writes unclaimed_<from>_<to>.json (token rows) and eth_unclaimed_<from>_<to>.json (withdrawEth messages).
// usage: node report.mjs <rows json> <from block> <to block> <confirmed L2 block> <now unix ts>
import { readJson, writeJson, say, fmt } from './lib.mjs';

const [rowsF, fromBlk, toBlk, confirmedBlk, nowTs] = process.argv.slice(2);
if (!nowTs) throw new Error('usage: node report.mjs <rows json> <from> <to> <confirmed L2 block> <now unix ts>');
const F = +fromBlk;
const T = +toBlk;
const C = +confirmedBlk;
const NOW = +nowTs;
const DAY = 86400;

const MAJORS = {
  WETH: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7',
  ARB: '0xb50721bcf8d664c30412cfbc6cf7a15145234ad1',
  WBTC: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
  DAI: '0x6b175474e89094c44da98b954eedeac495271d0f',
  wstETH: '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0',
};

const sumUsd = (rows) => rows.reduce((s, r) => s + (r.usd || 0), 0);
const sumEth = (msgs) => msgs.reduce((s, m) => s + Number(BigInt(m.callvalue)) / 1e18, 0);
const ageDays = (ts) => (NOW - ts) / DAY;
const isWithdrawEth = (m) => m.callvalue !== '0' && m.dataLen === 0;

function byToken(un, tokens) {
  const agg = {};
  for (const r of un) {
    const a = agg[r.l1Token] || { sym: r.symbol, n: 0, human: 0, usd: 0, price: tokens[r.l1Token]?.price, conf: tokens[r.l1Token]?.conf };
    agg[r.l1Token] = { ...a, n: a.n + 1, human: a.human + (r.human || 0), usd: a.usd + (r.usd || 0) };
  }
  return agg;
}

function reportTokens(un, agg) {
  const list = Object.entries(agg).sort((a, b) => b[1].usd - a[1].usd);
  say('distinct tokens unclaimed', list.length, 'priced unclaimed rows', un.filter((r) => r.usd != null).length, 'unpriced rows', un.filter((r) => r.usd == null).length);
  say('TOTAL unclaimed USD (all priced tokens, DefiLlama):', fmt(sumUsd(un)));
  for (const [k, v] of list.slice(0, 25)) say(`  ${v.sym} ${k} n=${v.n} amt=${fmt(v.human)} price=${v.price} conf=${v.conf} usd=${fmt(v.usd)}`);
}

function reportMajors(inW, agg, tokens) {
  say('MAJORS:');
  let total = 0;
  for (const [s, a] of Object.entries(MAJORS)) {
    const v = agg[a] || { n: 0, human: 0, usd: 0 };
    total += v.usd;
    say(`  ${s}: unclaimed n=${v.n} amt=${fmt(v.human)} usd=${fmt(v.usd)} price=${tokens[a]?.price}  | all withdrawals in window n=${inW.filter((r) => r.l1Token === a).length}`);
  }
  say('majors USD sum', fmt(total));
}

function reportTopAndAges(un, conf) {
  say('TOP unclaimed by USD:');
  for (const r of [...un].sort((a, b) => (b.usd || 0) - (a.usd || 0)).slice(0, 15)) {
    say(`  ${r.symbol} ${fmt(r.human)} usd=${fmt(r.usd)} age=${ageDays(r.ts).toFixed(1)}d block=${r.block} pos=${r.position} gw=${r.gateway.slice(0, 8)} tx=${r.tx}`);
  }
  for (const [lo, hi] of [[14, 30], [30, 90], [90, 180], [180, 366]]) {
    const inAge = (r) => ageDays(r.ts) >= lo && ageDays(r.ts) < hi;
    const s = un.filter(inAge);
    say(`age ${lo}-${hi}d: unclaimed ${s.length}/${conf.filter(inAge).length} usd=${fmt(sumUsd(s))}`);
  }
  const g = {};
  for (const r of un) g[r.gateway] = [(g[r.gateway]?.[0] || 0) + 1, (g[r.gateway]?.[1] || 0) + (r.usd || 0)];
  say('by gateway', g);
}

function reportEth(msgRows, rows, ethPx) {
  const mW = msgRows.filter((m) => m.block >= F && m.block <= T && m.block <= C);
  const ethW = mW.filter(isWithdrawEth);
  const ethUn = ethW.filter((m) => !m.spent);
  say(`ETH withdrawEth in window (confirmed): ${ethW.length}, unclaimed ${ethUn.length}, unclaimed ETH ${fmt(sumEth(ethUn))} (~$${fmt(sumEth(ethUn) * ethPx)} @ ${ethPx})`);
  for (const m of [...ethUn].sort((a, b) => Number(BigInt(b.callvalue) - BigInt(a.callvalue))).slice(0, 8)) {
    say(`  ETH ${fmt(Number(BigInt(m.callvalue)) / 1e18)} age=${ageDays(m.ts).toFixed(1)}d pos=${m.position} tx=${m.tx}`);
  }
  const tokenMsgs = new Set(rows.map((r) => r.tx + ':' + r.position));
  const other = mW.filter((m) => !isWithdrawEth(m) && !tokenMsgs.has(m.tx + ':' + m.position));
  const otherUn = other.filter((m) => !m.spent);
  say(`other non-token, non-withdrawEth messages confirmed in window: ${other.length}, unspent ${otherUn.length}, unspent w/ callvalue>0: ${otherUn.filter((m) => m.callvalue !== '0').length} ETH ${fmt(sumEth(otherUn))}`);
  return ethUn;
}

const { rows, msgRows } = readJson(rowsF);
const tokens = readJson('tokens.json');
const inW = rows.filter((r) => r.block >= F && r.block <= T);
const conf = inW.filter((r) => r.block <= C);
const un = conf.filter((r) => !r.spent);
say(`window blocks ${F}-${T}: withdrawals ${inW.length}, confirmed ${conf.length}, UNCLAIMED ${un.length} (${((100 * un.length) / conf.length).toFixed(1)}%)`);
const agg = byToken(un, tokens);
reportTokens(un, agg);
reportMajors(inW, agg, tokens);
reportTopAndAges(un, conf);
const ethUn = reportEth(msgRows, rows, tokens.ETH.price);
writeJson(`unclaimed_${F}_${T}.json`, un, true);
writeJson(`eth_unclaimed_${F}_${T}.json`, ethUn, true);
