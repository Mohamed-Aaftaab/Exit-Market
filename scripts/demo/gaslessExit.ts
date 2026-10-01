/**
 * Live gasless exit, end to end, through the web app's own relayer (POST /api/relay).
 * The seller holds NO ETH on Arbitrum Sepolia: it withdraws on Xai straight to the ExitIntentRouter, signs
 * one EIP-712 SellOrder, and a relayer settles it, paying the parent-chain gas and earning the relayer fee.
 *
 *   node scripts/demo/gaslessExit.ts setup <usdg>     create seller/relayer test keys (relayer in web/.env.local) and fund them
 *   node scripts/demo/gaslessExit.ts start <usdg>     seller withdraws on Xai to the router and signs the order
 *   node scripts/demo/gaslessExit.ts relay [appUrl]   POST the intent to the app until settled (default http://localhost:3000)
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  createWalletClient,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseEther,
  parseEventLogs,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { getClients, xaiTestnet } from "../lib/clients.ts";
import { ARBITRUM_SEPOLIA, XAI_TESTNET } from "../lib/networks.ts";
import { SELL_ORDER_TYPES, routerDomain } from "../lib/relay.ts";

const INTENT_FILE = "deployments/gasless-intent.local.json";
const WEB_ENV = "web/.env.local";
const USDG_DECIMALS = 6;
const RELAYER_FEE = 20_000n; // 0.02 USDG, same as the web app
const MIN_BPS = 9_900n; // seller accepts >= 99% of face value minus the relayer fee
const ORDER_TTL_SECONDS = 24 * 60 * 60;
const SELLER_SXAI = parseEther("1"); // L3 gas for the withdrawal
const RELAYER_ETH = parseEther("0.002"); // parent-chain gas for settlements
const POLL_MS = 60_000;

const childRouterAbi = parseAbi([
  "function outboundTransfer(address l1Token, address to, uint256 amount, bytes data) payable returns (bytes)",
]);
const withdrawalInitiated = parseAbi([
  "event WithdrawalInitiated(address l1Token, address indexed _from, address indexed _to, uint256 indexed _l2ToL1Id, uint256 _exitNum, uint256 _amount)",
]);

function deployment(): { router: Address; vault: Address } {
  const d = JSON.parse(readFileSync("deployments/arbitrumSepolia.json", "utf8")) as { router?: Address; vault: Address };
  if (!d.router) throw new Error("Router not deployed: run scripts/deploy.ts first");
  return { router: getAddress(d.router), vault: getAddress(d.vault) };
}

/** Returns the key stored under `name` in `file`, creating a fresh one if absent. Never prints keys. */
function ensureKey(file: string, name: string): Hex {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const match = text.match(new RegExp(`^${name}=(0x[0-9a-fA-F]{64})\\s*$`, "m"));
  if (match) return match[1] as Hex;
  const key = generatePrivateKey();
  appendFileSync(file, `${text.endsWith("\n") || text === "" ? "" : "\n"}${name}=${key}\n`);
  return key;
}

async function setup(amount: bigint) {
  const { router } = deployment();
  const seller = privateKeyToAccount(ensureKey(".env", "SELLER_PRIVATE_KEY"));
  const relayer = privateKeyToAccount(ensureKey(WEB_ENV, "RELAYER_PRIVATE_KEY"));
  console.log(`seller  ${seller.address}\nrelayer ${relayer.address}\nrouter  ${router}`);

  // Idempotent and sequential (one pending tx per account at a time): tops up only what is missing.
  const { account, parent, parentWallet, child, childWallet } = getClients();
  const sellerGas = await child.getBalance({ address: seller.address });
  if (sellerGas < SELLER_SXAI) {
    const hash = await childWallet.sendTransaction({ account, chain: xaiTestnet, to: seller.address, value: SELLER_SXAI - sellerGas });
    await child.waitForTransactionReceipt({ hash });
  }
  const sellerUsdg = await child.readContract({
    address: ARBITRUM_SEPOLIA.usdgOnXai, abi: erc20Abi, functionName: "balanceOf", args: [seller.address],
  });
  if (sellerUsdg < amount) {
    const hash = await childWallet.writeContract({
      account, chain: xaiTestnet, address: ARBITRUM_SEPOLIA.usdgOnXai, abi: erc20Abi, functionName: "transfer",
      args: [seller.address, amount - sellerUsdg],
    });
    await child.waitForTransactionReceipt({ hash });
  }
  const relayerGas = await parent.getBalance({ address: relayer.address });
  if (relayerGas < RELAYER_ETH) {
    const hash = await parentWallet.sendTransaction({ account, chain: arbitrumSepolia, to: relayer.address, value: RELAYER_ETH - relayerGas });
    await parent.waitForTransactionReceipt({ hash });
  }
  console.log(`seller on Xai: >= ${formatEther(SELLER_SXAI)} sXAI, >= ${formatUnits(amount, USDG_DECIMALS)} USDG; relayer: >= ${formatEther(RELAYER_ETH)} ETH`);
}

async function start(amount: bigint) {
  const { router, vault } = deployment();
  const seller = privateKeyToAccount(ensureKey(".env", "SELLER_PRIVATE_KEY"));
  const { child } = getClients();
  const wallet = createWalletClient({ account: seller, chain: xaiTestnet, transport: http(XAI_TESTNET.rpcUrl) });

  const withdrawalTx = await wallet.writeContract({
    address: XAI_TESTNET.tokenBridge.childGatewayRouter, abi: childRouterAbi, functionName: "outboundTransfer",
    args: [ARBITRUM_SEPOLIA.usdg, router, amount, "0x"],
  });
  const receipt = await child.waitForTransactionReceipt({ hash: withdrawalTx });
  const [initiated] = parseEventLogs({ abi: withdrawalInitiated, logs: receipt.logs, eventName: "WithdrawalInitiated" });
  if (receipt.status !== "success" || !initiated) throw new Error(`Withdrawal failed: ${withdrawalTx}`);

  const order = {
    gateway: XAI_TESTNET.tokenBridge.parentErc20Gateway,
    exitNum: initiated.args._exitNum,
    buyer: vault,
    minProceeds: (amount * MIN_BPS) / 10_000n - RELAYER_FEE,
    relayerFee: RELAYER_FEE,
    deadline: BigInt(Math.floor(Date.now() / 1000) + ORDER_TTL_SECONDS),
  };
  const signature = await seller.signTypedData({
    domain: routerDomain(router, arbitrumSepolia.id), types: SELL_ORDER_TYPES, primaryType: "SellOrder", message: order,
  });
  const intent = {
    seller: seller.address,
    withdrawalTx,
    order: Object.fromEntries(Object.entries(order).map(([k, v]) => [k, String(v)])),
    signature,
  };
  writeFileSync(INTENT_FILE, `${JSON.stringify(intent, null, 2)}\n`);
  console.log(`withdrawal ${withdrawalTx} (exit #${order.exitNum}) sent to the router; order signed (no gas).`);
  console.log(`Saved ${INTENT_FILE}. Next: node scripts/demo/gaslessExit.ts relay`);
}

async function relay(appUrl: string) {
  const intent = JSON.parse(readFileSync(INTENT_FILE, "utf8")) as { seller: Address; withdrawalTx: Hex; order: unknown; signature: Hex };
  const { parent } = getClients();
  const balances = async () => ({
    eth: await parent.getBalance({ address: intent.seller }),
    usdg: await parent.readContract({ address: ARBITRUM_SEPOLIA.usdg, abi: erc20Abi, functionName: "balanceOf", args: [intent.seller] }),
  });
  const before = await balances();
  console.log(`seller ${intent.seller} on Arbitrum Sepolia: ${formatEther(before.eth)} ETH, ${formatUnits(before.usdg, USDG_DECIMALS)} USDG`);

  for (;;) {
    const res = await fetch(`${appUrl}/api/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ withdrawalTx: intent.withdrawalTx, order: intent.order, signature: intent.signature }),
    });
    const json = (await res.json()) as { status: string; txHash?: Hex; reason?: string; error?: string };
    if (json.status === "settled") {
      const after = await balances();
      console.log(`SETTLED by the relayer: ${json.txHash}`);
      console.log(`seller now: ${formatEther(after.eth)} ETH, ${formatUnits(after.usdg, USDG_DECIMALS)} USDG (+${formatUnits(after.usdg - before.usdg, USDG_DECIMALS)})`);
      return;
    }
    if (json.status !== "waiting") throw new Error(`Relay error (${res.status}): ${json.error}`);
    console.log(`${new Date().toISOString()} waiting: ${json.reason ?? "not yet asserted"}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  if (command === "setup" && arg) return setup(parseUnits(arg, USDG_DECIMALS));
  if (command === "start" && arg) return start(parseUnits(arg, USDG_DECIMALS));
  if (command === "relay") return relay(arg ?? "http://localhost:3000");
  throw new Error("Usage: gaslessExit.ts setup <usdg> | start <usdg> | relay [appUrl]");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
