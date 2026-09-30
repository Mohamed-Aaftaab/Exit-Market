// Outbox claim helpers shared by simulate.mjs and simall.mjs.
import {
  rpc,
  ARB,
  ETH,
  ARB1_OUTBOX,
  NODE_INTERFACE,
  L2_TO_L1_DATA,
  encodeFunctionData,
  decodeFunctionResult,
  parseAbi,
  decodeAbiParameters,
  hex,
} from './lib.mjs';

export const outboxAbi = parseAbi([
  'function constructOutboxProof(uint64 size, uint64 leaf) view returns (bytes32 send, bytes32 root, bytes32[] proof)',
  'function roots(bytes32) view returns (bytes32)',
  'function executeTransaction(bytes32[] proof, uint256 index, address l2Sender, address to, uint256 l2Block, uint256 l1Block, uint256 l2Timestamp, uint256 value, bytes data)',
]);

/** Send-tree size and root committed by a (confirmed) Arbitrum One block. */
export async function sendTreeAt(l2Block) {
  const blk = await rpc(ARB, 'eth_getBlockByNumber', [hex(+l2Block), false]);
  return { size: BigInt(blk.sendCount), sendRoot: blk.sendRoot };
}

/** Outbox.executeTransaction calldata for L2ToL1Tx log `m`, proven against a send tree of `size` leaves. */
export async function executeCalldata(m, position, size) {
  const [caller, arbBlockNum, ethBlockNum, timestamp, callvalue, data] = decodeAbiParameters(L2_TO_L1_DATA, m.data);
  const call = encodeFunctionData({ abi: outboxAbi, functionName: 'constructOutboxProof', args: [size, position] });
  const pr = await rpc(ARB, 'eth_call', [{ to: NODE_INTERFACE, data: call }, 'latest']);
  const [, root, proof] = decodeFunctionResult({ abi: outboxAbi, functionName: 'constructOutboxProof', data: pr });
  const destination = '0x' + m.topics[1].slice(26);
  const args = [proof, position, caller, destination, arbBlockNum, ethBlockNum, timestamp, callvalue, data];
  return { root, calldata: encodeFunctionData({ abi: outboxAbi, functionName: 'executeTransaction', args }) };
}

/** eth_call the claim on Ethereum from 0x…dEaD: 'OK' or 'REVERT <rpc error>' (transport errors throw). */
export async function simulateClaim(calldata, tries = 3) {
  try {
    await rpc(ETH, 'eth_call', [{ from: '0x000000000000000000000000000000000000dEaD', to: ARB1_OUTBOX, data: calldata }, 'latest'], tries);
    return 'OK';
  } catch (e) {
    if (e.rpc) return 'REVERT ' + JSON.stringify(e.rpc).slice(0, 200);
    throw e;
  }
}

/** L2ToL1Tx logs keyed by "<tx>:<position>". */
export const messagesByKey = (logs) => new Map(logs.map((m) => [m.transactionHash + ':' + BigInt(m.topics[3]), m]));
