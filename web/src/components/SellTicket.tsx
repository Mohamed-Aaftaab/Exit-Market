"use client";

import { ProofTrace } from "@/components/ProofTrace";
import { usePreparedSale, useSellExit, type PreparedSale } from "@/hooks/useExitSale";
import type { WithdrawalRow } from "@/hooks/useWithdrawals";
import { arbitrumSepolia } from "wagmi/chains";
import { blocksToDuration, bps, errorText, usdg } from "@/lib/format";

const BPS = 10_000n;

function breakdownOf(sale: PreparedSale) {
  const face = sale.record.amount;
  const marketFee = (sale.vaultQuote * BigInt(sale.marketFeeBps)) / BPS;
  return {
    face,
    vaultDiscount: face - sale.vaultQuote,
    marketFee,
    receive: sale.vaultQuote - marketFee,
    waitBlocks: sale.deadlineBlock > sale.currentL1Block ? sale.deadlineBlock - sale.currentL1Block : 0n,
  };
}

function Line({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={strong ? "text-sm font-medium text-ink" : "text-sm text-muted"}>{label}</dt>
      <dd className={`font-mono ${strong ? "text-lg text-ink" : "text-sm text-ink"}`}>{value}</dd>
    </div>
  );
}

export function SellTicket({ row }: { row: WithdrawalRow | undefined }) {
  const prepared = usePreparedSale(row);
  const sell = useSellExit();

  if (!row) {
    return <p className="p-6 text-sm text-muted">Select a withdrawal to see what it is worth today.</p>;
  }
  // Checked before status: the post-sale refresh flips this row to "transferred".
  if (sell.isSuccess) {
    return (
      <div className="p-5">
        <a
          href={`${arbitrumSepolia.blockExplorers.default.url}/tx/${sell.data}`}
          target="_blank"
          rel="noopener noreferrer"
          role="status"
          className="block rounded-md bg-ok-soft px-4 py-3 text-center text-sm font-medium text-ok"
        >
          Sold. {usdg(breakdownOf(sell.variables).receive)} USDG sent to your wallet on Arbitrum ↗
        </a>
      </div>
    );
  }
  if (row.status === "awaiting-assertion") {
    return (
      <p className="p-6 text-sm text-muted">
        This withdrawal is not in a rollup assertion yet. Xai Testnet posts one about every 15 minutes; it becomes
        sellable as soon as the next one lands.
      </p>
    );
  }
  if (row.status === "gasless") {
    return (
      <p className="p-6 text-sm text-muted">
        This is a fast exit: the relayer sells it to the vault as soon as it is asserted and the USDG lands in
        your wallet on Arbitrum. Nothing else to do.
      </p>
    );
  }
  if (row.status !== "sellable") {
    return <p className="p-6 text-sm text-muted">This exit has already been sold or claimed.</p>;
  }
  if (prepared.isPending) return <p className="p-6 text-sm text-muted">Building proof from live chain data…</p>;
  if (prepared.isError) {
    return (
      <p role="alert" className="p-6 text-sm text-bad">
        {errorText(prepared.error)}
      </p>
    );
  }

  const sale = prepared.data;
  const b = breakdownOf(sale);

  return (
    <div className="space-y-5 p-5">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted">Locked by the challenge period</p>
        <p className="font-mono text-2xl text-ink">{blocksToDuration(b.waitBlocks)}</p>
      </div>

      <dl className="space-y-1.5 border-y border-line py-4">
        <Line label="Withdrawal" value={`${usdg(b.face)} USDG`} />
        <Line label="Vault discount (fee + time)" value={`− ${usdg(b.vaultDiscount, 4)}`} />
        <Line label={`Market fee (${bps(sale.marketFeeBps)})`} value={`− ${usdg(b.marketFee, 4)}`} />
        <Line label="You receive now" value={`${usdg(b.receive)} USDG`} strong />
      </dl>

      <ProofTrace sale={sale} />

      <button
        type="button"
        disabled={sell.isPending}
        aria-busy={sell.isPending}
        onClick={() => sell.mutate(sale)}
        className="w-full rounded-md bg-accent px-4 py-3 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-60"
      >
        {sell.isPending ? "Confirm in wallet…" : `Get ${usdg(b.receive)} USDG now`}
      </button>
      {sell.isError && (
        <p role="alert" className="text-sm text-bad">
          {errorText(sell.error)}
        </p>
      )}
    </div>
  );
}
