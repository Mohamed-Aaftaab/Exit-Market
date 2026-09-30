"use client";

import { useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import styles from "@/components/site/site.module.css";
import { errorText, shortHex } from "@/lib/format";

const NO_WALLET = "No browser wallet found. Install MetaMask or Rabby, then reload.";

/** The header's dark pill on the desk: connects an injected wallet, or shows the connected address. */
export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connectAsync, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const [problem, setProblem] = useState<string>();

  if (isConnected && address) {
    return (
      <button
        type="button"
        onClick={() => disconnect()}
        className={`${styles.pill} font-mono`}
        title="Disconnect"
        aria-label={`Disconnect wallet ${address}`}
      >
        {shortHex(address)}
      </button>
    );
  }

  async function connect() {
    setProblem(undefined);
    const injected = connectors[0];
    // The injected connector exists even without a wallet; ask it whether a provider is really there.
    if (!injected || !(await injected.getProvider().catch(() => undefined))) return setProblem(NO_WALLET);
    try {
      await connectAsync({ connector: injected });
    } catch (err) {
      setProblem(errorText(err));
    }
  }

  return (
    <span className="relative inline-flex">
      <button type="button" disabled={isPending} onClick={() => void connect()} className={`${styles.pill} disabled:opacity-50`}>
        {isPending ? "Connecting…" : "Connect wallet"}
      </button>
      {problem && (
        <span
          role="alert"
          className="absolute right-0 top-full mt-2 w-64 rounded-2xl border border-line bg-surface px-3 py-2 text-xs text-soft shadow-lg"
        >
          {problem}
        </span>
      )}
    </span>
  );
}
