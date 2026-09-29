/**
 * One-time demo setup using Offchain Labs' @arbitrum/sdk (Xai Testnet uses sXAI as its gas token, so
 * retryable fees for deposits are paid in sXAI on Arbitrum Sepolia).
 *
 *   node scripts/demo/bridgeSetup.ts sxai-withdraw <amount>   # L3 faucet sXAI -> Arbitrum Sepolia (for deposit fees)
 *   node scripts/demo/bridgeSetup.ts sxai-claim <txHash>      # execute that withdrawal once confirmed (~30-60 min)
 *   node scripts/demo/bridgeSetup.ts usdg-deposit <amount>    # USDG Arbitrum Sepolia -> Xai Testnet
 */
import "dotenv/config";
import { EthBridger, Erc20Bridger, ChildTransactionReceipt, registerCustomArbitrumNetwork } from "@arbitrum/sdk";
import { providers, Wallet, utils } from "ethers";
import { ARBITRUM_SEPOLIA, XAI_TESTNET } from "../lib/networks.ts";

const xai = registerCustomArbitrumNetwork({
  name: XAI_TESTNET.name,
  chainId: XAI_TESTNET.chainId,
  parentChainId: XAI_TESTNET.parentChainId,
  confirmPeriodBlocks: XAI_TESTNET.confirmPeriodBlocks,
  isCustom: true,
  isTestnet: true,
  nativeToken: XAI_TESTNET.nativeToken,
  ethBridge: XAI_TESTNET.ethBridge,
  tokenBridge: XAI_TESTNET.tokenBridge,
});

function signers() {
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) throw new Error("Missing DEPLOYER_PRIVATE_KEY in .env");
  const parentProvider = new providers.JsonRpcProvider(process.env.ARB_SEPOLIA_RPC_URL ?? ARBITRUM_SEPOLIA.rpcUrl);
  const childProvider = new providers.JsonRpcProvider(XAI_TESTNET.rpcUrl);
  return {
    parentSigner: new Wallet(key, parentProvider),
    childSigner: new Wallet(key, childProvider),
    childProvider,
  };
}

async function sxaiWithdraw(amount: string) {
  const { childSigner } = signers();
  const bridger = new EthBridger(xai);
  const tx = await bridger.withdraw({
    amount: utils.parseEther(amount),
    destinationAddress: childSigner.address,
    from: childSigner.address,
    childSigner,
  });
  const receipt = await tx.wait();
  console.log(`sXAI withdrawal started on Xai Testnet: ${receipt.transactionHash}`);
  console.log(`Claim it after confirmation: node scripts/demo/bridgeSetup.ts sxai-claim ${receipt.transactionHash}`);
}

async function sxaiClaim(txHash: string) {
  const { parentSigner, childProvider } = signers();
  const receipt = new ChildTransactionReceipt(await childProvider.getTransactionReceipt(txHash));
  const [message] = await receipt.getChildToParentMessages(parentSigner);
  if (!message) throw new Error("No child-to-parent message in that tx");
  console.log("Waiting until the withdrawal is confirmed on Arbitrum Sepolia…");
  await message.waitUntilReadyToExecute(childProvider, 60_000);
  const exec = await message.execute(childProvider);
  console.log(`Claimed on Arbitrum Sepolia: ${(await exec.wait()).transactionHash}`);
}

async function usdgDeposit(amount: string) {
  const { parentSigner, childProvider } = signers();
  const bridger = new Erc20Bridger(xai);
  const erc20ParentAddress = ARBITRUM_SEPOLIA.usdg;
  const value = utils.parseUnits(amount, 6);

  console.log("Approving sXAI (retryable fees) and USDG for the gateway…");
  await (await bridger.approveGasToken({ erc20ParentAddress, parentSigner })).wait();
  await (await bridger.approveToken({ erc20ParentAddress, parentSigner })).wait();

  const tx = await bridger.deposit({ amount: value, erc20ParentAddress, parentSigner, childProvider });
  const receipt = await tx.wait();
  console.log(`Deposit sent on Arbitrum Sepolia: ${receipt.transactionHash}. Waiting for Xai Testnet…`);
  const result = await receipt.waitForChildTransactionReceipt(childProvider);
  if (!result.complete) throw new Error(`Retryable not redeemed: ${JSON.stringify(result.message)}`);
  console.log(`USDG arrived on Xai Testnet (token ${ARBITRUM_SEPOLIA.usdgOnXai}).`);
}

const [command, arg] = process.argv.slice(2);
const commands: Record<string, (a: string) => Promise<void>> = {
  "sxai-withdraw": sxaiWithdraw,
  "sxai-claim": sxaiClaim,
  "usdg-deposit": usdgDeposit,
};

const run = command ? commands[command] : undefined;
if (!run || !arg) {
  console.error("Usage: node scripts/demo/bridgeSetup.ts <sxai-withdraw|sxai-claim|usdg-deposit> <arg>");
  process.exitCode = 1;
} else {
  run(arg).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
