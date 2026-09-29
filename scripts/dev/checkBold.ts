/** Golden check: recompute live BOLD assertion hashes (Arbitrum Sepolia rollup on Ethereum Sepolia). */
import { createPublicClient, encodeAbiParameters, encodePacked, http, keccak256, parseAbiItem } from "viem";
import { sepolia } from "viem/chains";
const c = createPublicClient({ chain: sepolia, transport: http("https://ethereum-sepolia-rpc.publicnode.com") });
const ROLLUP = "0x042B2E6C5E99d4c521bd49beeD5E99651D9B0Cf4";
const STATE = "((bytes32[2] bytes32Vals, uint64[2] u64Vals) globalState, uint8 machineStatus, bytes32 endHistoryRoot)";
const ev = parseAbiItem(`event AssertionCreated(bytes32 indexed assertionHash, bytes32 indexed parentAssertionHash, ((bytes32 prevPrevAssertionHash, bytes32 sequencerBatchAcc, (bytes32 wasmModuleRoot, uint256 requiredStake, address challengeManager, uint64 confirmPeriodBlocks, uint64 nextInboxPosition) configData) beforeStateData, ${STATE} beforeState, ${STATE} afterState) assertion, bytes32 afterInboxBatchAcc, uint256 inboxMaxCount, bytes32 wasmModuleRoot, uint256 requiredStake, address challengeManager, uint64 confirmPeriodBlocks)`);
const getAssertion = { type: "function", name: "getAssertion", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: [{ name: "firstChildBlock", type: "uint64" }, { name: "secondChildBlock", type: "uint64" }, { name: "createdAtBlock", type: "uint64" }, { name: "isFirstChild", type: "bool" }, { name: "status", type: "uint8" }, { name: "configHash", type: "bytes32" }] }] } as const;
const head = await c.getBlockNumber();
let logs: any[] = [];
for (let back = 5_000n; logs.length === 0 && back <= 80_000n; back *= 2n) logs = await c.getLogs({ address: ROLLUP, event: ev, fromBlock: head - back, toBlock: head });
console.log("AssertionCreated logs:", logs.length);
for (const l of logs.slice(-3)) {
  const a = l.args; const after = a.assertion.afterState;
  const stateHash = keccak256(encodeAbiParameters([{ type: "tuple", components: ev.inputs[2].components![2].components }], [after]));
  const mine = keccak256(encodePacked(["bytes32", "bytes32", "bytes32"], [a.parentAssertionHash, stateHash, a.afterInboxBatchAcc]));
  const node = await c.readContract({ address: ROLLUP, abi: [getAssertion], functionName: "getAssertion", args: [a.assertionHash] });
  console.log({ assertionHash: a.assertionHash, recomputedMatches: mine === a.assertionHash, status: ["NoAssertion", "Pending", "Confirmed"][node.status], sendRoot: after.globalState.bytes32Vals[1], createdAtBlock: node.createdAtBlock, confirmPeriodBlocks: a.confirmPeriodBlocks });
}
