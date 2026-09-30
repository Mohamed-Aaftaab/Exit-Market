// Step 5. Token metadata (decimals, symbol via Multicall3 on Ethereum) and USD prices (DefiLlama, current).
// Resumable and merging: tokens already in data/tokens.json keep their metadata; prices are refreshed.
// usage: node tokens.mjs <wi json...>   -> data/tokens.json
import {
  rpc,
  ETH,
  MULTICALL3,
  encodeFunctionData,
  decodeFunctionResult,
  parseAbi,
  sleep,
  hexToString,
  hasData,
  readJson,
  writeJson,
  say,
} from './lib.mjs';

const abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
]);
const LLAMA = 'https://coins.llama.fi/prices/current/';

/** Decodes a Multicall3 (decimals, symbol) pair; bytes32 symbols (e.g. MKR) fall back to hexToString. */
function decodeMeta(d, s) {
  let decimals = null;
  let symbol = null;
  try {
    if (d.success && d.returnData.length >= 66) decimals = Number(BigInt(d.returnData.slice(0, 66)));
  } catch {}
  try {
    if (s.success) symbol = decodeFunctionResult({ abi, functionName: 'symbol', data: s.returnData });
  } catch {
    try {
      symbol = hexToString(s.returnData.slice(0, 66)).replace(/\0/g, '');
    } catch {}
  }
  return { decimals, symbol };
}

async function fetchMeta(tokens) {
  const meta = {};
  for (let i = 0; i < tokens.length; i += 100) {
    const chunk = tokens.slice(i, i + 100);
    const calls = chunk.flatMap((t) => [
      { target: t, allowFailure: true, callData: encodeFunctionData({ abi, functionName: 'decimals' }) },
      { target: t, allowFailure: true, callData: encodeFunctionData({ abi, functionName: 'symbol' }) },
    ]);
    const data = encodeFunctionData({ abi, functionName: 'aggregate3', args: [calls] });
    const res = decodeFunctionResult({ abi, functionName: 'aggregate3', data: await rpc(ETH, 'eth_call', [{ to: MULTICALL3, data }, 'latest']) });
    chunk.forEach((t, k) => (meta[t] = decodeMeta(res[2 * k], res[2 * k + 1])));
  }
  return meta;
}

async function fetchPrices(tokens) {
  const prices = {};
  for (let i = 0; i < tokens.length; i += 60) {
    const chunk = tokens.slice(i, i + 60);
    const url = LLAMA + chunk.map((t) => 'ethereum:' + t).join(',') + '?searchWidth=12h';
    const j = await (await fetch(url)).json();
    for (const t of chunk) {
      const c = j.coins['ethereum:' + t];
      if (c) prices[t] = { price: c.price, priceTs: c.timestamp, conf: c.confidence, llSymbol: c.symbol };
    }
    await sleep(500);
  }
  return prices;
}

const known = hasData('tokens.json') ? readJson('tokens.json') : {};
const seen = new Set();
for (const f of process.argv.slice(2)) for (const x of readJson(f)) seen.add(('0x' + x.data.slice(26, 66)).toLowerCase());
const todo = [...seen].filter((t) => !known[t]);
say('tokens', seen.size, 'todo', todo.length);

const merged = { ...known, ...(await fetchMeta(todo)) };
const erc20s = Object.keys(merged).filter((t) => t !== 'ETH');
const prices = await fetchPrices(erc20s);
const out = Object.fromEntries(erc20s.map((t) => [t, { ...merged[t], ...prices[t] }]));
const eth = (await (await fetch(LLAMA + 'coingecko:ethereum')).json()).coins['coingecko:ethereum'];
out.ETH = { decimals: 18, symbol: 'ETH', price: eth.price, priceTs: eth.timestamp };
writeJson('tokens.json', out, true);
say('priced', Object.values(out).filter((x) => x.price).length, 'of', Object.keys(out).length, 'ETH', out.ETH);
