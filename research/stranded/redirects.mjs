// Reproduces "0 WithdrawRedirected events on the Arbitrum One and Nova L1 gateways".
//
// Gateways: the Ethereum-side standard, custom and WETH gateways of Arbitrum One (42161) and Nova (42170), exactly as
// listed in @arbitrum/sdk's network config (getArbitrumNetwork(id).tokenBridge). Events: WithdrawRedirected and, as a
// coverage check, WithdrawalFinalized, both taken from the SDK's L1ArbitrumExtendedGateway ABI. Logs come from
// Blockscout's public Ethereum API (Etherscan-compatible getLogs, block 0 to latest), so this one script does use an
// indexer. It also lists every contract on Ethereum that ever emitted WithdrawRedirected and the chain behind it
// (gateway.inbox -> bridge -> rollup -> chainId over JSON-RPC), so the scope of the "0" is explicit.
//
// Usage: node redirects.mjs   (BLOCKSCOUT_API and ETH_RPC override the endpoints; writes data/redirects.json)
import { getArbitrumNetwork } from '@arbitrum/sdk';
import { L1ArbitrumExtendedGateway__factory } from '@arbitrum/sdk/dist/lib/abi/factories/L1ArbitrumExtendedGateway__factory.js';
import { ETH, createPublicClient, http, parseAbi, say, toEventSelector, writeJson } from './lib.mjs';

const API = process.env.BLOCKSCOUT_API || 'https://eth.blockscout.com/api';
const MAX_RESULTS = 1000; // Blockscout returns at most this many logs per getLogs call

const topicOf = (name) => {
  const ev = L1ArbitrumExtendedGateway__factory.abi.find((x) => x.type === 'event' && x.name === name);
  return toEventSelector(`${ev.name}(${ev.inputs.map((i) => i.type).join(',')})`);
};
const REDIRECTED = topicOf('WithdrawRedirected');
const FINALIZED = topicOf('WithdrawalFinalized');

const RETRIES = 6;
/** Space requests out: the free public API allows only short bursts. */
const PACE_MS = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getLogs(params) {
  const query = new URLSearchParams({ module: 'logs', action: 'getLogs', fromBlock: '0', toBlock: 'latest', ...params });
  let res;
  // The public API rate-limits bursts (HTTP 429): back off and retry rather than report a partial result.
  for (let attempt = 0; ; attempt++) {
    await sleep(PACE_MS);
    res = await fetch(`${API}?${query}`);
    if (res.status !== 429 || attempt === RETRIES) break;
    await sleep(2000 * 2 ** attempt);
  }
  if (!res.ok) throw new Error(`Blockscout HTTP ${res.status} for ${query}`);
  const body = await res.json();
  if (body.status === '1') return body.result;
  if (body.message === 'No logs found') return [];
  throw new Error(`Blockscout error "${body.message}" for ${query}`);
}

const client = createPublicClient({ transport: http(ETH) });
const bridgeAbi = parseAbi([
  'function inbox() view returns (address)',
  'function bridge() view returns (address)',
  'function rollup() view returns (address)',
  'function chainId() view returns (uint256)',
]);
const read = (address, functionName) => client.readContract({ address, abi: bridgeAbi, functionName });

/** Child chain id behind a parent-chain gateway, or the reason it could not be resolved. */
async function childChainOf(gateway) {
  try {
    const rollup = await read(await read(await read(gateway, 'inbox'), 'bridge'), 'rollup');
    return Number(await read(rollup, 'chainId'));
  } catch (e) {
    return `unresolved: ${e.shortMessage ?? e.message}`;
  }
}

const gateways = [];
for (const id of [42161, 42170]) {
  const { name, tokenBridge: tb } = getArbitrumNetwork(id);
  for (const [kind, address] of [['standard', tb.parentErc20Gateway], ['custom', tb.parentCustomGateway], ['WETH', tb.parentWethGateway]]) {
    const redirected = (await getLogs({ address, topic0: REDIRECTED })).length;
    // A gateway the indexer has never seen finalize a withdrawal would make "0 redirects" meaningless.
    const finalized = await getLogs({ address, topic0: FINALIZED });
    const indexed = finalized.length > 0 ? (finalized.length >= MAX_RESULTS ? `${MAX_RESULTS}+` : finalized.length) : 0;
    gateways.push({ chain: name, kind, address, withdrawRedirected: redirected, withdrawalFinalizedSeen: indexed });
    say('%s %s gateway %s: %d WithdrawRedirected (%s WithdrawalFinalized indexed)', name, kind, address, redirected, indexed);
  }
}

const all = await getLogs({ topic0: REDIRECTED });
if (all.length >= MAX_RESULTS) say('warning: the Ethereum-wide query hit the %d-result cap; the emitter list is partial', MAX_RESULTS);
const emitters = [];
for (const address of [...new Set(all.map((l) => l.address.toLowerCase()))]) {
  const logs = all.filter((l) => l.address.toLowerCase() === address);
  const blocks = logs.map((l) => Number(l.blockNumber));
  emitters.push({ address, events: logs.length, childChainId: await childChainOf(address), firstBlock: Math.min(...blocks), lastBlock: Math.max(...blocks) });
}

const total = gateways.reduce((sum, g) => sum + g.withdrawRedirected, 0);
say('\nArbitrum One + Nova L1 gateways: %d WithdrawRedirected events in total.', total);
say('Every WithdrawRedirected emitter on Ethereum (%d events):', all.length);
for (const e of emitters) say('  %s  %d events, child chain %s, blocks %d-%d', e.address, e.events, e.childChainId, e.firstBlock, e.lastBlock);

writeJson('redirects.json', { checkedAt: new Date().toISOString(), source: API, topic0: REDIRECTED, gateways, total, emittersOnEthereum: emitters }, true);
