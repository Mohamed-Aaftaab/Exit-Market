/**
 * Generates contracts/test/fork/ArbOneExitFixture.sol: a REAL, pending Arbitrum One -> Ethereum token
 * withdrawal, proven against a REAL pending BOLD assertion on Ethereum mainnet.
 * Usage: node scripts/dev/makeArbOneFixture.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createPublicClient, decodeAbiParameters, decodeEventLog, encodeAbiParameters, http, parseAbi, parseAbiItem, toEventSelector, type Hex } from "viem";
import { arbitrum, mainnet } from "viem/chains";

const ETH_RPC = process.env.ETH_RPC_URL ?? "https://ethereum-rpc.publicnode.com";
const eth = createPublicClient({ chain: mainnet, transport: http(ETH_RPC) });
const arb = createPublicClient({ chain: arbitrum, transport: http("https://arb1.arbitrum.io/rpc") });

const ROLLUP = "0x4DCeB440657f21083db8aDd07665f8ddBe1DCfc0"; // Arbitrum One BOLD rollup (bridge.rollup())
const OUTBOX = "0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840";
const L2_ERC20_GATEWAY = "0x09e9222E96E7B4AE2a407B98d48e330053351EEe";
const L1_ERC20_GATEWAY = "0xa3A7B6F88361F48403514059F1F16C8E78d60EeC";

const STATE = "((bytes32[2] bytes32Vals, uint64[2] u64Vals) globalState, uint8 machineStatus, bytes32 endHistoryRoot)";
const ASSERTION_CREATED = parseAbiItem(
  `event AssertionCreated(bytes32 indexed assertionHash, bytes32 indexed parentAssertionHash, ((bytes32 prevPrevAssertionHash, bytes32 sequencerBatchAcc, (bytes32 wasmModuleRoot, uint256 requiredStake, address challengeManager, uint64 confirmPeriodBlocks, uint64 nextInboxPosition) configData) beforeStateData, ${STATE} beforeState, ${STATE} afterState) assertion, bytes32 afterInboxBatchAcc, uint256 inboxMaxCount, bytes32 wasmModuleRoot, uint256 requiredStake, address challengeManager, uint64 confirmPeriodBlocks)`,
);
const WITHDRAWAL_INITIATED = parseAbiItem(
  "event WithdrawalInitiated(address l1Token, address indexed _from, address indexed _to, uint256 indexed _l2ToL1Id, uint256 _exitNum, uint256 _amount)",
);
const L2_TO_L1_TX = parseAbiItem(
  "event L2ToL1Tx(address caller, address indexed destination, uint256 indexed hash, uint256 indexed position, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data)",
);
const getAssertion = parseAbi([
  "struct N { uint64 firstChildBlock; uint64 secondChildBlock; uint64 createdAtBlock; bool isFirstChild; uint8 status; bytes32 configHash; }",
  "function getAssertion(bytes32) view returns (N)",
]);
const nodeInterface = parseAbi(["function constructOutboxProof(uint64 size, uint64 leaf) view returns (bytes32 send, bytes32 root, bytes32[] proof)"]);
const outbox = parseAbi(["function isSpent(uint256) view returns (bool)"]);

// 1. Newest PENDING, unchallenged assertion on Ethereum.
const ethHead = await eth.getBlockNumber();
// ~6.4 days of assertions (confirm period 45,818 blocks) so the whole pending chain is available.
const CHUNK = 5_000n;
const WINDOW = 55_000n;
// Public full nodes refuse old logs ("archive"); the Blockscout log API serves them for free.
type RawLog = { data: Hex; topics: Hex[]; blockNumber: Hex };
const assertions: { args: ReturnType<typeof decodeEventLog<[typeof ASSERTION_CREATED]>>["args"]; blockNumber: bigint }[] = [];
for (let from = ethHead - WINDOW; from <= ethHead; from += CHUNK) {
  const to = from + CHUNK - 1n > ethHead ? ethHead : from + CHUNK - 1n;
  const url = `https://eth.blockscout.com/api?module=logs&action=getLogs&address=${ROLLUP}&topic0=${toEventSelector(ASSERTION_CREATED)}&fromBlock=${from}&toBlock=${to}`;
  let json: { result?: RawLog[] } = {};
  for (let attempt = 0; attempt < 5 && !Array.isArray(json.result); attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2_000 * attempt));
    json = await (await fetch(url)).json();
  }
  for (const l of json.result ?? []) {
    const topics = l.topics.filter(Boolean) as [Hex, ...Hex[]];
    assertions.push({ args: decodeEventLog({ abi: [ASSERTION_CREATED], data: l.data, topics }).args, blockNumber: BigInt(l.blockNumber) });
  }
}
console.log(`Collected ${assertions.length} AssertionCreated events`);
let chosen: (typeof assertions)[number] | undefined;
for (const a of [...assertions].reverse()) {
  const node = await eth.readContract({ address: ROLLUP, abi: getAssertion, functionName: "getAssertion", args: [a.args.assertionHash!] });
  const parent = await eth.readContract({ address: ROLLUP, abi: getAssertion, functionName: "getAssertion", args: [a.args.parentAssertionHash!] });
  if (node.status === 1 && parent.secondChildBlock === 0n) { chosen = a; break; }
}
if (!chosen) throw new Error("No pending unchallenged assertion found");

// Pending chain from the chosen assertion back to (excluding) the latest confirmed ancestor, oldest first.
const byHash = new Map(assertions.map((a) => [a.args.assertionHash!, a]));
const chain: typeof assertions = [];
for (let cursor: (typeof assertions)[number] | undefined = chosen; cursor; ) {
  chain.unshift(cursor);
  const parentHash = cursor.args.parentAssertionHash!;
  const parent = await eth.readContract({ address: ROLLUP, abi: getAssertion, functionName: "getAssertion", args: [parentHash] });
  if (parent.status === 2) break;
  cursor = byHash.get(parentHash);
  if (!cursor) throw new Error(`Pending ancestor ${parentHash} outside the log window`);
}
console.log(`Pending chain length: ${chain.length}`);
const CHAIN_TUPLE = [{ type: "tuple[]", components: [
  { name: "parent", type: "bytes32" },
  { name: "afterState", type: "tuple", components: ASSERTION_CREATED.inputs[2].components![2].components },
  { name: "inboxAcc", type: "bytes32" },
] }] as const;
const chainHex = encodeAbiParameters(CHAIN_TUPLE as never, [chain.map((c) => ({ parent: c.args.parentAssertionHash!, afterState: c.args.assertion!.afterState, inboxAcc: c.args.afterInboxBatchAcc! }))] as never);
const after = chosen.args.assertion!.afterState;
const [blockHash, sendRoot] = after.globalState.bytes32Vals;
const arbBlock = (await arb.request({ method: "eth_getBlockByHash" as never, params: [blockHash, false] as never })) as { sendCount: Hex; sendRoot: Hex; number: Hex };
if (arbBlock.sendRoot !== sendRoot) throw new Error("Assertion / Arbitrum block mismatch");
const sendCount = BigInt(arbBlock.sendCount);
console.log(`Pending assertion ${chosen.args.assertionHash} covers ${sendCount} sends (Arbitrum block ${BigInt(arbBlock.number)})`);

// 2. A token withdrawal covered by that assertion and still unspent.
const arbTip = BigInt(arbBlock.number);
const logs = await arb.getLogs({ address: L2_ERC20_GATEWAY, event: WITHDRAWAL_INITIATED, fromBlock: arbTip - 400_000n, toBlock: arbTip });
let w: (typeof logs)[number] | undefined;
for (const l of [...logs].reverse()) {
  if (l.args._l2ToL1Id! >= sendCount) continue;
  if (await eth.readContract({ address: OUTBOX, abi: outbox, functionName: "isSpent", args: [l.args._l2ToL1Id!] })) continue;
  w = l; break;
}
if (!w) throw new Error("No covered unspent withdrawal in window");
const receipt = await arb.getTransactionReceipt({ hash: w.transactionHash! });
const msgLog = receipt.logs.find((l) => l.address.toLowerCase() === "0x0000000000000000000000000000000000000064" && BigInt(l.topics[3]!) === w!.args._l2ToL1Id);
const { args: m } = (await import("viem")).decodeEventLog({ abi: [L2_TO_L1_TX], data: msgLog!.data, topics: msgLog!.topics });
const [, , , , gatewayMsg] = decodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes" }], `0x${m.data.slice(10)}`);
const [exitNum] = decodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], gatewayMsg);
const [, root, proof] = await arb.readContract({ address: "0x00000000000000000000000000000000000000C8", abi: nodeInterface, functionName: "constructOutboxProof", args: [sendCount, m.position] });
if (root !== sendRoot) throw new Error("Proof root mismatch");
console.log(`Withdrawal ${w.transactionHash}: exit #${exitNum}, position ${m.position}, amount ${w.args._amount} of ${w.args.l1Token}`);

const lines = proof.map((h, i) => `        p[${i}] = ${h};`).join("\n");
const sol = `// SPDX-License-Identifier: MIT
// GENERATED by scripts/dev/makeArbOneFixture.ts from Arbitrum One tx ${w.transactionHash}
// and pending BOLD assertion ${chosen.args.assertionHash} (Ethereum block ${chosen.blockNumber}). Do not edit.
pragma solidity 0.8.28;

import {ExitClaim} from "../../interfaces/IExitMarket.sol";
import {BoldAssertionState, BoldGlobalState} from "../../interfaces/IBoldRollup.sol";

library ArbOneExitFixture {
    address internal constant ROLLUP = ${ROLLUP};
    address internal constant L1_GATEWAY = ${L1_ERC20_GATEWAY};
    uint256 internal constant EXIT_NUM = ${exitNum};
    bytes32 internal constant ASSERTION_HASH = ${chosen.args.assertionHash};
    bytes32 internal constant PARENT_ASSERTION_HASH = ${chosen.args.parentAssertionHash};
    bytes32 internal constant INBOX_ACC = ${chosen.args.afterInboxBatchAcc};

    struct ChainLink {
        bytes32 parent;
        BoldAssertionState afterState;
        bytes32 inboxAcc;
    }

    /// @notice Every pending assertion from the latest confirmed one down to ASSERTION_HASH, oldest first.
    function chain() internal pure returns (ChainLink[] memory) {
        return abi.decode(hex"${chainHex.slice(2)}", (ChainLink[]));
    }

    function afterState() internal pure returns (BoldAssertionState memory s) {
        s.globalState = BoldGlobalState({
            bytes32Vals: [bytes32(${blockHash}), bytes32(${sendRoot})],
            u64Vals: [uint64(${after.globalState.u64Vals[0]}), uint64(${after.globalState.u64Vals[1]})]
        });
        s.machineStatus = ${after.machineStatus};
        s.endHistoryRoot = ${after.endHistoryRoot};
    }

    function claim() internal pure returns (ExitClaim memory c) {
        bytes32[] memory p = new bytes32[](${proof.length});
${lines}
        c = ExitClaim({
            initialDestination: ${w.args._to},
            l1Token: ${w.args.l1Token},
            from: ${w.args._from},
            amount: ${w.args._amount},
            l2Block: ${m.arbBlockNum},
            l1Block: ${m.ethBlockNum},
            l2Timestamp: ${m.timestamp},
            index: ${m.position},
            proof: p,
            sendRoot: ${sendRoot},
            nodeNum: 0,
            blockHash: ${chosen.args.assertionHash}
        });
    }
}
`;
mkdirSync("contracts/test/fork", { recursive: true });
writeFileSync("contracts/test/fork/ArbOneExitFixture.sol", sol);
console.log("Wrote contracts/test/fork/ArbOneExitFixture.sol");
