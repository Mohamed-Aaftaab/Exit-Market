"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";
import styles from "@/components/site/site.module.css";
import { shortHex } from "@/lib/format";

/** The header's dark pill on the desk: connects an injected wallet, or shows the connected address. */
export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

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

  const injected = connectors[0];
  return (
    <button
      type="button"
      disabled={!injected || isPending}
      onClick={() => injected && connect({ connector: injected })}
      className={`${styles.pill} disabled:opacity-50`}
    >
      {isPending ? "Connecting…" : "Connect wallet"}
    </button>
  );
}
