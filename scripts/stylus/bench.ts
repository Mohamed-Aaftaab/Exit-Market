/**
 * Deploys the Solidity twin (ExitLeafBench) and compares on-chain gas against the Stylus ExitProof program
 * using eth_estimateGas on Arbitrum Sepolia, for proof depths seen in practice (7 on Xai, ~18 on Arbitrum One).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { network } from "hardhat";
import { encodeFunctionData, keccak256, parseAbi, toHex, type Hex } from "viem";

const abi = parseAbi(["function rootFromItem(bytes32 item, bytes32[] proof, uint256 index) view returns (bytes32)"]);
const { exitProof } = JSON.parse(readFileSync("deployments/stylus.arbitrumSepolia.json", "utf8")) as { exitProof: Hex };

const { viem } = await network.connect({ network: "arbitrumSepolia" });
const client = await viem.getPublicClient();
const [wallet] = await viem.getWalletClients();
const bench = await viem.deployContract("ExitLeafBench");
console.log(`ExitLeafBench (Solidity) deployed at ${bench.address}`);

const rows: { depth: number; solidity: bigint; stylus: bigint }[] = [];
for (const depth of [7, 18, 32, 64]) {
  const proof = Array.from({ length: depth }, (_, i) => keccak256(toHex(i)));
  const data = encodeFunctionData({ abi, functionName: "rootFromItem", args: [keccak256("0x01"), proof, BigInt(depth > 1 ? 5 : 0)] });
  const gas = (to: Hex) => client.estimateGas({ account: wallet.account, to, data });
  const [solidity, stylus] = await Promise.all([gas(bench.address), gas(exitProof)]);
  rows.push({ depth, solidity, stylus });
  console.log(`depth ${depth}: Solidity ${solidity} gas | Stylus ${stylus} gas`);
}
writeFileSync(
  "docs/audit/STYLUS_BENCH.json",
  `${JSON.stringify({ solidity: bench.address, stylus: exitProof, rows: rows.map((r) => ({ ...r, solidity: String(r.solidity), stylus: String(r.stylus) })) }, null, 2)}\n`,
);
