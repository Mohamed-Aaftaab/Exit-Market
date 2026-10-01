"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { parseEventLogs, type Hex } from "viem";
import { useAccount, usePublicClient, useSignTypedData, useSwitchChain, useWriteContract } from "wagmi";
import { arbitrumSepolia } from "wagmi/chains";
import { SELL_ORDER_TYPES, routerDomain, type SellOrder } from "@shared/relay.ts";
import {
  ARBITRUM_SEPOLIA,
  DEPLOYMENT,
  GASLESS_MIN_BPS,
  RELAYER_FEE,
  XAI_TESTNET,
  childRouterAbi,
  vaultAbi,
  withdrawalInitiatedEvent,
} from "@/lib/contracts";
import { fastExitMinimum, vaultSizeRefusal } from "@/lib/exitLimits";
import { usdg } from "@/lib/format";
import {
  applyRelayResponse,
  mergeRelayed,
  needsRelay,
  upsertIntent,
  type GaslessIntent,
  type RelayResponse,
} from "@/lib/intentStore";
import { xaiTestnet } from "@/lib/wagmi";

export type { GaslessIntent } from "@/lib/intentStore";

const STORAGE_KEY = "exit-market:gasless-intents:v2";
const POLL_MS = 60_000;
const ORDER_TTL_SECONDS = 24 * 60 * 60;
const BPS = 10_000n;

// A small external store over localStorage, shared by every component and kept in sync across tabs.
const EMPTY: GaslessIntent[] = [];
let cache: GaslessIntent[] | undefined;
const listeners = new Set<() => void>();

function read(): GaslessIntent[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as GaslessIntent[]) : [];
  } catch {
    return [];
  }
}

function load(): GaslessIntent[] {
  cache ??= read();
  return cache;
}

/** Applies `change` to the latest stored list (never to a stale snapshot) and notifies subscribers. */
function update(change: (current: GaslessIntent[]) => GaslessIntent[]) {
  cache = change(read());
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Storage unavailable (private mode): intents live for this page only.
  }
  listeners.forEach((notify) => notify());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    cache = undefined; // another tab changed the list
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

async function relay(intent: GaslessIntent): Promise<GaslessIntent> {
  let response: RelayResponse | undefined;
  try {
    const res = await fetch("/api/relay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ withdrawalTx: intent.withdrawalTx, order: intent.order, signature: intent.signature }),
    });
    response = { httpStatus: res.status, body: (await res.json().catch(() => undefined)) as RelayResponse["body"] };
  } catch {
    response = undefined; // offline or the function timed out: retried on the next poll
  }
  return applyRelayResponse(intent, response, Date.now());
}

function serialize(order: SellOrder): GaslessIntent["order"] {
  return Object.fromEntries(Object.entries(order).map(([k, v]) => [k, String(v)])) as GaslessIntent["order"];
}

/** This browser's gasless exits, read-only (no relayer polling): for components that only show their state. */
export function useGaslessIntents(): GaslessIntent[] {
  return useSyncExternalStore(subscribe, load, () => EMPTY);
}

/** Starts gasless exits (withdraw to router + one signature) and keeps polling the relayer until each is final. */
export function useGaslessExit() {
  const { address, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();
  const child = usePublicClient({ chainId: xaiTestnet.id });
  const parent = usePublicClient({ chainId: arbitrumSepolia.id });
  const intents = useGaslessIntents();

  const poll = useCallback(async () => {
    const due = load().filter(needsRelay);
    if (due.length === 0) return;
    const relayed = await Promise.all(due.map(relay));
    update((current) => mergeRelayed(current, relayed));
  }, []);

  useEffect(() => {
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  /** Signs the order for an intent that is already withdrawn to the router (also used to resume a rejected signature). */
  const sign = useCallback(
    async (intent: GaslessIntent, onStep: (step: string) => void) => {
      const { router, vault } = DEPLOYMENT;
      if (!router || !vault) throw new Error("Gasless exits not configured");
      if (!address) throw new Error("Connect a wallet first");
      // The router only accepts the withdrawing wallet's signature: another wallet's would fail at settlement.
      if (intent.seller && intent.seller.toLowerCase() !== address.toLowerCase()) {
        throw new Error(`This fast exit belongs to ${intent.seller}: connect that wallet to sign it`);
      }
      const amount = BigInt(intent.amount);
      const order: SellOrder = {
        gateway: XAI_TESTNET.tokenBridge.parentErc20Gateway,
        exitNum: BigInt(intent.exitNum),
        buyer: vault,
        minProceeds: (amount * GASLESS_MIN_BPS) / BPS - RELAYER_FEE,
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
      const signed: GaslessIntent = {
        ...intent,
        order: serialize(order),
        signature,
        status: "waiting",
        detail: "Waiting for the next rollup node",
        updatedAt: Date.now(),
      };
      update((current) => upsertIntent(current, signed));
      void poll();
    },
    [address, poll, signTypedDataAsync, switchChainAsync],
  );

  const start = useCallback(
    async (amount: bigint, onStep: (step: string) => void) => {
      const { router, vault } = DEPLOYMENT;
      if (!router || !vault) throw new Error("Gasless exits not configured");
      if (!address || !child || !parent) throw new Error("Connect a wallet first");
      // Checked BEFORE the irreversible withdrawal: an exit the vault cannot buy would sit in the router, and the
      // seller of a fast exit holds no gas on Arbitrum to take it back.
      const [minExit, maxExit] = await Promise.all([
        parent.readContract({ address: vault, abi: vaultAbi, functionName: "minExitAmount" }),
        parent.readContract({ address: vault, abi: vaultAbi, functionName: "maxExitAmount" }),
      ]);
      const minimum = fastExitMinimum(minExit);
      if (amount < minimum) throw new Error(`Fast exits start at ${usdg(minimum)} USDG (the vault's minimum)`);
      const tooLarge = vaultSizeRefusal(amount, { minExit, maxExit });
      if (tooLarge) throw new Error(tooLarge);

      if (chainId !== xaiTestnet.id) await switchChainAsync({ chainId: xaiTestnet.id });
      onStep("Confirm the withdrawal on Xai Testnet…");
      const withdrawalTx: Hex = await writeContractAsync({
        chainId: xaiTestnet.id,
        address: XAI_TESTNET.tokenBridge.childGatewayRouter,
        abi: childRouterAbi,
        functionName: "outboundTransfer",
        args: [ARBITRUM_SEPOLIA.usdg, router, amount, "0x"],
      });
      const receipt = await child.waitForTransactionReceipt({ hash: withdrawalTx, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error("The withdrawal reverted on Xai Testnet");
      const [initiated] = parseEventLogs({ abi: [withdrawalInitiatedEvent], logs: receipt.logs });
      if (!initiated) throw new Error("Withdrawal event not found");

      // Persist before asking for the signature: if it is rejected, the exit is not lost and can be signed later.
      const unsigned: GaslessIntent = {
        withdrawalTx,
        seller: address,
        amount: amount.toString(),
        exitNum: initiated.args._exitNum.toString(),
        status: "unsigned",
        detail: "Withdrawn to the router; sign the order to sell it",
        updatedAt: Date.now(),
      };
      update((current) => upsertIntent(current, unsigned));
      await sign(unsigned, onStep);
      return withdrawalTx;
    },
    [address, chainId, child, parent, sign, switchChainAsync, writeContractAsync],
  );

  return { intents, start, sign, refresh: poll };
}
