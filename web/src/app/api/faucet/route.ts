import { createPublicClient, createWalletClient, erc20Abi, getAbiItem, http, type Address, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getLogsChunked } from "@shared/logScan.ts";
import { ARBITRUM_SEPOLIA, XAI_TESTNET, xaiTestnet } from "@shared/networks.ts";
import { XAI_LOG_CHUNK } from "@/lib/explorer/constants";
import { FAUCET_MAX_PER_WINDOW, FAUCET_WINDOW_MS, parseFaucetRequest, planDrip } from "@/lib/faucet";
import { clientKeyOf, createExclusiveRunner, createRateLimiter } from "@/lib/relayGuard";

// Server-only test faucet for Xai Testnet: USDG to withdraw plus a little sXAI for gas, so a judge with an empty
// wallet can try the whole flow. One drip per address (checked against the faucet's own transfers on-chain).
export const maxDuration = 60;

const TRANSFER = getAbiItem({ abi: erc20Abi, name: "Transfer" });
const limiter = createRateLimiter(FAUCET_WINDOW_MS, FAUCET_MAX_PER_WINDOW);
const runExclusive = createExclusiveRunner();

function bad(message: string, status = 400) {
  return Response.json({ status: "error", error: message }, { status });
}

function parseBlock(value: string | undefined): bigint | undefined {
  return value && /^\d+$/.test(value) ? BigInt(value) : undefined;
}

async function drip(key: Hex, fromBlock: bigint, to: Address) {
  const account = privateKeyToAccount(key);
  const transport = http(XAI_TESTNET.rpcUrl);
  const child = createPublicClient({ chain: xaiTestnet, transport });
  const wallet = createWalletClient({ account, chain: xaiTestnet, transport });
  const usdg = ARBITRUM_SEPOLIA.usdgOnXai;

  const head = await child.getBlockNumber();
  const [previous, recipientGas, faucetUsdg, faucetGas] = await Promise.all([
    getLogsChunked(
      (from, toBlock) => child.getLogs({ address: usdg, event: TRANSFER, args: { from: account.address, to }, fromBlock: from, toBlock }),
      fromBlock,
      head,
      XAI_LOG_CHUNK,
    ),
    child.getBalance({ address: to }),
    child.readContract({ address: usdg, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    child.getBalance({ address: account.address }),
  ]);
  const plan = planDrip({ alreadyFunded: previous.logs.length > 0, recipientGas, faucetUsdg, faucetGas });
  if (!plan.ok) return plan;

  // Gas first: the USDG transfer is what marks an address as funded, so if either step fails the address can retry
  // and is never left marked funded without the gas to use the USDG (a retry sends no more gas than it lacks).
  let gasTx: Hash | undefined;
  if (plan.gas > 0n) {
    gasTx = await wallet.sendTransaction({ to, value: plan.gas });
    if ((await child.waitForTransactionReceipt({ hash: gasTx })).status !== "success") throw new Error(`Gas transfer reverted: ${gasTx}`);
  }
  const usdgTx = await wallet.writeContract({ address: usdg, abi: erc20Abi, functionName: "transfer", args: [to, plan.usdg] });
  if ((await child.waitForTransactionReceipt({ hash: usdgTx })).status !== "success") throw new Error(`USDG transfer reverted: ${usdgTx}`);
  return { ok: true as const, usdg: plan.usdg.toString(), gas: plan.gas.toString(), usdgTx, gasTx };
}

/** POST { address } -> { status: "funded", usdgTx, gasTx? } on Xai Testnet. */
export async function POST(request: Request) {
  // Trimmed: a value pasted into a dashboard or piped into a CLI often carries a trailing newline.
  const key = process.env.FAUCET_PRIVATE_KEY?.trim();
  const fromBlock = parseBlock(process.env.FAUCET_FROM_BLOCK?.trim());
  if (!key || fromBlock === undefined) return bad("Test faucet not configured", 503);
  if (!limiter.allow(clientKeyOf(request))) return bad("Too many requests from this address, try again later", 429);

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 1_024) return bad("Request too large", 413);
    body = JSON.parse(text);
  } catch {
    return bad("Invalid JSON");
  }
  const parsed = parseFaucetRequest(body);
  if (!parsed.ok) return bad(parsed.error);

  try {
    // One drip at a time: the single faucet account must not race its own nonce, and a repeated click waits.
    const result = await runExclusive(parsed.address, () => drip(key as Hex, fromBlock, parsed.address));
    if (!result) return bad("A drip to this address is already in progress", 409);
    if (!result.ok) return bad(result.error, result.status);
    const { usdg, gas, usdgTx, gasTx } = result;
    return Response.json({ status: "funded", usdg, gas, usdgTx, gasTx });
  } catch (err) {
    console.error("faucet failed", err);
    return bad("Faucet temporarily unavailable", 502);
  }
}
