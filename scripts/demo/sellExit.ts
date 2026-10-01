/**
 * Step 2 of the demo: sell a pending Xai -> Arbitrum Sepolia withdrawal to ExitVault in ONE transaction.
 * Usage: node scripts/demo/sellExit.ts <xai-withdrawal-tx-hash>
 */
import { formatUnits, parseAbi, type Hex } from "viem";
import { exitMarketAbi, exitVaultAbi } from "../lib/abis.ts";
import { getClients, loadDeployment } from "../lib/clients.ts";
import { buildExitProof } from "../lib/exitProof.ts";
import { encodeSellToBuyer, netOfMarketFee } from "../lib/hookData.ts";
import { exitRecordFor } from "../lib/marketReads.ts";
import { XAI_TESTNET } from "../lib/networks.ts";

const gatewayAbi = parseAbi([
  "function transferExitAndCall(uint256 exitNum, address initialDestination, address newDestination, bytes newData, bytes data)",
]);

async function main() {
  const withdrawalTx = process.argv[2] as Hex | undefined;
  if (!withdrawalTx) throw new Error("Usage: node scripts/demo/sellExit.ts <xai-withdrawal-tx-hash>");

  const { account, parent, parentWallet, child } = getClients();
  const d = loadDeployment();
  const gateway = XAI_TESTNET.tokenBridge.parentErc20Gateway;

  const w = await buildExitProof({
    parent,
    child,
    rollup: XAI_TESTNET.ethBridge.rollup,
    childGateway: XAI_TESTNET.tokenBridge.childErc20Gateway,
    withdrawalTx,
  });
  if (w.initialDestination.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`This wallet does not own exit #${w.exitNum}`);
  }

  // The record exactly as the market will build it, from its own verifier's verdict (pending or confirmed).
  const { record, verdict } = await exitRecordFor(parent, d.market, { parent: gateway, child: XAI_TESTNET.tokenBridge.childErc20Gateway }, w);
  if (!verdict.valid) throw new Error(`The market's verifier refuses this root (node ${w.proof.nodeNum} may be contested); retry later`);
  // Quote only rises as the deadline approaches, so today's quote is a safe floor; the floor is net of the fee.
  const [quote, feeBps] = await Promise.all([
    parent.readContract({ address: d.vault, abi: exitVaultAbi, functionName: "quote", args: [record] }),
    parent.readContract({ address: d.market, abi: exitMarketAbi, functionName: "feeBps" }),
  ]);
  const minPayout = netOfMarketFee(quote, feeBps);

  console.log(`Exit #${w.exitNum}: ${formatUnits(w.proof.amount, 6)} USDG, proven against ${verdict.pending ? `pending node ${w.proof.nodeNum}` : "a confirmed root"}`);
  console.log(`Vault quote: ${formatUnits(quote, 6)} USDG; you receive at least ${formatUnits(minPayout, 6)} after the market fee`);

  const hash = await parentWallet.writeContract({
    address: gateway,
    abi: gatewayAbi,
    functionName: "transferExitAndCall",
    args: [w.exitNum, w.initialDestination, d.market, "0x", encodeSellToBuyer(w, d.vault, minPayout)],
  });
  const receipt = await parent.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Sale reverted: ${hash}`);
  console.log(`Sold instantly on Arbitrum Sepolia: https://sepolia.arbiscan.io/tx/${hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
