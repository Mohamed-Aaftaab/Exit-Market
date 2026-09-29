import { readFileSync, writeFileSync } from "node:fs";
import { network } from "hardhat";
import { getAddress, type Address } from "viem";

/**
 * Deploys the gasless ExitIntentRouter (bound to the live ExitMarket) and the BoldRootVerifier next to the
 * existing Arbitrum Sepolia deployment, and records both in deployments/arbitrumSepolia.json.
 */
const DEPLOYMENT_FILE = "deployments/arbitrumSepolia.json";

async function main() {
  const deployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Record<string, unknown>;
  const market = getAddress(deployment.market as Address);

  const { viem } = await network.connect({ network: "arbitrumSepolia" });
  const [deployer] = await viem.getWalletClients();
  console.log("Deployer:", deployer.account.address);

  const router = await viem.deployContract("ExitIntentRouter", [market]);
  console.log("ExitIntentRouter:", router.address);
  if (getAddress(await router.read.market()) !== market) throw new Error("router bound to the wrong market");

  const boldVerifier = await viem.deployContract("BoldRootVerifier");
  console.log("BoldRootVerifier:", boldVerifier.address);

  const updated = { ...deployment, router: router.address, boldVerifier: boldVerifier.address };
  writeFileSync(DEPLOYMENT_FILE, `${JSON.stringify(updated, null, 2)}\n`);
  console.log(`Saved ${DEPLOYMENT_FILE}`, updated);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
