import type { ReactNode } from "react";
import snapshot from "@/data/mainnet-snapshot.json";
import { Panel } from "@/components/Panel";
import { integer, mainnetTxUrl, safeHttpUrl, usdCompact } from "@/lib/explorer/display";
import { shortHex } from "@/lib/format";

const RESEARCH_DIR = "research/stranded";
/** Optional public repo URL (e.g. https://github.com/org/repo) to turn the script path into a link. */
const REPO_URL = safeHttpUrl(process.env.NEXT_PUBLIC_REPO_URL);

function Figure({ value, label, children }: { value: string; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col bg-surface p-4">
      <dt className="order-2 mt-1 text-sm text-ink">{label}</dt>
      <dd className="order-1 font-mono text-2xl text-ink">{value}</dd>
      <dd className="order-3 mt-1 text-xs text-muted">{children}</dd>
    </div>
  );
}

function ScriptLink() {
  const path = `${RESEARCH_DIR}/summary.mjs`;
  if (!REPO_URL) return <code className="font-mono text-ink">{path}</code>;
  return (
    <a href={`${REPO_URL}/tree/main/${RESEARCH_DIR}`} target="_blank" rel="noopener noreferrer" className="font-mono text-accent hover:underline">
      {path}
    </a>
  );
}

/** Arbitrum One -> Ethereum research numbers. A dated snapshot generated offline, not live data. */
export function MainnetSnapshot() {
  const { stranded, flow30d, challengeWindow, snapshot: meta } = snapshot;
  const top = stranded.largestLast12Months;
  const asOf = meta.arbHeadTime.replace("T", " ").slice(0, 16) + " UTC";
  return (
    <Panel title="Mainnet opportunity · Arbitrum One → Ethereum" meta={`research snapshot · ${meta.date} · not live`}>
      <p className="border-b border-line bg-warn-soft px-4 py-2 text-xs text-warn">
        Snapshot of Arbitrum One at block {integer(meta.arbHeadBlock)} ({asOf}), not live data.
      </p>
      <dl className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-4">
        <Figure value={usdCompact(stranded.allTime.usd)} label="stranded in exits nobody claimed">
          {integer(stranded.allTime.count)} confirmed token exits · {usdCompact(stranded.last12Months.usd)} of it from the last 12
          months ({integer(stranded.last12Months.count)})
        </Figure>
        <Figure value={`${top.amount.toLocaleString("en-US")} ${top.symbol}`} label="largest stranded exit, last 12 months">
          ≈ {usdCompact(top.usd, 0)} ·{" "}
          <a href={mainnetTxUrl(top.tx)} target="_blank" rel="noopener noreferrer" className="font-mono hover:text-accent hover:underline">
            {shortHex(top.tx, 8, 4)} ↗
          </a>
        </Figure>
        <Figure value={usdCompact(flow30d.tokenUsd, 1)} label="token withdrawals, last 30 days">
          {integer(flow30d.tokenCount)} exits through the canonical bridge
        </Figure>
        <Figure value={`${usdCompact(challengeWindow.tokenUsd, 1)} + ${integer(Math.round(challengeWindow.eth))} ETH`} label="waiting in the challenge window">
          {integer(challengeWindow.tokenCount)} token exits that could be sold instead of waited out, plus{" "}
          {integer(challengeWindow.ethCount)} native ETH withdrawals (≈{usdCompact(challengeWindow.ethUsd, 1)}) that bypass the
          token gateway and become sellable only when withdrawn as WETH
        </Figure>
      </dl>
      <div className="space-y-2 border-t border-line px-4 py-3 text-xs text-muted">
        <p>
          Stranded = token withdrawal confirmed on Ethereum (L2 block ≤ {integer(meta.confirmedL2Block)}), initiated at least{" "}
          {stranded.minAgeDays} days before the snapshot, Outbox slot still unspent. USD at DefiLlama prices on {meta.date} (ETH $
          {meta.ethUsd.toLocaleString("en-US")}); {integer(stranded.allTime.unpricedCount)} unpriced exits count as $0. Simulated{" "}
          <code className="font-mono">Outbox.executeTransaction</code> succeeds for {integer(stranded.executeTransactionSimulation.ok)} of{" "}
          {integer(stranded.executeTransactionSimulation.simulated)} checked. Not counted above: {stranded.eth.allTime.eth.toLocaleString("en-US")} ETH in{" "}
          {integer(stranded.eth.allTime.count)} unclaimed ETH withdrawals.
        </p>
        <p>
          Reproduce with <ScriptLink /> (methodology and data sources in <code className="font-mono">{RESEARCH_DIR}/README.md</code>).
        </p>
      </div>
    </Panel>
  );
}
