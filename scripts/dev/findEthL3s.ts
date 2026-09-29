import { createPublicClient, http, parseAbi, getAddress } from "viem";
import { arbitrumSepolia } from "viem/chains";
const c = createPublicClient({ chain: arbitrumSepolia, transport: http("https://sepolia-rollup.arbitrum.io/rpc"), batch: { multicall: true } });
const CREATOR = "0x56C486D3786fA26cc61473C499A36Eb9CC1FbD8E";
const head = await c.getBlockNumber();
const logs: any[] = [];
const CHUNK = 5_000_000n;
for (let start = 0n; start <= head; start += CHUNK) {
  const end = start + CHUNK - 1n > head ? head : start + CHUNK - 1n;
  try {
    const r = (await c.request({ method: "eth_getLogs" as never, params: [{ address: CREATOR, topics: ["0x9a9203aa9ddcf21d8523e422e009214f0447efca13201ecdd802d8663092de7e"], fromBlock: "0x" + start.toString(16), toBlock: "0x" + end.toString(16) }] as never })) as any[];
    logs.push(...r);
  } catch (e: any) { console.log("chunk failed", start, (e.shortMessage ?? e.message).slice(0, 80)); }
}
const inboxes = [...new Set(logs.map((l) => getAddress("0x" + l.topics[1].slice(26))))];
console.log("token bridges:", logs.length, "unique inboxes:", inboxes.length);
const a = parseAbi(["function bridge() view returns (address)", "function rollup() view returns (address)", "function nativeToken() view returns (address)", "function latestNodeCreated() view returns (uint64)", "function chainId() view returns (uint256)", "function confirmPeriodBlocks() view returns (uint64)"]);
const nodeAbi = [{ type: "function", name: "getNode", stateMutability: "view", inputs: [{ type: "uint64" }], outputs: [{ type: "tuple", components: [{ name: "stateHash", type: "bytes32" }, { name: "challengeHash", type: "bytes32" }, { name: "confirmData", type: "bytes32" }, { name: "prevNum", type: "uint64" }, { name: "deadlineBlock", type: "uint64" }, { name: "noChildConfirmedBeforeBlock", type: "uint64" }, { name: "stakerCount", type: "uint64" }, { name: "childStakerCount", type: "uint64" }, { name: "firstChildBlock", type: "uint64" }, { name: "latestChildNumber", type: "uint64" }, { name: "createdAtBlock", type: "uint64" }, { name: "nodeHash", type: "bytes32" }] }] }] as const;
const l1Now = BigInt(((await c.getBlock()) as any).l1BlockNumber);
const live: any[] = [];
let errors = 0, stale = 0;
const check = async (inbox: `0x${string}`) => {
  try {
    const bridge = await c.readContract({ address: inbox, abi: a, functionName: "bridge" });
    const rollup = await c.readContract({ address: bridge, abi: a, functionName: "rollup" });
    let eth = true; try { await c.readContract({ address: bridge, abi: a, functionName: "nativeToken" }); eth = false; } catch {}
    const n = await c.readContract({ address: rollup, abi: a, functionName: "latestNodeCreated" });
    if (n === 0n) return;
    const node = await c.readContract({ address: rollup, abi: nodeAbi, functionName: "getNode", args: [n] });
    const ageL1 = l1Now - node.createdAtBlock;
    if (ageL1 > 7200n) { stale++; return; } // last assertion older than ~1 day
    const chainId = await c.readContract({ address: rollup, abi: a, functionName: "chainId" });
    const cp = await c.readContract({ address: rollup, abi: a, functionName: "confirmPeriodBlocks" });
    live.push({ chainId, eth, inbox, rollup, latestNode: n, lastAssertionMinAgo: Number(ageL1) * 12 / 60, confirmPeriodBlocks: cp });
  } catch { errors++; }
};
for (let i = 0; i < inboxes.length; i += 40) await Promise.all(inboxes.slice(i, i + 40).map(check));
console.log("errors", errors, "stale", stale);
console.log(JSON.stringify(live, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1));
