import { createPublicClient, http, parseAbiItem } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { buildExitProof } from "../lib/exitProof.ts";

const parent = createPublicClient({ chain: arbitrumSepolia, transport: http("https://sepolia-rollup.arbitrum.io/rpc") });
const child = createPublicClient({ transport: http("https://testnet-v2.xai-chain.net/rpc") });
const CHILD_GW = "0xD840761a09609394FaFA3404bEEAb312059AC558" as const;
const CHILD_CUSTOM_GW = "0xea1ce1CC75C948488515A3058E10aa82da40cE8F" as const;
const ev = parseAbiItem("event WithdrawalInitiated(address l1Token, address indexed _from, address indexed _to, uint256 indexed _l2ToL1Id, uint256 _exitNum, uint256 _amount)");
const logs = await child.getLogs({ address: [CHILD_GW, CHILD_CUSTOM_GW], event: ev, fromBlock: 0n, toBlock: "latest" });
console.log("gateway withdrawals ever on Xai testnet:", logs.length);
const last = logs.at(-1)!;
const w = await buildExitProof({ parent, child, rollup: "0xeedE9367Df91913ab149e828BDd6bE336df2c892", childGateway: last.address, withdrawalTx: last.transactionHash!, lookbackBlocks: 20_000n });
console.log(JSON.stringify(w, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1));

// --- replay ExitMarket's on-chain verification against the REAL Outbox + rollup ---
import { encodeFunctionData, encodeAbiParameters, keccak256, encodePacked, parseAbi } from "viem";
const OUTBOX = "0xc7491a559b416540427f9f112C5c98b1412c5d51" as const;
const PARENT_GW = last.address.toLowerCase() === CHILD_GW.toLowerCase() ? "0xCcB451C4Df22addCFe1447c58bC6b2f264Bb1256" : "0x04e14E04949D49ae9c551ca8Cc3192310Ce65D88";
const ob = parseAbi(["function calculateItemHash(address,address,uint256,uint256,uint256,uint256,bytes) pure returns (bytes32)","function calculateMerkleRoot(bytes32[],uint256,bytes32) pure returns (bytes32)","function isSpent(uint256) view returns (bool)","function roots(bytes32) view returns (bytes32)"]);
const fin = parseAbi(["function finalizeInboundTransfer(address,address,address,uint256,bytes)"]);
const p = w.proof;
const data = encodeFunctionData({ abi: fin, functionName: "finalizeInboundTransfer", args: [p.l1Token, p.from, w.initialDestination, p.amount, encodeAbiParameters([{type:"uint256"},{type:"bytes"}],[w.exitNum, p.extraData])] });
const item = await parent.readContract({ address: OUTBOX, abi: ob, functionName: "calculateItemHash", args: [last.address, PARENT_GW, p.l2Block, p.l1Block, p.l2Timestamp, 0n, data] });
const root = await parent.readContract({ address: OUTBOX, abi: ob, functionName: "calculateMerkleRoot", args: [p.merkleProof, p.index, item] });
const node = await parent.readContract({ address: "0xeedE9367Df91913ab149e828BDd6bE336df2c892", abi: [{type:"function",name:"getNode",stateMutability:"view",inputs:[{type:"uint64"}],outputs:[{type:"tuple",components:[{name:"stateHash",type:"bytes32"},{name:"challengeHash",type:"bytes32"},{name:"confirmData",type:"bytes32"},{name:"prevNum",type:"uint64"},{name:"deadlineBlock",type:"uint64"},{name:"noChildConfirmedBeforeBlock",type:"uint64"},{name:"stakerCount",type:"uint64"},{name:"childStakerCount",type:"uint64"},{name:"firstChildBlock",type:"uint64"},{name:"latestChildNumber",type:"uint64"},{name:"createdAtBlock",type:"uint64"},{name:"nodeHash",type:"bytes32"}]}]}], functionName: "getNode", args: [p.nodeNum] });
console.log("REAL OUTBOX root == sendRoot:", root === p.sendRoot);
console.log("node.confirmData == keccak(blockHash,sendRoot):", node.confirmData === keccak256(encodePacked(["bytes32","bytes32"],[p.blockHash,p.sendRoot])));
console.log("minimal path (index < 2**len):", p.index < 2n ** BigInt(p.merkleProof.length));
console.log("isSpent(index):", await parent.readContract({ address: OUTBOX, abi: ob, functionName: "isSpent", args: [p.index] }));
