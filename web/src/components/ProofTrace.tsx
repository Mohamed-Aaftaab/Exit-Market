"use client";

import type { PreparedSale } from "@/hooks/useExitSale";
import { shortHex } from "@/lib/format";

type Step = { label: string; detail: string; ok: boolean };

/** A confirmed root needs one check; a pending one needs the node's commitment and an undisputed chain. */
function rootSteps(sale: PreparedSale): Step[] {
  const p = sale.withdrawal.proof;
  if (!sale.checks.rootPending) {
    return [{ label: "Root confirmed in the Outbox", detail: `Outbox.roots(${shortHex(p.sendRoot)}) is set: nothing left to wait for`, ok: sale.checks.rootValid }];
  }
  return [
    {
      label: `Root committed by pending node #${p.nodeNum}`,
      detail: `confirmData = keccak(blockHash, sendRoot) on the rollup`,
      ok: sale.checks.nodeCommitsRoot,
    },
    {
      label: "No rival on the pending chain",
      detail: `verifier walks node #${p.nodeNum} back to the latest confirmed node: no level is disputed`,
      ok: sale.checks.rootValid,
    },
  ];
}

function stepsOf(sale: PreparedSale): Step[] {
  const p = sale.withdrawal.proof;
  return [
    {
      label: "You still own this exit",
      detail: "gateway.getExternalCall → your address",
      ok: sale.checks.ownerIsSeller,
    },
    {
      label: "Withdrawal is in the send tree",
      detail: `leaf ${shortHex(sale.record.itemHash)} at #${p.index} · ${p.merkleProof.length}-step proof → root ${shortHex(p.sendRoot)}`,
      ok: sale.checks.minimalPath,
    },
    ...rootSteps(sale),
    {
      label: "Not yet claimed",
      detail: `Outbox.isSpent(${p.index}) = ${!sale.checks.unspent}`,
      ok: sale.checks.unspent,
    },
  ];
}

/** The checks ExitMarket re-runs on-chain inside the seller's transaction, shown with real data. */
export function ProofTrace({ sale }: { sale: PreparedSale }) {
  return (
    <ol className="space-y-2" aria-label="On-chain verification">
      {stepsOf(sale).map((step, i) => (
        <li key={step.label} className="grid grid-cols-[1.5rem_1fr] gap-2">
          <span
            aria-hidden
            className={`mt-0.5 flex h-5 w-5 items-center justify-center rounded-full font-mono text-[11px] ${
              step.ok ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"
            }`}
          >
            {step.ok ? "✓" : i + 1}
          </span>
          <span className="min-w-0">
            <span className="block text-sm text-ink">
              {step.label}
              <span className="sr-only">{step.ok ? " (verified)" : " (failed)"}</span>
            </span>
            <span className="block break-all font-mono text-xs text-muted">{step.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
