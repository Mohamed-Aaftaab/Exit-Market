/**
 * On-chain golden check of the Stylus ExitProof program, executed by the real Stylus VM on Arbitrum
 * Sepolia, against the live Xai Testnet vector (exit #3, outbox index 72, send root of node 61781).
 */
import { readFileSync } from "node:fs";
import { createPublicClient, http, parseAbi, type Hex } from "viem";
import { arbitrumSepolia } from "viem/chains";

const { exitProof } = JSON.parse(readFileSync("deployments/stylus.arbitrumSepolia.json", "utf8")) as { exitProof: Hex };
const client = createPublicClient({ chain: arbitrumSepolia, transport: http("https://sepolia-rollup.arbitrum.io/rpc") });
const abi = parseAbi([
  "function itemHash(address childGateway, address parentGateway, address l1Token, address from, address to, uint256 amount, uint256 exitNum, uint256 l2Block, uint256 l1Block, uint256 l2Timestamp, uint256 value) view returns (bytes32)",
  "function rootFromItem(bytes32 item, bytes32[] proof, uint256 index) view returns (bytes32)",
]);

const REAL_SEND_ROOT = "0xd8a1c3386ad861c9533e67e76d0f3e403adb04a819775a7ec0ca2404c462b583";
const PROOF: Hex[] = [
  "0x6e2f997569dd82bdb30c0ce25af0633f7331c580d4b6aaf1cd8904f3b4c7113a",
  "0xcebc5eda66a599bf0568aae47dde4cefb5f543fbca405016aa3c1490490a2973",
  "0x0000000000000000000000000000000000000000000000000000000000000000",
  "0x3a2d5e8fcce99f0fd08bd609d1303903ab54e9ddfa2730834e14562f11b17dac",
  "0x0000000000000000000000000000000000000000000000000000000000000000",
  "0x0000000000000000000000000000000000000000000000000000000000000000",
  "0x2355f193840f04fc94aed433f911e03a9935a907db640130efbaf69442f7ddd6",
];

const item = await client.readContract({
  address: exitProof,
  abi,
  functionName: "itemHash",
  args: [
    "0xD840761a09609394FaFA3404bEEAb312059AC558",
    "0xCcB451C4Df22addCFe1447c58bC6b2f264Bb1256",
    "0x67e197D575e7A350Ff3dE1A7eAd2aA06b19145B6",
    "0x2cd28Cda6825C4967372478E87D004637B73F996",
    "0x2cd28Cda6825C4967372478E87D004637B73F996",
    1_000_000_000_000_000n, 3n, 14_217_403n, 9_173_964n, 1_757_504_867n, 0n,
  ],
});
const root = await client.readContract({ address: exitProof, abi, functionName: "rootFromItem", args: [item, PROOF, 72n] });
console.log(`Stylus itemHash:      ${item}`);
console.log(`Stylus rootFromItem:  ${root}`);
console.log(`live Xai send root:   ${REAL_SEND_ROOT}`);
console.log(`MATCH: ${root === REAL_SEND_ROOT}`);

try {
  await client.readContract({ address: exitProof, abi, functionName: "rootFromItem", args: [item, PROOF, 72n + 128n] });
  console.log("padded index: NOT rejected (unexpected)");
} catch {
  console.log("padded index: rejected (PathNotMinimal) ✓");
}
if (root !== REAL_SEND_ROOT) process.exitCode = 1;
