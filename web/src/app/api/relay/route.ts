import {
  TransactionReceiptNotFoundError,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { InvalidWithdrawalError } from "@shared/exitProof.ts";
import { SettlementRevertedError, transientSettlementWait, trySettle } from "@shared/relay.ts";
import { ARBITRUM_SEPOLIA, XAI_TESTNET } from "@shared/networks.ts";
import { DEPLOYMENT } from "@/lib/contracts";
import { allowRequest, clientKeyOf, parseRelayRequest, runExclusive, type RelayRequest } from "@/lib/relayGuard";

// Server-only relayer: settles gasless exits on the user's behalf and earns the order's relayer fee.
const MAX_BODY_BYTES = 8_192;

/** A settlement waits for one Arbitrum Sepolia receipt (seconds); cap the function well above that. */
export const maxDuration = 60;

function bad(message: string, status = 400) {
  return Response.json({ status: "error", error: message }, { status });
}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new RangeError("Request too large");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new RangeError("Request too large");
  return JSON.parse(text);
}

async function settle(key: Hex, router: string, req: RelayRequest) {
  const account = privateKeyToAccount(key);
  const parent = createPublicClient({ chain: arbitrumSepolia, transport: http(ARBITRUM_SEPOLIA.rpcUrl) });
  const child = createPublicClient({ transport: http(XAI_TESTNET.rpcUrl) });
  const wallet = createWalletClient({ account, chain: arbitrumSepolia, transport: http(ARBITRUM_SEPOLIA.rpcUrl) });
  return trySettle({
    parent,
    child,
    wallet,
    router: getAddress(router),
    rollup: XAI_TESTNET.ethBridge.rollup,
    childGateway: XAI_TESTNET.tokenBridge.childErc20Gateway,
    ...req,
  });
}

/** POST { withdrawalTx, order, signature } -> { status: "waiting" | "settled", ... } */
export async function POST(request: Request) {
  const key = process.env.RELAYER_PRIVATE_KEY?.trim();
  const router = DEPLOYMENT.router;
  if (!key || !router || !DEPLOYMENT.vault) return bad("Relayer not configured", 503);
  if (!allowRequest(clientKeyOf(request))) return bad("Too many requests", 429);

  let body: unknown;
  try {
    body = await readJson(request);
  } catch (err) {
    return err instanceof RangeError ? bad(err.message, 413) : bad("Invalid JSON");
  }
  const parsed = parseRelayRequest(body, {
    gateway: XAI_TESTNET.tokenBridge.parentErc20Gateway,
    buyer: DEPLOYMENT.vault,
  });
  if (!parsed.ok) return bad(parsed.error);

  try {
    const result = await runExclusive(parsed.value.withdrawalTx, () => settle(key as Hex, router, parsed.value));
    if (!result) return Response.json({ status: "waiting", reason: "Settlement already in progress" }, { status: 202 });
    return Response.json(result, { status: result.status === "waiting" ? 202 : 200 });
  } catch (err) {
    // The request itself is at fault (bad signature, expired, below the seller's minimum, not a router
    // withdrawal, unknown tx): say exactly why. The client stops retrying these.
    if (err instanceof SettlementRevertedError) {
      // Some reverts clear up by themselves (vault liquidity, a disputed or unconfirmed node): keep the order waiting.
      const wait = transientSettlementWait(err.reason);
      if (wait) return Response.json({ status: "waiting", reason: wait }, { status: 202 });
      return bad(err.reason, 422);
    }
    if (err instanceof InvalidWithdrawalError) return bad(err.message, 422);
    if (err instanceof TransactionReceiptNotFoundError) return bad("Withdrawal transaction not found on Xai Testnet", 422);
    // Anything else is on the relayer's side (RPC down, out of gas money): retryable, and not the user's fault.
    console.error("relay failed", err);
    return bad("Relayer temporarily unavailable, retrying automatically", 502);
  }
}
