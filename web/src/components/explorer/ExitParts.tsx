import type { ReactNode } from "react";
import type { Address } from "viem";
import { blocksToDuration, shortHex } from "@/lib/format";
import {
  ageText,
  ownerLabel,
  parentAddressUrl,
  parentTxUrl,
  tokenAmount,
  tokenSymbol,
  xaiAddressUrl,
} from "@/lib/explorer/display";
import type { ExitStatus, ExplorerExit } from "@/lib/explorer/status";

const PILL: Record<ExitStatus, string> = {
  "awaiting-assertion": "bg-warn-soft text-warn",
  "in-window": "bg-ok-soft text-ok",
  stranded: "bg-bad-soft text-bad",
  claimed: "bg-surface-2 text-muted",
  transferred: "bg-accent/10 text-accent",
};

const LABEL: Record<ExitStatus, string> = {
  "awaiting-assertion": "Awaiting assertion",
  "in-window": "In challenge window",
  stranded: "Stranded",
  claimed: "Claimed",
  transferred: "Transferred",
};

export function ExternalLink({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`underline-offset-2 hover:text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent ${className}`}
    >
      {children}
    </a>
  );
}

export function AddressLink({ address, href }: { address: Address; href: string }) {
  return (
    <ExternalLink href={href} className="font-mono">
      <span title={address}>{shortHex(address)}</span>
    </ExternalLink>
  );
}

export function StatusPill({ exit }: { exit: ExplorerExit }) {
  const label = exit.status === "transferred" && exit.viaExitMarket ? "Sold via Exit Market" : LABEL[exit.status];
  return <span className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${PILL[exit.status]}`}>{label}</span>;
}

/** One line under the pill: time left, or what the stage means for the owner. */
export function statusDetail(exit: ExplorerExit): string {
  const left = exit.blocksLeft ?? 0n;
  const timing = left > 0n ? `${blocksToDuration(left)} left (${left} L1 blocks)` : "deadline passed, confirming";
  switch (exit.stage) {
    case "awaiting-assertion":
      return "not in a rollup node yet";
    case "in-window":
      return exit.status === "in-window" ? `sellable now · ${timing}` : `in window · ${timing}`;
    case "confirmed":
      return exit.status === "stranded" ? "confirmed, never claimed" : "confirmed · owner can claim";
    case "claimed":
      return exit.ownerContract ? `paid to ${ownerLabel(exit)}` : "paid out by the Outbox";
  }
}

export function Amount({ exit }: { exit: ExplorerExit }) {
  return (
    <span className="whitespace-nowrap">
      <span className="font-mono text-ink">{tokenAmount(exit.amount, exit.token.decimals)}</span>{" "}
      <span className="text-xs text-muted" title={exit.token.address}>
        {tokenSymbol(exit.token)}
      </span>
    </span>
  );
}

export function Age({ exit, now }: { exit: ExplorerExit; now: number }) {
  const iso = new Date(exit.timestamp * 1000).toISOString();
  return (
    <time dateTime={iso} title={iso} className="whitespace-nowrap font-mono text-xs text-muted">
      {ageText(now - exit.timestamp)} ago
    </time>
  );
}

export function SenderLink({ exit }: { exit: ExplorerExit }) {
  return <AddressLink address={exit.sender} href={xaiAddressUrl(exit.sender)} />;
}

/** Current owner (our contracts named and badged) plus the latest transferExitAndCall tx. */
export function OwnerCell({ exit }: { exit: ExplorerExit }) {
  const last = exit.redirects.at(-1);
  return (
    <span className="flex flex-col items-start gap-0.5">
      {exit.ownerContract ? (
        <ExternalLink href={parentAddressUrl(exit.owner)} className="rounded bg-accent/10 px-1.5 py-0.5 text-xs font-medium text-accent">
          <span title={exit.owner}>{ownerLabel(exit)}</span>
        </ExternalLink>
      ) : (
        <AddressLink address={exit.owner} href={parentAddressUrl(exit.owner)} />
      )}
      {last && (
        <ExternalLink href={parentTxUrl(last.txHash)} className="text-xs text-muted">
          transfer tx ↗
        </ExternalLink>
      )}
    </span>
  );
}

/** Rows owned by, or routed through, our contracts get an accent rail. */
export function isOurs(exit: ExplorerExit): boolean {
  return Boolean(exit.ownerContract) || exit.viaExitMarket;
}
