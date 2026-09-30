// Step 9. Headline numbers as a small JSON (the "Mainnet opportunity" panel in web/ reads this file).
// Same definitions as report.mjs and flow.mjs, computed from the merged rows in one pass:
//   stranded        = token withdrawal, L2 block <= confirmed block, initiated >= 14 days before the snapshot,
//                     Outbox.isSpent == false (never claimed)
//   challengeWindow = initiated after the latest confirmed L2 block (still inside the ~6.4-day window)
// usage: node summary.mjs [rows json = rows_all.json] [confirmed L2 block = confirmed.json] [--web]
//   --web also writes web/src/data/mainnet-snapshot.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasData, readJson, writeJson, say } from './lib.mjs';

/** First Nitro block on Arbitrum One: earlier (Classic) withdrawals use a different Outbox. */
const NITRO_FIRST_BLOCK = 22207818;
const WEB_OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src/data/mainnet-snapshot.json');
const SIM_FILES = ['sim_tok_365.json', 'sim_old_big.json'];

const args = process.argv.slice(2).filter((a) => a !== '--web');
const toWeb = process.argv.includes('--web');
const rowsFile = args[0] || 'rows_all.json';
const confirmedBlock = Number(args[1] || readJson('confirmed.json').l2Block);

const usdOf = (rows) => Math.round(rows.reduce((s, r) => s + (r.usd || 0), 0));
const ethOf = (msgs) => msgs.reduce((s, m) => s + Number(BigInt(m.callvalue)) / 1e18, 0);
const isWithdrawEth = (m) => m.callvalue !== '0' && m.dataLen === 0;
const round2 = (n) => Math.round(n * 100) / 100;

function ethStats(msgs, ethUsd) {
  const eth = ethOf(msgs);
  return { count: msgs.length, eth: round2(eth), usd: Math.round(eth * ethUsd) };
}

function largest(rows) {
  const r = [...rows].sort((a, b) => (b.usd || 0) - (a.usd || 0))[0];
  if (!r) return null;
  return { symbol: r.symbol, amount: round2(r.human), usd: Math.round(r.usd), tx: r.tx, initiatedAt: new Date(r.ts * 1000).toISOString() };
}

/** eth_call results of Outbox.executeTransaction for stranded exits (simall.mjs), if present. */
function simulation(stranded) {
  const results = Object.assign({}, ...SIM_FILES.filter(hasData).map(readJson));
  const checked = stranded.filter((r) => results[r.position] !== undefined);
  return { simulated: checked.length, ok: checked.filter((r) => results[r.position] === 'OK').length, files: SIM_FILES.filter(hasData) };
}

function strandedSection(rows, msgRows, blocks, ethUsd) {
  const window = (from) => (r) => r.block >= from && r.block <= blocks.d14.block && r.block <= confirmedBlock;
  const all = rows.filter(window(NITRO_FIRST_BLOCK)).filter((r) => !r.spent);
  const year = all.filter((r) => r.block >= blocks.d365.block);
  const ethAll = msgRows.filter(window(NITRO_FIRST_BLOCK)).filter((m) => isWithdrawEth(m) && !m.spent);
  return {
    minAgeDays: 14,
    allTime: { count: all.length, usd: usdOf(all), unpricedCount: all.filter((r) => r.usd == null).length, fromBlock: NITRO_FIRST_BLOCK, toBlock: blocks.d14.block },
    last12Months: { count: year.length, usd: usdOf(year), fromBlock: blocks.d365.block, toBlock: blocks.d14.block },
    eth: {
      allTime: ethStats(ethAll, ethUsd),
      last12Months: ethStats(ethAll.filter((m) => m.block >= blocks.d365.block), ethUsd),
    },
    largestAllTime: largest(all),
    largestLast12Months: largest(year),
    executeTransactionSimulation: simulation(all),
  };
}

function flowSection(rows, msgRows, from, to, ethUsd) {
  const tokens = rows.filter((r) => r.block >= from && r.block <= to);
  const eth = msgRows.filter((m) => m.block >= from && m.block <= to && isWithdrawEth(m));
  return { fromBlock: from, toBlock: to, tokenCount: tokens.length, tokenUsd: usdOf(tokens), ...prefixed('eth', ethStats(eth, ethUsd)) };
}

function prefixed(prefix, stats) {
  return { [prefix + 'Count']: stats.count, [prefix]: stats.eth, [prefix + 'Usd']: stats.usd };
}

const blocks = readJson('blocks.json');
const tokens = readJson('tokens.json');
const { rows, msgRows } = readJson(rowsFile);
const ethUsd = tokens.ETH.price;
const snapshot = {
  generatedBy: 'research/stranded/summary.mjs',
  snapshot: {
    date: blocks.headIso.slice(0, 10),
    arbHeadBlock: blocks.head,
    arbHeadTime: blocks.headIso,
    confirmedL2Block: confirmedBlock,
    prices: 'DefiLlama current prices at snapshot time',
    ethUsd: round2(ethUsd),
  },
  stranded: strandedSection(rows, msgRows, blocks, ethUsd),
  flow30d: flowSection(rows, msgRows, blocks.d30.block, blocks.head, ethUsd),
  challengeWindow: flowSection(rows, msgRows, confirmedBlock + 1, blocks.head, ethUsd),
};
writeJson('mainnet-snapshot.json', snapshot, true);
if (toWeb) {
  fs.mkdirSync(path.dirname(WEB_OUT), { recursive: true });
  fs.writeFileSync(WEB_OUT, JSON.stringify(snapshot, null, 2) + '\n');
}
say(JSON.stringify(snapshot, null, 2));
