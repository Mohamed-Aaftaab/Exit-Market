import { createPublicClient, createWalletClient, getAddress, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { trySettle } from "@shared/relay.ts";
import { XAI_TESTNET } from "@shared/networks.ts";
import { DEPLOYMENT } from "@/lib/contracts";
import { allowRequest, parseRelayRequest, runExclusive, type RelayRequest } from "@/lib/relayGuard";

// Server-only relayer: settles gasless exits on the user's behalf and earns the order's relayer fee.
const ARB_SEPOLIA_RPC = "https://sepolia-rollup.arbitrum.io/rpc";
const MAX_BODY_BYTES = 8_192;

function bad(message: string, status = 400) {
  return Response.json({ status: "error", error: message }, { status });
}

function clientKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
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
  const parent = createPublicClient({ chain: arbitrumSepolia, transport: http(ARB_SEPOLIA_RPC) });
  const child = createPublicClient({ transport: http(XAI_TESTNET.rpcUrl) });
  const wallet = createWalletClient({ account, chain: arbitrumSepolia, transport: http(ARB_SEPOLIA_RPC) });
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
  const key = process.env.RELAYER_PRIVATE_KEY;
  const router = process.env.NEXT_PUBLIC_EXIT_INTENT_ROUTER;
  if (!key || !router || !DEPLOYMENT.vault) return bad("Relayer not configured", 503);
  if (!allowRequest(clientKey(request))) return bad("Too many requests", 429);

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
    const message = err instanceof Error ? (err as { shortMessage?: string }).shortMessage ?? err.message : "Relay failed";
    return bad(message.split("\n")[0], 422);
  }
}
