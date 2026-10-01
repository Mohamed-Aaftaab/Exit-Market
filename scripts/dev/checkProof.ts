/**
 * Replays ExitMarket's on-chain checks for the newest Xai Testnet gateway withdrawal against the REAL Outbox and
 * rollup: item hash, Merkle root, node commitment, minimal path and spent bit. Usage: node scripts/dev/checkProof.ts
 */
import { createPublicClient, encodeAbiParameters, encodeFunctionData, encodePacked, http, keccak256, parseAbi, parseAbiItem } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { buildExitProof } from "../lib/exitProof.ts";
import { exitItemHash } from "../lib/hookData.ts";
import { ARBITRUM_SEPOLIA, XAI_TESTNET, xaiTestnet } from "../lib/networks.ts";

const { tokenBridge, ethBridge } = XAI_TESTNET;
const parent = createPublicClient({ chain: arbitrumSepolia, transport: http(ARBITRUM_SEPOLIA.rpcUrl) });
const child = createPublicClient({ chain: xaiTestnet, transport: http(XAI_TESTNET.rpcUrl) });
const withdrawalInitiated = parseAbiItem(
  "event WithdrawalInitiated(address l1Token, address indexed _from, address indexed _to, uint256 indexed _l2ToL1Id, uint256 _exitNum, uint256 _amount)",
);
const outboxAbi = parseAbi([
  "function calculateItemHash(address,address,uint256,uint256,uint256,uint256,bytes) pure returns (bytes32)",
  "function calculateMerkleRoot(bytes32[],uint256,bytes32) pure returns (bytes32)",
  "function isSpent(uint256) view returns (bool)",
]);
const rollupAbi = parseAbi([
  "struct Node { bytes32 stateHash; bytes32 challengeHash; bytes32 confirmData; uint64 prevNum; uint64 deadlineBlock; uint64 noChildConfirmedBeforeBlock; uint64 stakerCount; uint64 childStakerCount; uint64 firstChildBlock; uint64 latestChildNumber; uint64 createdAtBlock; bytes32 nodeHash; }",
  "function getNode(uint64 nodeNum) view returns (Node)",
]);
const finalizeAbi = parseAbi(["function finalizeInboundTransfer(address,address,address,uint256,bytes)"]);

const logs = await child.getLogs({
  address: [tokenBridge.childErc20Gateway, tokenBridge.childCustomGateway],
  event: withdrawalInitiated,
  fromBlock: 0n,
  toBlock: "latest",
});
console.log("gateway withdrawals ever on Xai testnet:", logs.length);
const last = logs.at(-1);
if (!last) throw new Error("No gateway withdrawals on Xai Testnet");
const isErc20 = last.address.toLowerCase() === tokenBridge.childErc20Gateway.toLowerCase();
const childGateway = isErc20 ? tokenBridge.childErc20Gateway : tokenBridge.childCustomGateway;
const parentGateway = isErc20 ? tokenBridge.parentErc20Gateway : tokenBridge.parentCustomGateway;

const w = await buildExitProof({ parent, child, rollup: ethBridge.rollup, childGateway, withdrawalTx: last.transactionHash });
console.log(JSON.stringify(w, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1));

const p = w.proof;
const data = encodeFunctionData({
  abi: finalizeAbi,
  functionName: "finalizeInboundTransfer",
  args: [p.l1Token, p.from, w.initialDestination, p.amount, encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [w.exitNum, p.extraData])],
});
const item = await parent.readContract({
  address: ethBridge.outbox,
  abi: outboxAbi,
  functionName: "calculateItemHash",
  args: [childGateway, parentGateway, p.l2Block, p.l1Block, p.l2Timestamp, 0n, data],
});
const [root, node, spent] = await Promise.all([
  parent.readContract({ address: ethBridge.outbox, abi: outboxAbi, functionName: "calculateMerkleRoot", args: [p.merkleProof, p.index, item] }),
  parent.readContract({ address: ethBridge.rollup, abi: rollupAbi, functionName: "getNode", args: [p.nodeNum] }),
  parent.readContract({ address: ethBridge.outbox, abi: outboxAbi, functionName: "isSpent", args: [p.index] }),
]);
console.log("REAL OUTBOX root == sendRoot:", root === p.sendRoot);
console.log("node.confirmData == keccak(blockHash,sendRoot):", node.confirmData === keccak256(encodePacked(["bytes32", "bytes32"], [p.blockHash, p.sendRoot])));
console.log("minimal path (index < 2**len):", p.index < 2n ** BigInt(p.merkleProof.length));
console.log("isSpent(index):", spent);
console.log("client exitItemHash == real Outbox.calculateItemHash:", exitItemHash(w, childGateway, parentGateway) === item);