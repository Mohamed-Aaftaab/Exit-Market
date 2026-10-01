import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { network } from "hardhat";
import { getAddress, zeroAddress, type Address } from "viem";
import { ARBITRUM_SEPOLIA, XAI_TESTNET } from "./lib/networks.ts";

/**
 * Deploys Exit Market on Arbitrum Sepolia for Xai Testnet exits:
 *   LegacyRootVerifier (v4: refuses pending roots whose node chain has a rival)
 *   ExitMarket  -> allow Xai's standard and custom gateways with that verifier -> renounce ownership
 *   ExitVault   (USDG, ERC-4626; its owner can only tune pricing within hard caps)
 *   ExitIntentRouter bound to that market and vault (no owner)
 * The BOLD verifier holds no funds, has no owner and is unchanged since v2, so a recorded one is reused.
 * Previous deployments are kept under `history` in the deployment file.
 *   npx hardhat run scripts/deploy.ts --network arbitrumSepolia
 */
const DEPLOYMENT_FILE = "deployments/arbitrumSepolia.json";
const VERSION = "v4";
const MARKET_FEE_BPS = 25; // 0.25%
const GATEWAYS = [XAI_TESTNET.tokenBridge.parentErc20Gateway, XAI_TESTNET.tokenBridge.parentCustomGateway];

type DeploymentFile = Record<string, unknown> & { history?: Record<string, unknown> };

function readCurrent(): DeploymentFile {
  return existsSync(DEPLOYMENT_FILE) ? (JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as DeploymentFile) : {};
}

async function main() {
  const current = readCurrent();
  const { viem } = await network.connect({ network: "arbitrumSepolia" });
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  const owner = deployer.account.address;
  const deployBlock = await publicClient.getBlockNumber();
  console.log(`Deployer ${owner}, starting at block ${deployBlock}`);

  const recordedBold = typeof current.boldVerifier === "string" ? getAddress(current.boldVerifier) : undefined;
  const boldVerifier =
    recordedBold && (await publicClient.getCode({ address: recordedBold }))
      ? recordedBold
      : (await viem.deployContract("BoldRootVerifier")).address;
  const verifier = (await viem.deployContract("LegacyRootVerifier")).address;
  console.log("LegacyRootVerifier:", verifier, "BoldRootVerifier:", boldVerifier);

  const market = await viem.deployContract("ExitMarket", [ARBITRUM_SEPOLIA.usdg, owner, MARKET_FEE_BPS, owner]);
  console.log("ExitMarket:", market.address);
  for (const gateway of GATEWAYS) {
    const hash = await market.write.allowGateway([gateway, verifier]);
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`allowGateway(${gateway}): ${hash}`);
  }
  // From here on nobody can add a gateway, change the fee or disallow a gateway (round 5, H-2).
  const renounce = await market.write.renounceOwnership();
  await publicClient.waitForTransactionReceipt({ hash: renounce });
  if (getAddress((await market.read.owner()) as Address) !== zeroAddress) throw new Error("market ownership was not renounced");
  console.log("renounceOwnership:", renounce);

  const vault = await viem.deployContract("ExitVault", [ARBITRUM_SEPOLIA.usdg, market.address, owner, "Exit Vault USDG", "evUSDG"]);
  console.log("ExitVault:", vault.address);
  const router = await viem.deployContract("ExitIntentRouter", [market.address, vault.address]);
  if (getAddress((await router.read.buyer()) as Address) !== getAddress(vault.address)) throw new Error("router bound to the wrong vault");
  console.log("ExitIntentRouter:", router.address);

  // The v2 file kept v1 nested under `v1`; lift it next to the others.
  const { history = {}, v1, ...previous } = current;
  const archived = {
    ...(v1 ? { v1 } : {}),
    ...(Object.keys(previous).length > 0 ? { [String(previous.version ?? "v2")]: previous } : {}),
  };
  const next = {
    version: VERSION,
    chainId: ARBITRUM_SEPOLIA.chainId,
    usdg: ARBITRUM_SEPOLIA.usdg,
    verifier,
    boldVerifier,
    market: market.address,
    vault: vault.address,
    router: router.address,
    deployBlock: Number(deployBlock),
    marketOwnershipRenounced: renounce,
    history: { ...history, ...archived },
  };
  mkdirSync("deployments", { recursive: true });
  writeFileSync(DEPLOYMENT_FILE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Saved ${DEPLOYMENT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
