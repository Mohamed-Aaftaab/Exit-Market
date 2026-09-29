import { createPublicClient, http, parseAbi } from "viem";
import { arbitrumSepolia } from "viem/chains";
const c = createPublicClient({ chain: arbitrumSepolia, transport: http("https://sepolia-rollup.arbitrum.io/rpc") });
const a = parseAbi(["function allowedOutboxes(address) view returns (bool)","function firstUnresolvedNode() view returns (uint64)","function latestNodeCreated() view returns (uint64)","function latestConfirmed() view returns (uint64)"]);
const R = "0xeedE9367Df91913ab149e828BDd6bE336df2c892";
console.log("allowedOutboxes:", await c.readContract({ address: "0x6c7FAC4edC72E86B3388B48979eF37Ecca5027e6", abi: a, functionName: "allowedOutboxes", args: ["0xc7491a559b416540427f9f112C5c98b1412c5d51"] }));
for (const f of ["latestConfirmed", "firstUnresolvedNode", "latestNodeCreated"] as const) console.log(f, await c.readContract({ address: R, abi: a, functionName: f }));
console.log("parent block.number (L1 approx):", (await c.getBlock()).number, "— rollup deadlines use L1 blocks via ArbSys-compatible block.number");
