"use client";

import { useState } from "react";
import { parseUnits } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { ARBITRUM_SEPOLIA, USDG_DECIMALS, XAI_TESTNET, childRouterAbi } from "@/lib/contracts";
import { xaiTestnet } from "@/lib/wagmi";

/** Starts a standard-bridge USDG withdrawal on Xai Testnet (the thing that normally locks for days). */
export function NewWithdrawal({ onStarted }: { onStarted: () => void }) {
  const { address, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const child = usePublicClient({ chainId: xaiTestnet.id });
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<string>();

  async function withdraw() {
    if (!address || !child) return;
    const value = parseUnits(amount || "0", USDG_DECIMALS);
    if (value <= 0n) return setStatus("Enter an amount");
    try {
      if (chainId !== xaiTestnet.id) await switchChainAsync({ chainId: xaiTestnet.id });
      setStatus("Confirm the withdrawal on Xai Testnet…");
      const hash = await writeContractAsync({
        chainId: xaiTestnet.id,
        address: XAI_TESTNET.tokenBridge.childGatewayRouter,
        abi: childRouterAbi,
        functionName: "outboundTransfer",
        args: [ARBITRUM_SEPOLIA.usdg, address, value, "0x"],
      });
      await child.waitForTransactionReceipt({ hash });
      setStatus("Withdrawal started. It becomes sellable after the next rollup assertion (~15 min).");
      setAmount("");
      onStarted();
    } catch (err) {
      setStatus(err instanceof Error ? err.message.split("\n")[0] : "Withdrawal failed");
    }
  }

  return (
    <div className="space-y-2 border-t border-line p-4">
      <div className="flex gap-2">
        <label className="sr-only" htmlFor="withdraw-amount">
          USDG to withdraw from Xai
        </label>
        <input
          id="withdraw-amount"
          inputMode="decimal"
          placeholder="USDG to withdraw from Xai"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm text-ink"
        />
        <button
          type="button"
          onClick={withdraw}
          disabled={!address}
          className="rounded-md border border-line bg-surface-2 px-4 py-2 text-sm font-medium text-ink hover:bg-bg disabled:opacity-50"
        >
          Withdraw
        </button>
      </div>
      {status && <p className="text-xs text-muted">{status}</p>}
    </div>
  );
}
