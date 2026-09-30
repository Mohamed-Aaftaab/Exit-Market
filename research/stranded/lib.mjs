// Shared helpers for the stranded-exits research scripts.
// Every script reads and writes its data files in DATA_DIR (default: research/stranded/data, gitignored).
// Override with STRANDED_DATA=/some/dir to run against another dataset.
import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import { fileURLToPath } from 'node:url';
import { keccak256, toHex } from 'viem';

export * from 'viem';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(process.env.STRANDED_DATA || path.join(HERE, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

/** Absolute path of a data file; absolute inputs are returned unchanged. */
export const dataPath = (name) => path.resolve(DATA_DIR, name);
export const hasData = (name) => fs.existsSync(dataPath(name));
export const readJson = (name) => JSON.parse(fs.readFileSync(dataPath(name), 'utf8'));
export const writeJson = (name, value, pretty = false) =>
  fs.writeFileSync(dataPath(name), JSON.stringify(value, null, pretty ? 1 : undefined));

/** CLI output (stdout); progress goes to stderr via `progress`. */
export const say = (...args) => process.stdout.write(format(...args) + '\n');
export const progress = (...args) => process.stderr.write(format(...args) + '\n');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Public endpoints used for the 2026-09-29 snapshot; override with ARB_RPC / ETH_RPC.
export const ARB = process.env.ARB_RPC || 'https://arb1.arbitrum.io/rpc';
export const ETH = process.env.ETH_RPC || 'https://ethereum-rpc.publicnode.com';

// Arbitrum One core contracts (Ethereum side) and precompiles.
export const ARB1_OUTBOX = '0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840';
export const L1_GATEWAY_ROUTER = '0x72Ce9c846789fdB6fC1f34aC4AD25Dd9ef7031ef';
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const ARB_SYS = '0x0000000000000000000000000000000000000064';
export const NODE_INTERFACE = '0x00000000000000000000000000000000000000C8';

export const TOPIC_WI = keccak256(toHex('WithdrawalInitiated(address,address,address,uint256,uint256,uint256)'));
export const TOPIC_L2_TO_L1_TX = keccak256(
  toHex('L2ToL1Tx(address,address,uint256,uint256,uint256,uint256,uint256,uint256,bytes)'),
);
export const TOPIC_SEND_ROOT_UPDATED = keccak256(toHex('SendRootUpdated(bytes32,bytes32)'));

/** ABI types of the non-indexed L2ToL1Tx fields (caller, arbBlockNum, ethBlockNum, timestamp, callvalue, data). */
export const L2_TO_L1_DATA = [
  { type: 'address' },
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'bytes' },
];

let idc = 1;

/** One JSON-RPC call with retry on transport errors / 429 / 5xx. RPC-level errors throw immediately (err.rpc set). */
export async function rpc(url, method, params, tries = 8) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const body = JSON.stringify({ jsonrpc: '2.0', id: idc++, method, params });
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      const txt = await res.text();
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
        await sleep(1000 * (i + 1));
        continue;
      }
      const j = JSON.parse(txt);
      if (j.error) {
        const e = new Error(`RPC error ${JSON.stringify(j.error).slice(0, 300)}`);
        e.rpc = j.error;
        throw e;
      }
      return j.result;
    } catch (e) {
      if (e.rpc) throw e;
      lastErr = e;
      await sleep(1000 * (i + 1));
    }
  }
  throw lastErr;
}

/** JSON-RPC batch ([{method, params}]) with retry; any item error retries the whole batch. */
export async function rpcBatch(url, calls, tries = 8) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const body = JSON.stringify(calls.map((c, k) => ({ jsonrpc: '2.0', id: k, method: c.method, params: c.params })));
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      const txt = await res.text();
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
      const j = JSON.parse(txt);
      if (!Array.isArray(j)) throw new Error('non-array batch: ' + txt.slice(0, 300));
      const bad = j.find((r) => r.error);
      if (bad) throw new Error('batch item error ' + JSON.stringify(bad.error));
      const out = new Array(calls.length);
      for (const r of j) out[r.id] = r.result;
      return out;
    } catch (e) {
      lastErr = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

/** Block number <-> hex helpers. */
export const hex = (n) => '0x' + n.toString(16);
export const num = (h) => parseInt(h, 16);

/** Formats a number for reports (en-US, 2 decimals max). */
export const fmt = (n) => (n == null ? 'n/a' : n.toLocaleString('en-US', { maximumFractionDigits: 2 }));
