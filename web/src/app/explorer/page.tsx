import type { Metadata } from "next";
import { ExplorerView } from "@/components/explorer/ExplorerView";
import { MainnetSnapshot } from "@/components/explorer/MainnetSnapshot";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata: Metadata = {
  title: "Exit Explorer · Exit Market",
  description:
    "Every token withdrawal from Xai Testnet's standard gateway with its live status, plus how much value sits unclaimed on Arbitrum One.",
};

export default function ExplorerPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-16">
      <SiteHeader active="explorer" />
      <main className="space-y-4">
        <div className="max-w-3xl">
          <h1 className="text-xl font-semibold text-ink">Exit Explorer</h1>
          <p className="mt-1 text-sm text-muted">
            Every token withdrawal ever made through Xai Testnet&apos;s standard gateway, read live from public RPCs: whether it is
            waiting for a rollup assertion, sellable inside the challenge window, confirmed but never claimed, claimed, or
            already transferred with <code className="font-mono text-ink">transferExitAndCall</code>. Rows routed through Exit
            Market are marked with a blue rail.
          </p>
        </div>
        <ExplorerView />
        <MainnetSnapshot />
      </main>
    </div>
  );
}
