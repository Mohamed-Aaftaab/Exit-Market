"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { ARBITRUM_SEPOLIA, XAI_TESTNET, childRouterAbi } from "@/lib/contracts";
import { errorText, parseUsdgInput } from "@/lib/format";
import { xaiTestnet } from "@/lib/wagmi";

/** Starts a standard-bridge USDG withdrawal on Xai Testnet (the thing that normally locks for days). */
export function NewWithdrawal({ onStarted }: { onStarted: () => void }) {
  const { address, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const child = usePublicClient({ chainId: xaiTestnet.id });
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<string>();
  const [isBusy, setIsBusy] = useState(false);

  async function withdraw() {
    if (!address || !child || isBusy) return;
    const value = parseUsdgInput(amount);
    if (value === undefined) return setStatus("Enter a USDG amount with at most 6 decimals");

    setIsBusy(true);
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
      await child.waitForTransactionReceipt({ hash, timeout: 120_000 });
      setStatus("Withdrawal started. It becomes sellable after the next rollup assertion (~15 min).");
      setAmount("");
      onStarted();
    } catch (err) {
      setStatus(errorText(err));
    } finally {
      setIsBusy(false);
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
          disabled={isBusy}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm text-ink"
        />
        <button
          type="button"
          onClick={withdraw}
          disabled={!address || isBusy}
          aria-busy={isBusy}
          className="rounded-md border border-line bg-surface-2 px-4 py-2 text-sm font-medium text-ink hover:bg-bg disabled:opacity-50"
        >
          {isBusy ? "Withdrawing…" : "Withdraw"}
        </button>
      </div>
      {status && (
        <p role="status" className="text-xs text-muted">
          {status}
        </p>
      )}
    </div>
  );
}
