"use client";

import type { ReactNode } from "react";
import { Panel } from "@/components/Panel";
import { useExitExplorer } from "@/hooks/useExitExplorer";
import { integer } from "@/lib/explorer/display";
import type { ExplorerData } from "@/lib/explorer/loadExits";
import { summarize } from "@/lib/explorer/status";
import { errorText } from "@/lib/format";
import { ExitCards } from "./ExitCards";
import { ExitTable } from "./ExitTable";
import { StatCards } from "./StatCards";

function ScanFooter({ data, isFetching, refreshError }: { data: ExplorerData; isFetching: boolean; refreshError?: unknown }) {
  const { scan, rollup } = data;
  const time = new Date(data.scannedAt).toLocaleTimeString("en-US", { hour12: false });
  return (
    <div className="space-y-1 border-t border-line px-4 py-3 font-mono text-xs text-muted">
      <p>
        Xai blocks {integer(scan.childFrom)}–{integer(scan.childTo)} and Arbitrum Sepolia blocks {integer(scan.parentFrom)}–
        {integer(scan.parentTo)} in {scan.logCalls} getLogs calls · rollup node #{rollup.confirmed.nodeNum.toString()} confirmed (
        {integer(rollup.confirmed.sendCount)} sends), {rollup.pending.length} pending
      </p>
      <p aria-live="polite">
        {isFetching ? "Refreshing…" : `Updated ${time} · refreshes every 60s`}
        {refreshError !== undefined && <span className="text-bad"> · last refresh failed: {errorText(refreshError)}</span>}
      </p>
    </div>
  );
}

function Message({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "bad" }) {
  return (
    <div role={tone === "bad" ? "alert" : "status"} className={`px-4 py-10 text-center text-sm ${tone === "bad" ? "text-bad" : "text-muted"}`}>
      {children}
    </div>
  );
}

/** Live table of every Xai Testnet standard-gateway withdrawal, read from public RPCs in the browser. */
export function ExplorerView() {
  const query = useExitExplorer();
  const { data } = query;
  const now = data ? Math.floor(data.scannedAt / 1000) : 0;

  return (
    <div className="space-y-4">
      <StatCards summary={data ? summarize(data.exits) : undefined} />
      <Panel title="All exits · Xai Testnet → Arbitrum Sepolia" meta="live">
        {query.isPending && <Message>Scanning Xai Testnet and Arbitrum Sepolia…</Message>}
        {query.isError && !data && (
          <Message tone="bad">
            <p>Could not read the chains: {errorText(query.error)}</p>
            <button
              type="button"
              onClick={() => query.refetch()}
              className="mt-3 rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-surface-2"
            >
              Try again
            </button>
          </Message>
        )}
        {data && data.exits.length === 0 && <Message>No token withdrawals through the standard gateway yet.</Message>}
        {data && data.exits.length > 0 && (
          <>
            <ExitTable exits={data.exits} now={now} />
            <ExitCards exits={data.exits} now={now} />
          </>
        )}
        {data && <ScanFooter data={data} isFetching={query.isFetching} refreshError={query.isError ? query.error : undefined} />}
      </Panel>
    </div>
  );
}
