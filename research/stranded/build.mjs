// Step 7. Join WithdrawalInitiated logs with their ArbSys L2ToL1Tx message (same tx + position), the Outbox
// spent flags and token prices into flat rows. msgRows keeps every L2->L1 message (needed for ETH withdrawals).
// usage: node build.mjs <wi json> <l2tol1 json> <spent json> <out rows json>
import { decodeAbiParameters, L2_TO_L1_DATA, readJson, writeJson, say } from './lib.mjs';

const [wiF, msgF, spF, outF] = process.argv.slice(2);
if (!outF) throw new Error('usage: node build.mjs <wi json> <l2tol1 json> <spent json> <out rows json>');

function toMsgRow(m, spent) {
  const [caller, , , timestamp, callvalue, data] = decodeAbiParameters(L2_TO_L1_DATA, m.data);
  const position = BigInt(m.topics[3]).toString();
  return {
    tx: m.transactionHash,
    block: parseInt(m.blockNumber, 16),
    position,
    destination: '0x' + m.topics[1].slice(26),
    caller: caller.toLowerCase(),
    ts: Number(timestamp),
    callvalue: callvalue.toString(),
    dataLen: (data.length - 2) / 2,
    spent: spent[position],
  };
}

function toTokenRow(x, msg, spent, tokens) {
  const [l1Token, , amount] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], x.data);
  const position = BigInt(x.topics[3]).toString();
  const t = tokens[l1Token.toLowerCase()] || {};
  const human = t.decimals != null ? Number(amount) / 10 ** t.decimals : null;
  return {
    tx: x.transactionHash,
    block: parseInt(x.blockNumber, 16),
    gateway: x.address.toLowerCase(),
    l1Token: l1Token.toLowerCase(),
    symbol: t.symbol,
    from: '0x' + x.topics[1].slice(26),
    to: '0x' + x.topics[2].slice(26),
    position,
    amount: amount.toString(),
    human,
    usd: human != null && t.price ? human * t.price : null,
    ts: msg ? msg.ts : null,
    dest: msg ? msg.destination : null,
    spent: msg ? msg.spent : spent[position],
    matched: !!msg,
  };
}

const spent = readJson(spF);
const tokens = readJson('tokens.json');
const msgRows = readJson(msgF).map((m) => toMsgRow(m, spent));
const msgByKey = new Map(msgRows.map((r) => [r.tx + ':' + r.position, r]));
const rows = readJson(wiF).map((x) => toTokenRow(x, msgByKey.get(x.transactionHash + ':' + BigInt(x.topics[3])), spent, tokens));

const unmatched = rows.filter((r) => !r.matched).length;
const callerMismatch = rows.filter((r) => r.matched && msgByKey.get(r.tx + ':' + r.position).caller !== r.gateway).length;
say('wi', rows.length, 'unmatched', unmatched, 'callerMismatch', callerMismatch);
writeJson(outF, { rows, msgRows });
