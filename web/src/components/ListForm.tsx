"use client";

import { useState, type FormEvent } from "react";
import { formatUnits } from "viem";
import { netOfMarketFee } from "@shared/hookData.ts";
import type { PreparedSale } from "@/hooks/useExitSale";
import type { useListExit } from "@/hooks/useListingActions";
import { USDG_DECIMALS, bps, errorText, parseUsdgInput, usdg } from "@/lib/format";

const EXPIRIES: ReadonlyArray<readonly [label: string, seconds: number]> = [
  ["1 hour", 3_600],
  ["6 hours", 21_600],
  ["1 day", 86_400],
  ["3 days", 259_200],
];
const DEFAULT_EXPIRY = 2; // 1 day

/** Halfway between what the vault pays right now and face value: a buyer still earns, the seller gets more. */
function suggestedPrice(sale: PreparedSale): string {
  const face = sale.record.amount;
  return formatUnits(sale.vaultQuote + (face - sale.vaultQuote) / 2n, USDG_DECIMALS);
}

/** List the exit at the seller's own price: one signature redirects it to the market, which proves and lists it. */
export function ListForm({
  sale,
  list,
  blocked,
  onCommit,
}: {
  sale: PreparedSale;
  list: ReturnType<typeof useListExit>;
  /** Why the market would refuse a listing right now; the form is disabled and says why. */
  blocked: string | undefined;
  /** Called as the listing is submitted (see SellTicket). */
  onCommit: () => void;
}) {
  const [priceInput, setPriceInput] = useState(() => suggestedPrice(sale));
  const [expiryIndex, setExpiryIndex] = useState(DEFAULT_EXPIRY);

  const face = sale.record.amount;
  const price = parseUsdgInput(priceInput);
  const aboveFace = price !== undefined && price > face;
  const net = price === undefined ? undefined : netOfMarketFee(price, sale.marketFeeBps);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked || price === undefined || aboveFace) return;
    onCommit();
    list.mutate({ withdrawal: sale.withdrawal, price, durationSeconds: BigInt(EXPIRIES[expiryIndex][1]) });
  };

  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      <label className="block">
        <span className="text-sm text-muted">Your price (USDG)</span>
        <input
          className="mt-1 w-full rounded-2xl border border-line bg-surface-2 px-4 py-3 font-mono text-lg text-ink outline-none focus:border-ink"
          inputMode="decimal"
          value={priceInput}
          onChange={(e) => setPriceInput(e.target.value)}
          aria-invalid={price === undefined || aboveFace}
          aria-describedby="list-price-help"
        />
      </label>
      <p id="list-price-help" className="text-xs text-muted">
        The vault pays {usdg(sale.vaultQuote, 4)} now; face value is {usdg(face)}.{" "}
        {aboveFace && <span className="text-bad">A price above face value would never sell.</span>}
        {price === undefined && <span className="text-bad">Enter an amount with up to 6 decimals.</span>}
      </p>

      <fieldset>
        <legend className="text-sm text-muted">Listing ends after</legend>
        <div className="mt-1 grid grid-cols-4 gap-1 rounded-full bg-surface-2 p-1">
          {EXPIRIES.map(([label], i) => (
            <button
              key={label}
              type="button"
              aria-pressed={i === expiryIndex}
              onClick={() => setExpiryIndex(i)}
              className={`rounded-full px-2 py-1.5 text-xs ${i === expiryIndex ? "bg-ink text-bg" : "text-muted hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="space-y-1.5 border-y border-line py-4 text-sm">
        <div className="flex justify-between gap-4">
          <span className="text-muted">You receive when it sells ({bps(sale.marketFeeBps)} fee)</span>
          <span className="font-mono text-ink">{net === undefined ? "—" : `${usdg(net)} USDG`}</span>
        </div>
        <p className="text-xs text-muted">
          Cancel any time before it sells. If nobody buys it before it pays out, settlement sends you the full{" "}
          {usdg(face)} USDG, so listing never costs you the exit.
        </p>
      </div>

      {blocked && (
        <p role="status" className="rounded-3xl bg-warn-soft px-4 py-3 text-sm text-warn">
          {blocked}
        </p>
      )}
      <button type="submit" className="btn-primary w-full" disabled={Boolean(blocked) || price === undefined || aboveFace || list.isPending} aria-busy={list.isPending}>
        {list.isPending ? "Confirm in wallet…" : `List for ${price === undefined ? "…" : usdg(price)} USDG`}
      </button>
      {list.isError && (
        <p role="alert" className="text-sm text-bad">
          {errorText(list.error)}
        </p>
      )}
    </form>
  );
}
