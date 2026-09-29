"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";
import { shortHex } from "@/lib/format";

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <button
        type="button"
        onClick={() => disconnect()}
        className="rounded-md border border-line bg-surface px-3 py-1.5 font-mono text-sm text-ink hover:bg-surface-2"
        title="Disconnect"
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
      className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
    >
      {isPending ? "Connecting…" : "Connect wallet"}
    </button>
  );
}
