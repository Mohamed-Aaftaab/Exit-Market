import { integer, totalsText } from "@/lib/explorer/display";
import type { ExplorerSummary } from "@/lib/explorer/status";

type Tone = "neutral" | "ok" | "bad" | "accent";

const DOT: Record<Tone, string> = {
  neutral: "bg-muted",
  ok: "bg-ok",
  bad: "bg-bad",
  accent: "bg-accent",
};

function StatCard({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: Tone }) {
  return (
    <div className="min-w-0 bg-surface p-4">
      <dt className="flex items-center gap-2 text-xs text-muted">
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${DOT[tone]}`} />
        {label}
      </dt>
      <dd className="mt-1 font-mono text-2xl text-ink">{value}</dd>
      <dd className="font-mono text-xs break-words text-muted">{sub}</dd>
    </div>
  );
}

/** Headline counts for the live scan; placeholders while the first scan runs. */
export function StatCards({ summary }: { summary: ExplorerSummary | undefined }) {
  const v = (n: number | undefined) => (n === undefined ? "—" : integer(n));
  const s = (text: string | undefined, fallback: string) => (summary ? text ?? fallback : "scanning…");
  return (
    <dl aria-busy={!summary} className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line lg:grid-cols-4">
      <StatCard label="Exits, all time" value={v(summary?.total)} sub={s("standard gateway", "")} tone="neutral" />
      <StatCard
        label="In challenge window"
        value={v(summary?.inWindow.count)}
        sub={s(summary && summary.inWindow.count > 0 ? totalsText(summary.inWindow.totals) : undefined, "none right now")}
        tone="ok"
      />
      <StatCard
        label="Stranded (confirmed, unclaimed)"
        value={v(summary?.stranded.count)}
        sub={s(summary && summary.stranded.count > 0 ? totalsText(summary.stranded.totals) : undefined, "none")}
        tone="bad"
      />
      <StatCard
        label="Sold via Exit Market"
        value={v(summary?.viaExitMarket.count)}
        sub={s(summary && summary.viaExitMarket.count > 0 ? totalsText(summary.viaExitMarket.totals) : undefined, "none yet")}
        tone="accent"
      />
    </dl>
  );
}
