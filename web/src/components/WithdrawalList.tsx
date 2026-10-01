"use client";

import type { WithdrawalRow, WithdrawalStatus } from "@/hooks/useWithdrawals";
import { usdg } from "@/lib/format";

const STATUS: Record<WithdrawalStatus, { label: string; className: string }> = {
  "awaiting-assertion": { label: "Awaiting assertion", className: "bg-warn-soft text-warn" },
  sellable: { label: "Sellable now", className: "bg-ok-soft text-ok" },
  gasless: { label: "Fast exit · settling", className: "bg-warn-soft text-warn" },
  listed: { label: "Listed", className: "bg-surface-2 text-ink" },
  transferred: { label: "Sold", className: "bg-surface-2 text-muted" },
  claimed: { label: "Claimed", className: "bg-surface-2 text-muted" },
};

type Props = {
  rows: WithdrawalRow[];
  selected: WithdrawalRow | undefined;
  onSelect: (row: WithdrawalRow) => void;
};

export function WithdrawalList({ rows, selected, onSelect }: Props) {
  if (rows.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-sm text-muted">
        No USDG withdrawals from Xai Testnet yet. Start one below.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-line" aria-label="Your withdrawals">
      {rows.map((row) => {
        const status = STATUS[row.status];
        const isSelected = selected?.txHash === row.txHash;
        return (
          <li key={row.txHash}>
            <button
              type="button"
              onClick={() => onSelect(row)}
              aria-pressed={isSelected}
              className={`grid w-full grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 text-left hover:bg-surface-2 ${
                isSelected ? "bg-surface-2" : ""
              }`}
            >
              <span className="min-w-0">
                <span className="block font-mono text-base text-ink">{usdg(row.amount)} USDG</span>
                <span className="block truncate font-mono text-xs text-muted">
                  exit #{row.exitNum.toString()} · outbox #{row.position.toString()}
                </span>
              </span>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${status.className}`}>{status.label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
