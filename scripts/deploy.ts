import { mkdirSync, writeFileSync } from "node:fs";
import { network } from "hardhat";
import { getAddress } from "viem";

/** Verified on Arbitrum Sepolia (421614) on 2026-09-29. */
const USDG = getAddress("0xFFC95faa3d63Cde504a05B567C600B78C0b41892");
const XAI_TESTNET_GATEWAYS = [
  getAddress("0xCcB451C4Df22addCFe1447c58bC6b2f264Bb1256"), // L1OrbitERC20Gateway (standard)
  getAddress("0x04e14E04949D49ae9c551ca8Cc3192310Ce65D88"), // L1OrbitCustomGateway
];
const MARKET_FEE_BPS = 25; // 0.25%

async function main() {
  const { viem } = await network.connect({ network: "arbitrumSepolia" });
  const [deployer] = await viem.getWalletClients();
  const owner = deployer.account.address;
  console.log("Deployer:", owner);

  const verifier = await viem.deployContract("LegacyRootVerifier");
  console.log("LegacyRootVerifier:", verifier.address);

  const market = await viem.deployContract("ExitMarket", [USDG, owner, MARKET_FEE_BPS, owner]);
  console.log("ExitMarket:", market.address);

  for (const gateway of XAI_TESTNET_GATEWAYS) {
    const hash = await market.write.allowGateway([gateway, verifier.address]);
    console.log(`allowGateway(${gateway}):`, hash);
  }

  const vault = await viem.deployContract("ExitVault", [USDG, market.address, owner, "Exit Vault USDG", "evUSDG"]);
  console.log("ExitVault:", vault.address);

  const deployment = { chainId: 421614, usdg: USDG, verifier: verifier.address, market: market.address, vault: vault.address };
  mkdirSync("deployments", { recursive: true });
  writeFileSync("deployments/arbitrumSepolia.json", `${JSON.stringify(deployment, null, 2)}\n`);
  console.log("Saved deployments/arbitrumSepolia.json", deployment);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
