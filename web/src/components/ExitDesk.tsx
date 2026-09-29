"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { NewWithdrawal } from "@/components/NewWithdrawal";
import { SellTicket } from "@/components/SellTicket";
import { WithdrawalList } from "@/components/WithdrawalList";
import { useWithdrawals, type WithdrawalRow } from "@/hooks/useWithdrawals";

function Panel({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-surface">
      <header className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {meta && <span className="truncate font-mono text-xs text-muted">{meta}</span>}
      </header>
      {children}
    </section>
  );
}

/** Seller workflow: pick a pending Xai withdrawal, see its price and proof, sell it in one signature. */
export function ExitDesk() {
  const { address } = useAccount();
  const withdrawals = useWithdrawals(address);
  const [selectedHash, setSelectedHash] = useState<string>();

  const rows = withdrawals.data?.rows ?? [];
  // Derive the selection from fresh data so status changes (e.g. asserted -> sellable) show immediately.
  const selected: WithdrawalRow | undefined =
    rows.find((r) => r.txHash === selectedHash) ?? rows.find((r) => r.status === "sellable");
  const node = withdrawals.data?.latestNode;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
      <Panel
        title="Your withdrawals · Xai Testnet → Arbitrum Sepolia"
        meta={node ? `latest node #${node.nodeNum} · ${node.sendCount} sends` : undefined}
      >
        {!address && <p className="px-4 py-8 text-center text-sm text-muted">Connect a wallet to see withdrawals.</p>}
        {address && withdrawals.isPending && <p className="px-4 py-8 text-center text-sm text-muted">Reading Xai Testnet…</p>}
        {address && withdrawals.isError && (
          <p className="px-4 py-8 text-center text-sm text-bad">{withdrawals.error.message}</p>
        )}
        {address && withdrawals.data && (
          <WithdrawalList rows={rows} selected={selected} onSelect={(r) => setSelectedHash(r.txHash)} />
        )}
        {address && <NewWithdrawal onStarted={() => withdrawals.refetch()} />}
      </Panel>

      <Panel title="Sell instantly">
        <SellTicket row={selected} />
      </Panel>
    </div>
  );
}

export { Panel };
