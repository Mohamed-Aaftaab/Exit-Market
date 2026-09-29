/**
 * Step 1 of the demo: start a standard-bridge withdrawal of USDG from Xai Testnet to Arbitrum Sepolia.
 * Usage: node scripts/demo/withdrawFromXai.ts <amount-in-USDG>
 */
import { parseAbi, parseUnits } from "viem";
import { getClients } from "../lib/clients.ts";
import { ARBITRUM_SEPOLIA, XAI_TESTNET } from "../lib/networks.ts";

const USDG_DECIMALS = 6;
const routerAbi = parseAbi([
  "function outboundTransfer(address l1Token, address to, uint256 amount, bytes data) payable returns (bytes)",
]);

async function main() {
  const amountArg = process.argv[2];
  if (!amountArg) throw new Error("Usage: node scripts/demo/withdrawFromXai.ts <amount-in-USDG>");
  const amount = parseUnits(amountArg, USDG_DECIMALS);

  const { account, child, childWallet } = getClients();
  const hash = await childWallet.writeContract({
    address: XAI_TESTNET.tokenBridge.childGatewayRouter,
    abi: routerAbi,
    functionName: "outboundTransfer",
    args: [ARBITRUM_SEPOLIA.usdg, account.address, amount, "0x"],
  });
  const receipt = await child.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Withdrawal reverted: ${hash}`);

  console.log(`Withdrawal of ${amountArg} USDG started on Xai Testnet: ${hash}`);
  console.log("It becomes sellable once the next rollup node asserts it (~15 min on Xai Testnet).");
  console.log(`Then run: node scripts/demo/sellExit.ts ${hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
