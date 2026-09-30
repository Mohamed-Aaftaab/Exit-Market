// Step 8b (was q3.mjs). Market-size context: withdrawal flow over the last 30 days and what is sitting in the
// challenge window right now (initiated after the latest confirmed L2 block).
// usage: node flow.mjs [rows json = rows_365.json] [confirmed L2 block = confirmed.json]
import { readJson, say } from './lib.mjs';

const blocks = readJson('blocks.json');
const tokens = readJson('tokens.json');
const { rows, msgRows } = readJson(process.argv[2] || 'rows_365.json');
const F = blocks.d30.block;
const H = blocks.head;
const C = Number(process.argv[3] || readJson('confirmed.json').l2Block);
const PX = tokens.ETH.price;

const usd0 = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const median = (a) => (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2);
const isWithdrawEth = (m) => m.callvalue !== '0' && m.dataLen === 0;
const ethOf = (m) => Number(BigInt(m.callvalue)) / 1e18;

function tokenFlow() {
  const w = rows.filter((r) => r.block >= F && r.block <= H);
  const priced = w.filter((r) => r.usd != null).map((r) => r.usd).sort((a, b) => a - b);
  const sum = priced.reduce((a, b) => a + b, 0);
  say(`30d token withdrawals: ${w.length}, priced ${priced.length}, USD total ${usd0(sum)}, mean ${usd0(sum / priced.length)}, median ${median(priced).toFixed(2)}, p90 ${priced[Math.floor(priced.length * 0.9)].toFixed(0)}, max ${usd0(priced[priced.length - 1])}`);
  const byTok = {};
  for (const r of w) byTok[r.symbol] = [(byTok[r.symbol]?.[0] || 0) + 1, (byTok[r.symbol]?.[1] || 0) + (r.usd || 0)];
  const top = Object.entries(byTok).sort((a, b) => b[1][1] - a[1][1]).slice(0, 12);
  say('top tokens 30d by USD', top.map(([s, [n, u]]) => `${s}:n=${n},$${usd0(u)}`).join(' | '));
  const largest = [...w].sort((a, b) => (b.usd || 0) - (a.usd || 0)).slice(0, 5);
  say('largest 30d:', largest.map((r) => `${r.symbol} $${usd0(r.usd)} ${r.tx}`).join('\n  '));
}

function ethFlow() {
  const ew = msgRows.filter((m) => m.block >= F && m.block <= H && isWithdrawEth(m));
  const ev = ew.map(ethOf).sort((a, b) => a - b);
  const es = ev.reduce((a, b) => a + b, 0);
  say(`30d ETH withdrawEth: ${ew.length}, ETH ${es.toFixed(2)} (~$${usd0(es * PX)}), mean ${(es / ev.length).toFixed(4)} ETH, median ${median(ev).toFixed(4)} ETH`);
  say('30d all L2ToL1Tx messages:', msgRows.filter((m) => m.block >= F && m.block <= H).length);
}

function pending() {
  const pend = rows.filter((r) => r.block > C);
  const pu = pend.reduce((a, r) => a + (r.usd || 0), 0);
  const pe = msgRows.filter((m) => m.block > C && isWithdrawEth(m));
  const pes = pe.reduce((a, m) => a + ethOf(m), 0);
  say(`pending (not yet confirmed, L2 block > ${C}) snapshot: tokens n=${pend.length} $${usd0(pu)}; ETH n=${pe.length} ${pes.toFixed(2)} ETH ($${usd0(pes * PX)})`);
  const y = rows.filter((r) => r.block >= blocks.d365.block);
  say(`365d token withdrawals n=${y.length}, priced $ ${usd0(y.reduce((a, r) => a + (r.usd || 0), 0))} (today's prices)`);
  const ye = msgRows.filter((m) => m.block >= blocks.d365.block && isWithdrawEth(m));
  say(`365d ETH withdrawEth n=${ye.length}, ${ye.reduce((a, m) => a + ethOf(m), 0).toFixed(1)} ETH`);
}

tokenFlow();
ethFlow();
pending();
