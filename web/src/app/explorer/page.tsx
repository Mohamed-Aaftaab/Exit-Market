import type { Metadata } from "next";
import { ExplorerView } from "@/components/explorer/ExplorerView";
import { MainnetSnapshot } from "@/components/explorer/MainnetSnapshot";
import { PageShell } from "@/components/site/PageShell";

export const metadata: Metadata = {
  title: "Exit Explorer · Exit Market",
  description:
    "Every token withdrawal from Xai Testnet's standard gateway with its live status, plus how much value sits unclaimed on Arbitrum One.",
};

export default function ExplorerPage() {
  return (
    <PageShell
      active="explorer"
      eyebrow="Exit explorer"
      title="Every Exit, Live"
      lead={
        <>
          Every token withdrawal made through Xai Testnet&apos;s standard gateway, read live from public RPCs: awaiting an
          assertion, sellable in the challenge window, stranded, claimed, or already transferred with{" "}
          <code className="font-mono text-ink">transferExitAndCall</code>. Rows routed through Exit Market carry a white rail.
        </>
      }
    >
      <div className="space-y-4">
        <ExplorerView />
        <MainnetSnapshot />
      </div>
    </PageShell>
  );
}
