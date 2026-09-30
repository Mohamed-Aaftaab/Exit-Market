import { readFileSync, writeFileSync } from "node:fs";
import { network } from "hardhat";
import { getAddress, type Address } from "viem";

/**
 * v2 of the pieces that changed after the 2026-09-30 reviews, next to the unchanged (frozen) ExitMarket:
 * ExitVault (H1–H3 fixes), ExitIntentRouter bound to that vault (re-audit C1/H1) and BoldRootVerifier (M1).
 * The v1 addresses stay on record under `v1`.
 */
const DEPLOYMENT_FILE = "deployments/arbitrumSepolia.json";

async function main() {
  const current = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as Record<string, unknown>;
  const market = getAddress(current.market as Address);
  const usdg = getAddress(current.usdg as Address);

  const { viem } = await network.connect({ network: "arbitrumSepolia" });
  const [deployer] = await viem.getWalletClients();
  const owner = deployer.account.address;
  console.log("Deployer:", owner);

  const vault = await viem.deployContract("ExitVault", [usdg, market, owner, "Exit Vault USDG", "evUSDG"]);
  console.log("ExitVault v2:", vault.address);
  const router = await viem.deployContract("ExitIntentRouter", [market, vault.address]);
  console.log("ExitIntentRouter v2:", router.address);
  if (getAddress(await router.read.buyer()) !== getAddress(vault.address)) throw new Error("router bound to the wrong vault");
  const boldVerifier = await viem.deployContract("BoldRootVerifier");
  console.log("BoldRootVerifier v2:", boldVerifier.address);

  const v1 = { vault: current.vault, router: current.router, boldVerifier: current.boldVerifier };
  const updated = { ...current, vault: vault.address, router: router.address, boldVerifier: boldVerifier.address, v1 };
  writeFileSync(DEPLOYMENT_FILE, `${JSON.stringify(updated, null, 2)}\n`);
  console.log(`Saved ${DEPLOYMENT_FILE}`, updated);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
