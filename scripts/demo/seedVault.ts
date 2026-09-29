/**
 * Deposits USDG into ExitVault as exit liquidity.
 * Usage: node scripts/demo/seedVault.ts <amount-in-USDG>
 */
import { formatUnits, parseAbi, parseUnits } from "viem";
import { getClients, loadDeployment } from "../lib/clients.ts";

const abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function totalAssets() view returns (uint256)",
]);

async function main() {
  const amountArg = process.argv[2];
  if (!amountArg) throw new Error("Usage: node scripts/demo/seedVault.ts <amount-in-USDG>");
  const assets = parseUnits(amountArg, 6);
  const { account, parent, parentWallet } = getClients();
  const d = loadDeployment();

  const approve = await parentWallet.writeContract({ address: d.usdg, abi, functionName: "approve", args: [d.vault, assets] });
  await parent.waitForTransactionReceipt({ hash: approve });
  const hash = await parentWallet.writeContract({ address: d.vault, abi, functionName: "deposit", args: [assets, account.address] });
  const receipt = await parent.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Deposit reverted: ${hash}`);

  const total = await parent.readContract({ address: d.vault, abi, functionName: "totalAssets" });
  console.log(`Deposited ${amountArg} USDG: ${hash}. Vault total assets: ${formatUnits(total, 6)} USDG`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
