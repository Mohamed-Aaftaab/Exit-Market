"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { useGaslessExit, type GaslessIntent } from "@/hooks/useGaslessExit";
import { ARBITRUM_SEPOLIA, DEPLOYMENT, XAI_TESTNET, childRouterAbi } from "@/lib/contracts";
import { errorText, parseUsdgInput, usdg } from "@/lib/format";
import { xaiTestnet } from "@/lib/wagmi";

/** One gasless exit's state: a receipt link, a "sign" action, or the relayer's latest word. */
function IntentState({ intent, onSign, isBusy }: { intent: GaslessIntent; onSign: () => void; isBusy: boolean }) {
  if (intent.status === "settled" && intent.settleTx) {
    return (
      <a className="text-ok underline" href={`https://sepolia.arbiscan.io/tx/${intent.settleTx}`} target="_blank" rel="noopener noreferrer">
        settled ↗
      </a>
    );
  }
  if (intent.status === "unsigned") {
    return (
      <button type="button" className="text-warn underline disabled:opacity-50" onClick={onSign} disabled={isBusy}>
        sign order
      </button>
    );
  }
  if (intent.status === "done-elsewhere") return <span className="text-muted">settled elsewhere</span>;
  if (intent.status === "failed") return <span className="text-bad">{intent.detail}</span>;
  return (
    <span className="text-warn" title={intent.detail}>
      settling…
    </span>
  );
}

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
    const receipt = await child.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error("The withdrawal reverted on Xai Testnet");
    setStatus("Withdrawal started. It becomes sellable after the next rollup assertion (~15 min).");
  }

  async function signLater(intent: GaslessIntent) {
    if (isBusy) return;
    setIsBusy(true);
    try {
      await gasless.sign(intent, setStatus);
      setStatus("Signed. The relayer sells it to the vault as soon as it is asserted (~15 min).");
    } catch (err) {
      setStatus(errorText(err));
    } finally {
      setIsBusy(false);
    }
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
          className="min-w-0 flex-1 rounded-full border border-line bg-surface-2 px-4 py-2.5 font-mono text-sm text-ink placeholder:text-muted focus:border-white/40 focus:outline-none"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!address || isBusy}
          aria-busy={isBusy}
          className="btn-primary"
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
              <span className="text-ink">
                {usdg(BigInt(i.amount))} USDG · exit #{i.exitNum}
              </span>
              <IntentState intent={i} onSign={() => void signLater(i)} isBusy={isBusy} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
