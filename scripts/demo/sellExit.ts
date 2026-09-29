/**
 * Step 2 of the demo: sell a pending Xai -> Arbitrum Sepolia withdrawal to ExitVault in ONE transaction.
 * Usage: node scripts/demo/sellExit.ts <xai-withdrawal-tx-hash>
 */
import { formatUnits, parseAbi, type Hex } from "viem";
import { getClients, loadDeployment } from "../lib/clients.ts";
import { buildExitProof } from "../lib/exitProof.ts";
import { encodeSellToBuyer, toExitRecord } from "../lib/hookData.ts";
import { XAI_TESTNET } from "../lib/networks.ts";

const gatewayAbi = parseAbi([
  "function transferExitAndCall(uint256 exitNum, address initialDestination, address newDestination, bytes newData, bytes data)",
]);
const rollupAbi = [
  {
    type: "function",
    name: "getNode",
    stateMutability: "view",
    inputs: [{ type: "uint64" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "stateHash", type: "bytes32" },
          { name: "challengeHash", type: "bytes32" },
          { name: "confirmData", type: "bytes32" },
          { name: "prevNum", type: "uint64" },
          { name: "deadlineBlock", type: "uint64" },
          { name: "noChildConfirmedBeforeBlock", type: "uint64" },
          { name: "stakerCount", type: "uint64" },
          { name: "childStakerCount", type: "uint64" },
          { name: "firstChildBlock", type: "uint64" },
          { name: "latestChildNumber", type: "uint64" },
          { name: "createdAtBlock", type: "uint64" },
          { name: "nodeHash", type: "bytes32" },
        ],
      },
    ],
  },
] as const;
const vaultAbi = parseAbi([
  "struct ExitRecord { address gateway; uint256 exitNum; address initialDestination; address l1Token; uint256 amount; uint256 index; bytes32 sendRoot; uint64 nodeNum; bytes32 blockHash; bool pending; uint64 deadlineBlock; }",
  "function quote(ExitRecord exit) view returns (uint256)",
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

  const node = await parent.readContract({
    address: XAI_TESTNET.ethBridge.rollup,
    abi: rollupAbi,
    functionName: "getNode",
    args: [w.proof.nodeNum],
  });
  const record = toExitRecord(w, gateway, node.deadlineBlock, true);
  // Quote only rises as the deadline approaches, so today's quote is a safe floor.
  const minPayout = await parent.readContract({ address: d.vault, abi: vaultAbi, functionName: "quote", args: [record] });

  console.log(`Exit #${w.exitNum}: ${formatUnits(w.proof.amount, 6)} USDG, proven against pending node ${w.proof.nodeNum}`);
  console.log(`Vault quote: ${formatUnits(minPayout, 6)} USDG (before market fee)`);

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
