import { createPublicClient, createWalletClient, getAddress, http, isHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { trySettle, type SellOrder } from "@shared/relay.ts";
import { XAI_TESTNET } from "@shared/networks.ts";

// Server-only relayer: settles gasless exits on the user's behalf and earns the order's relayer fee.
const ARB_SEPOLIA_RPC = "https://sepolia-rollup.arbitrum.io/rpc";
const MAX_BODY_BYTES = 8_192;

function bad(message: string, status = 400) {
  return Response.json({ status: "error", error: message }, { status });
}

function parseOrder(raw: unknown): SellOrder | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  try {
    return {
      gateway: getAddress(String(o.gateway)),
      exitNum: BigInt(String(o.exitNum)),
      buyer: getAddress(String(o.buyer)),
      minProceeds: BigInt(String(o.minProceeds)),
      relayerFee: BigInt(String(o.relayerFee)),
      deadline: BigInt(String(o.deadline)),
    };
  } catch {
    return undefined;
  }
}

/** POST { withdrawalTx, order, signature } -> { status: "waiting" | "settled", ... } */
export async function POST(request: Request) {
  const key = process.env.RELAYER_PRIVATE_KEY;
  const router = process.env.NEXT_PUBLIC_EXIT_INTENT_ROUTER;
  if (!key || !router) return bad("Relayer not configured", 503);

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return bad("Request too large", 413);
  let body: { withdrawalTx?: unknown; order?: unknown; signature?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return bad("Invalid JSON");
  }

  const order = parseOrder(body.order);
  if (!order) return bad("Invalid order");
  if (!isHex(body.withdrawalTx) || body.withdrawalTx.length !== 66) return bad("Invalid withdrawalTx");
  if (!isHex(body.signature) || body.signature.length !== 132) return bad("Invalid signature");
  if (order.gateway !== XAI_TESTNET.tokenBridge.parentErc20Gateway) return bad("Unsupported gateway");
  if (order.deadline < BigInt(Math.floor(Date.now() / 1000))) return bad("Order expired");

  const account = privateKeyToAccount(key as Hex);
  const parent = createPublicClient({ chain: arbitrumSepolia, transport: http(ARB_SEPOLIA_RPC) });
  const child = createPublicClient({ transport: http(XAI_TESTNET.rpcUrl) });
  const wallet = createWalletClient({ account, chain: arbitrumSepolia, transport: http(ARB_SEPOLIA_RPC) });

  try {
    const result = await trySettle({
      parent,
      child,
      wallet,
      router: getAddress(router),
      rollup: XAI_TESTNET.ethBridge.rollup,
      childGateway: XAI_TESTNET.tokenBridge.childErc20Gateway,
      withdrawalTx: body.withdrawalTx as Hex,
      order,
      signature: body.signature as Hex,
    });
    return Response.json(result, { status: result.status === "waiting" ? 202 : 200 });
  } catch (err) {
    const message = err instanceof Error ? (err as { shortMessage?: string }).shortMessage ?? err.message : "Relay failed";
    return bad(message.split("\n")[0], 422);
  }
}
