"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { useGaslessExit } from "@/hooks/useGaslessExit";
import { ARBITRUM_SEPOLIA, DEPLOYMENT, XAI_TESTNET, childRouterAbi } from "@/lib/contracts";
import { errorText, parseUsdgInput, usdg } from "@/lib/format";
import { xaiTestnet } from "@/lib/wagmi";

/**
 * Starts a USDG withdrawal on Xai Testnet. Fast exit (default): withdraw to the intent router and sign one
 * order; a relayer sells it to the vault once asserted, so no gas is needed on Arbitrum. Standard: withdraw
 * to yourself and sell it manually from the list.
 */
export function NewWithdrawal({ onStarted }: { onStarted: () => void }) {
  const { address, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const child = usePublicClient({ chainId: xaiTestnet.id });
  const gasless = useGaslessExit();
  const canGasless = Boolean(DEPLOYMENT.router);
  const [isFast, setIsFast] = useState(canGasless);
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<string>();
  const [isBusy, setIsBusy] = useState(false);

  async function standardWithdraw(value: bigint) {
    if (!address || !child) return;
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
  }

  async function submit() {
    if (!address || isBusy) return;
    const value = parseUsdgInput(amount);
    if (value === undefined) return setStatus("Enter a USDG amount with at most 6 decimals");

    setIsBusy(true);
    try {
      if (isFast) {
        await gasless.start(value, setStatus);
        setStatus("Signed. The relayer sells it to the vault as soon as it is asserted (~15 min); USDG lands in your wallet.");
      } else {
        await standardWithdraw(value);
      }
      setAmount("");
      onStarted();
    } catch (err) {
      setStatus(errorText(err));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-line p-4">
      {canGasless && (
        <fieldset className="flex gap-4 text-sm" disabled={isBusy}>
          <legend className="sr-only">Withdrawal mode</legend>
          <label className="flex items-center gap-2 text-ink">
            <input type="radio" name="mode" checked={isFast} onChange={() => setIsFast(true)} />
            Fast exit <span className="text-muted">(one signature, no gas on Arbitrum)</span>
          </label>
          <label className="flex items-center gap-2 text-ink">
            <input type="radio" name="mode" checked={!isFast} onChange={() => setIsFast(false)} />
            Standard
          </label>
        </fieldset>
      )}
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
          onClick={submit}
          disabled={!address || isBusy}
          aria-busy={isBusy}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
        >
          {isBusy ? "Working…" : isFast ? "Fast exit" : "Withdraw"}
        </button>
      </div>
      {status && (
        <p role="status" className="text-xs text-muted">
          {status}
        </p>
      )}
      {gasless.intents.length > 0 && (
        <ul className="space-y-1 text-xs" aria-label="Gasless exits">
          {gasless.intents.slice(0, 5).map((i) => (
            <li key={i.withdrawalTx} className="flex items-center justify-between gap-3 font-mono">
              <span className="text-ink">{usdg(BigInt(i.amount))} USDG · exit #{i.order.exitNum}</span>
              {i.status === "settled" && i.settleTx ? (
                <a
                  className="text-ok underline"
                  href={`https://sepolia.arbiscan.io/tx/${i.settleTx}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  settled ↗
                </a>
              ) : (
                <span className={i.status === "error" ? "text-bad" : "text-warn"} title={i.detail}>
                  {i.status === "error" ? i.detail : "settling…"}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
