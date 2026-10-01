"use client";

import type { ReactNode } from "react";
import type { Hash, Hex } from "viem";
import { useAccount } from "wagmi";
import { arbitrumSepolia } from "wagmi/chains";
import { listingEconomics, type OpenListing } from "@shared/listings.ts";
import { Panel } from "@/components/Panel";
import { useBuyListing, useCancelListing } from "@/hooks/useListingActions";
import { useListings, type ListingsData } from "@/hooks/useListings";
import { bps, errorText, secondsToDuration, shortHex, usdg } from "@/lib/format";

const MIN_SECONDS_FOR_APR = 86_400n;

type RowState = { busy: "buy" | "cancel" | undefined; error: unknown };

function TxLink({ hash, children }: { hash: Hash; children: string }) {
  return (
    <a
      href={`${arbitrumSepolia.blockExplorers.default.url}/tx/${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      role="status"
      className="text-sm text-ok underline-offset-2 hover:underline"
    >
      {children} ↗
    </a>
  );
}

function Pill({ tone, children }: { tone: "ok" | "warn" | "bad"; children: string }) {
  const cls = { ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", bad: "bg-bad-soft text-bad" }[tone];
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

type RowProps = {
  entry: OpenListing;
  data: ListingsData;
  me: string | undefined;
  state: RowState;
  onBuy: (id: Hex, price: bigint) => void;
  onCancel: (id: Hex) => void;
};

function ListingRow({ entry, data, me, state, onBuy, onCancel }: RowProps) {
  const { id, listing, live } = entry;
  const e = listingEconomics(listing, data.currentL1Block);
  const isMine = me !== undefined && listing.seller.toLowerCase() === me.toLowerCase();
  const expired = listing.expiry < data.chainTime;
  // APR only once the wait is long enough for it to mean something (testnet windows are ~30 minutes).
  const apr = e.secondsToPayout >= MIN_SECONDS_FOR_APR ? e.aprBps : undefined;
  const returnLine =
    e.discount > 0n
      ? `+${usdg(e.discount, 4)} (${bps((e.discount * 10_000n) / listing.price)}) at payout${apr !== undefined ? ` · ${bps(apr)} APR` : ""}`
      : "at or above face value";

  let action: ReactNode;
  if (isMine || expired) {
    action = (
      <button type="button" className="btn-dark" disabled={state.busy !== undefined} onClick={() => onCancel(id)}>
        {state.busy === "cancel" ? "Confirm in wallet…" : isMine ? "Cancel listing" : "Return to seller"}
      </button>
    );
  } else if (!me) action = <span className="text-sm text-muted">Connect a wallet to buy</span>;
  else {
    action = (
      <button type="button" className="btn-primary" disabled={!live || state.busy !== undefined} onClick={() => onBuy(id, listing.price)}>
        {state.busy === "buy" ? "Confirm in wallet…" : `Buy for ${usdg(listing.price)} USDG`}
      </button>
    );
  }

  return (
    <li className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-lg text-ink">{usdg(listing.exit.amount)} USDG</span>
          <span className="text-sm text-muted">for</span>
          <span className="font-mono text-lg text-ink">{usdg(listing.price)}</span>
          {live ? <Pill tone="ok">Verified on-chain</Pill> : <Pill tone="bad">Contested or spent</Pill>}
          {expired && <Pill tone="warn">Expired</Pill>}
        </div>
        <p className="font-mono text-xs text-muted">
          {returnLine} · pays out {e.secondsToPayout > 0n ? `in ${secondsToDuration(e.secondsToPayout)}` : "now"} ·{" "}
          {expired ? "listing expired" : `listing ends in ${secondsToDuration(listing.expiry - data.chainTime)}`}
        </p>
        <p className="truncate font-mono text-xs text-muted">
          exit #{listing.exit.exitNum.toString()} · {listing.exit.pending ? `pending node #${listing.exit.nodeNum}` : "confirmed root"} ·
          seller {isMine ? "you" : shortHex(listing.seller)}
        </p>
        {state.error !== undefined && (
          <p role="alert" className="text-sm text-bad">
            {errorText(state.error)}
          </p>
        )}
      </div>
      <div className="sm:text-right">{action}</div>
    </li>
  );
}

/** Peer-to-peer listings on the live market: anyone can buy a verified exit, the seller can cancel any time. */
export function ListingsPanel() {
  const { address } = useAccount();
  const listings = useListings();
  const buy = useBuyListing();
  const cancel = useCancelListing();

  const stateOf = (id: Hex): RowState => {
    if (buy.variables?.id === id) return { busy: buy.isPending ? "buy" : undefined, error: buy.error ?? undefined };
    if (cancel.variables === id) return { busy: cancel.isPending ? "cancel" : undefined, error: cancel.error ?? undefined };
    return { busy: undefined, error: undefined };
  };

  const data = listings.data;
  // A completed listing leaves the open list on the next refetch, so its receipt is shown above the list.
  const notice: { hash: Hash; text: string } | undefined = buy.data
    ? { hash: buy.data, text: "Bought. The exit is yours: the Outbox pays you face value once its node confirms" }
    : cancel.data
      ? { hash: cancel.data, text: "Listing cancelled. The exit is back with its seller" }
      : undefined;
  return (
    <Panel title="Open listings · buy a pending exit" meta={data ? `${data.listings.length} open` : undefined} delay={0.12}>
      {notice && (
        <p className="border-b border-line px-5 py-3">
          <TxLink hash={notice.hash}>{notice.text}</TxLink>
        </p>
      )}
      {listings.isPending && <p className="px-5 py-8 text-center text-sm text-muted">Reading the market…</p>}
      {listings.isError && (
        <p role="alert" className="px-5 py-8 text-center text-sm text-bad">
          {errorText(listings.error)}
        </p>
      )}
      {data && data.listings.length === 0 && (
        <p className="px-5 py-8 text-center text-sm text-muted">
          No open listings. Pick a sellable withdrawal above and choose “List at your price”.
        </p>
      )}
      {data && data.listings.length > 0 && (
        <ul className="divide-y divide-line" aria-label="Open listings">
          {data.listings.map((entry) => (
            <ListingRow
              key={entry.id}
              entry={entry}
              data={data}
              me={address}
              state={stateOf(entry.id)}
              onBuy={(id, price) => buy.mutate({ id, price })}
              onCancel={(id) => cancel.mutate(id)}
            />
          ))}
        </ul>
      )}
      <p className="border-t border-line px-5 py-3 text-xs text-muted">
        The buyer becomes the exit&apos;s owner: the Outbox pays them face value once the node confirms. A listing is
        bought at its price or not at all; the market re-checks the proof and its node on every purchase.
      </p>
    </Panel>
  );
}
