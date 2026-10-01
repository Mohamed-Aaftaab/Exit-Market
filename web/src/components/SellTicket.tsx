"use client";

import { useState } from "react";
import { ListForm } from "@/components/ListForm";
import { ProofTrace } from "@/components/ProofTrace";
import { usePreparedSale, useSellExit, type PreparedSale } from "@/hooks/useExitSale";
import { useGaslessIntents, type GaslessIntent } from "@/hooks/useGaslessExit";
import { useListExit } from "@/hooks/useListingActions";
import { proofBlocker, vaultSizeRefusal } from "@/lib/exitLimits";
import { failureAdvice } from "@/lib/intentStore";
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

type Mode = "sell" | "list";
const MODES: ReadonlyArray<readonly [Mode, string]> = [
  ["sell", "Sell now to the vault"],
  ["list", "List at your price"],
];

function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-full bg-surface-2 p-1" role="group" aria-label="How to sell">
      {MODES.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={mode === value}
          onClick={() => onChange(value)}
          className={`rounded-full px-3 py-2 text-sm ${mode === value ? "bg-ink text-bg" : "text-muted hover:text-ink"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * What a fast exit still needs, from this browser's copy of its order: usually nothing, but an unsigned or failed
 * order waits for its seller, and an order signed in another browser is only known there.
 */
function gaslessNote(intent: GaslessIntent | undefined): string {
  if (!intent) {
    return (
      "This fast exit was started in another browser, which keeps its signed order: open the desk there. Without it, " +
      "the exit can be returned to you (node scripts/selfServe.ts reclaim <withdrawal tx>; anyone may do it after 3 days)."
    );
  }
  if (intent.status === "unsigned") {
    return "This fast exit is waiting for your signature: use “sign order” in the fast-exit list below your withdrawals. Signing is free and needs no gas.";
  }
  if (intent.status === "failed") {
    const advice = failureAdvice(intent.detail);
    return advice.canResign ? `${advice.text} Use “sign a new order” below your withdrawals.` : advice.text;
  }
  const relayer = intent.detail ? ` Relayer: ${intent.detail}.` : "";
  return `This is a fast exit: the relayer sells it to the vault as soon as it is asserted and the USDG lands in your wallet on Arbitrum. Nothing else to do.${relayer}`;
}

export function SellTicket({  row,
  onCommit,
}: {
  row: WithdrawalRow | undefined;
  /** Called as a sale or listing starts: the desk pins this withdrawal, so the refresh that follows (which changes
   *  its status) cannot move the selection and take the receipt with it. */
  onCommit: () => void;
}) {
  const prepared = usePreparedSale(row);
  const sell = useSellExit();
  const list = useListExit();
  const intents = useGaslessIntents();
  const [mode, setMode] = useState<Mode>("sell");

  if (!row) {
    return <p className="p-6 text-sm text-muted">Select a withdrawal to see what it is worth today.</p>;
  }
  // Checked before status: the post-listing refresh flips this row to "listed".
  if (list.isSuccess) {
    return (
      <div className="p-5">
        <a
          href={`${arbitrumSepolia.blockExplorers.default.url}/tx/${list.data}`}
          target="_blank"
          rel="noopener noreferrer"
          role="status"
          className="block rounded-full bg-ok-soft px-4 py-3 text-center text-sm font-medium text-ok hover:brightness-125"
        >
          Listed at {usdg(list.variables.price)} USDG. It is in Open listings below ↗
        </a>
      </div>
    );
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
          className="block rounded-full bg-ok-soft px-4 py-3 text-center text-sm font-medium text-ok hover:brightness-125"
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
    return <p className="p-6 text-sm text-muted">{gaslessNote(intents.find((i) => i.withdrawalTx === row.txHash))}</p>;
  }
  if (row.status === "listed") {
    return (
      <p className="p-6 text-sm text-muted">
        This exit is listed on the market at your price. Cancel it or watch it in Open listings below.
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
  // What the market would refuse right now applies to both paths; the vault's size limits only to selling to it.
  const blocked = proofBlocker(sale.checks);

  return (
    <div className="space-y-5 p-5">
      <ModeSwitch mode={mode} onChange={setMode} />
      <div>
        <p className="text-xs uppercase tracking-wide text-muted">Locked by the challenge period</p>
        <p className="font-mono text-2xl text-ink">{blocksToDuration(b.waitBlocks)}</p>
      </div>

      {mode === "list" ? (
        <>
          <ProofTrace sale={sale} />
          <ListForm sale={sale} list={list} blocked={blocked} onCommit={onCommit} />
        </>
      ) : (
        <InstantSale
          sale={sale}
          breakdown={b}
          sell={sell}
          blocked={blocked ?? vaultSizeRefusal(sale.record.amount, sale.vaultLimits)}
          onCommit={onCommit}
        />
      )}
    </div>
  );
}

function InstantSale({
  sale,
  breakdown: b,
  sell,
  blocked,
  onCommit,
}: {
  sale: PreparedSale;
  breakdown: ReturnType<typeof breakdownOf>;
  sell: ReturnType<typeof useSellExit>;
  /** Why the chain would refuse this sale; the button is replaced by the reason. */
  blocked: string | undefined;
  onCommit: () => void;
}) {
  // The vault pays from idle USDG; what it has spent on earlier exits returns as each clears its window.
  const hasLiquidity = sale.vaultIdle >= sale.vaultQuote;
  return (
    <>
      <dl className="space-y-1.5 border-y border-line py-4">
        <Line label="Withdrawal" value={`${usdg(b.face)} USDG`} />
        <Line label="Vault discount (fee + time)" value={`− ${usdg(b.vaultDiscount, 4)}`} />
        <Line label={`Market fee (${bps(sale.marketFeeBps)})`} value={`− ${usdg(b.marketFee, 4)}`} />
        <Line label="You receive now" value={`${usdg(b.receive)} USDG`} strong />
      </dl>

      <ProofTrace sale={sale} />

      {blocked ? (
        <p role="status" className="rounded-3xl bg-warn-soft px-4 py-3 text-sm text-warn">
          {blocked}
        </p>
      ) : hasLiquidity ? (
        <button
          type="button"
          disabled={sell.isPending}
          aria-busy={sell.isPending}
          onClick={() => {
            onCommit();
            sell.mutate(sale);
          }}
          className="btn-primary w-full"
        >
          {sell.isPending ? "Confirm in wallet…" : `Get ${usdg(b.receive)} USDG now`}
        </button>
      ) : (
        <p role="status" className="rounded-3xl bg-warn-soft px-4 py-3 text-sm text-warn">
          The vault has {usdg(sale.vaultIdle)} USDG free right now and this exit needs {usdg(sale.vaultQuote)}. It
          refills as the exits it already bought clear their challenge window, or when LPs deposit. This quote
          refreshes every minute.
        </p>
      )}
      {sell.isError && (
        <p role="alert" className="text-sm text-bad">
          {errorText(sell.error)}
        </p>
      )}
    </>
  );
}
