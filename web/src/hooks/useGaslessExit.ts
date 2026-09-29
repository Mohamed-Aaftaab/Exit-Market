"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { parseEventLogs, type Hex } from "viem";
import { useAccount, usePublicClient, useSignTypedData, useSwitchChain, useWriteContract } from "wagmi";
import { arbitrumSepolia } from "wagmi/chains";
import { SELL_ORDER_TYPES, routerDomain } from "@shared/relay.ts";
import {
  ARBITRUM_SEPOLIA,
  DEPLOYMENT,
  GASLESS_MIN_BPS,
  RELAYER_FEE,
  XAI_TESTNET,
  childRouterAbi,
  withdrawalInitiatedEvent,
} from "@/lib/contracts";
import { xaiTestnet } from "@/lib/wagmi";

const STORAGE_KEY = "exit-market:gasless-intents";
const POLL_MS = 60_000;
const ORDER_TTL_SECONDS = 24 * 60 * 60;

/** A signed gasless exit waiting to be settled by the relayer. JSON-safe (bigints as strings). */
export interface GaslessIntent {
  withdrawalTx: Hex;
  amount: string;
  order: Record<"gateway" | "exitNum" | "buyer" | "minProceeds" | "relayerFee" | "deadline", string>;
  signature: Hex;
  status: "waiting" | "settled" | "error";
  detail?: string;
  settleTx?: Hex;
}

// Tiny external store over localStorage (per-browser convenience; the relay itself is stateless).
const EMPTY: GaslessIntent[] = [];
let cache: GaslessIntent[] | undefined;
const listeners = new Set<() => void>();

function load(): GaslessIntent[] {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as GaslessIntent[];
  } catch {
    cache = [];
  }
  return cache;
}

function save(intents: GaslessIntent[]) {
  cache = intents;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(intents));
  } catch {
    // Storage unavailable (private mode): intents live for this session only.
  }
  listeners.forEach((notify) => notify());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function relay(intent: GaslessIntent): Promise<GaslessIntent> {
  const res = await fetch("/api/relay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ withdrawalTx: intent.withdrawalTx, order: intent.order, signature: intent.signature }),
  });
  const json = (await res.json()) as { status: string; txHash?: Hex; reason?: string; error?: string };
  if (json.status === "settled") return { ...intent, status: "settled", settleTx: json.txHash, detail: undefined };
  if (json.status === "waiting") return { ...intent, status: "waiting", detail: "Waiting for the next rollup assertion" };
  return { ...intent, status: "error", detail: json.error ?? "Relay failed" };
}

/** Starts gasless exits (withdraw to router + one signature) and keeps polling the relayer until settled. */
export function useGaslessExit() {
  const { address, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();
  const child = usePublicClient({ chainId: xaiTestnet.id });
  const intents = useSyncExternalStore(subscribe, load, () => EMPTY);

  const poll = useCallback(async () => {
    const current = load();
    if (!current.some((i) => i.status !== "settled")) return;
    const next = await Promise.all(current.map((i) => (i.status === "settled" ? i : relay(i).catch(() => i))));
    save(next);
  }, []);

  useEffect(() => {
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  const start = useCallback(
    async (amount: bigint, onStep: (step: string) => void) => {
      const { router, vault } = DEPLOYMENT;
      if (!router || !vault) throw new Error("Gasless exits not configured");
      if (!address || !child) throw new Error("Connect a wallet first");

      if (chainId !== xaiTestnet.id) await switchChainAsync({ chainId: xaiTestnet.id });
      onStep("Confirm the withdrawal on Xai Testnet…");
      const withdrawalTx = await writeContractAsync({
        chainId: xaiTestnet.id,
        address: XAI_TESTNET.tokenBridge.childGatewayRouter,
        abi: childRouterAbi,
        functionName: "outboundTransfer",
        args: [ARBITRUM_SEPOLIA.usdg, router, amount, "0x"],
      });
      const receipt = await child.waitForTransactionReceipt({ hash: withdrawalTx, timeout: 120_000 });
      const [initiated] = parseEventLogs({ abi: [withdrawalInitiatedEvent], logs: receipt.logs });
      if (!initiated) throw new Error("Withdrawal event not found");

      const order = {
        gateway: XAI_TESTNET.tokenBridge.parentErc20Gateway,
        exitNum: initiated.args._exitNum,
        buyer: vault,
        minProceeds: (amount * GASLESS_MIN_BPS) / 10_000n - RELAYER_FEE,
        relayerFee: RELAYER_FEE,
        deadline: BigInt(Math.floor(Date.now() / 1000) + ORDER_TTL_SECONDS),
      };
      // Signing is free, but wallets require the domain's chain to be active.
      await switchChainAsync({ chainId: arbitrumSepolia.id });
      onStep("Sign the sell order (free, no gas)…");
      const signature = await signTypedDataAsync({
        domain: routerDomain(router, arbitrumSepolia.id),
        types: SELL_ORDER_TYPES,
        primaryType: "SellOrder",
        message: order,
      });

      const intent: GaslessIntent = {
        withdrawalTx,
        amount: amount.toString(),
        order: Object.fromEntries(Object.entries(order).map(([k, v]) => [k, String(v)])) as GaslessIntent["order"],
        signature,
        status: "waiting",
        detail: "Waiting for the next rollup assertion",
      };
      save([intent, ...load()]);
      return withdrawalTx;
    },
    [address, chainId, child, signTypedDataAsync, switchChainAsync, writeContractAsync],
  );

  return { intents, start, refresh: poll };
}
