import type { Metadata } from "next";
import { ConnectButton } from "@/components/ConnectButton";
import { ExitDesk } from "@/components/ExitDesk";
import { ListingsPanel } from "@/components/ListingsPanel";
import { Panel } from "@/components/Panel";
import { PageShell } from "@/components/site/PageShell";
import { VaultPanel } from "@/components/VaultPanel";

export const metadata: Metadata = {
  title: "Exit Desk · Exit Market",
  description: "Pick a pending Xai Testnet withdrawal, see its price and on-chain proof, and sell it in one signature or list it at your price.",
};

const STEPS = [
  ["Redirect", "You call the Arbitrum gateway's own transferExitAndCall, handing your pending exit to the market."],
  ["Prove", "The market rebuilds your withdrawal leaf and checks it against the Outbox tree of a pending rollup node."],
  ["Check", "It confirms the node is unresolved with no rival anywhere on its pending chain, and the Outbox slot is unspent."],
  ["Settle", "The vault pays you in USDG and becomes the exit's owner. The 6.4-day wait becomes the LPs' yield."],
] as const;

export default function DeskPage() {
  return (
    <PageShell
      active="desk"
      action={<ConnectButton />}
      eyebrow="Exit desk"
      title="Sell Your Withdrawal"
      lead="Start a withdrawal from Xai Testnet, or pick one already in flight. As soon as the next rollup node posts, it is provable on-chain: sell it to the vault in one signature, or list it for any buyer at your price."
    >
      <div className="space-y-4">
        <ExitDesk />
        <ListingsPanel />

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <Panel title="How the market verifies an exit" meta="all on-chain, inside your transaction" delay={0.16}>
            <ol className="grid gap-px bg-line sm:grid-cols-2">
              {STEPS.map(([title, body], i) => (
                <li key={title} className="bg-surface p-5">
                  <p className="font-display text-xl leading-none text-ink">0{i + 1}</p>
                  <p className="mt-2 text-sm font-medium text-ink">{title}</p>
                  <p className="mt-1 text-sm text-muted">{body}</p>
                </li>
              ))}
            </ol>
          </Panel>

          <Panel title="Exit liquidity vault · evUSDG" meta="ERC-4626" delay={0.22}>
            <VaultPanel />
          </Panel>
        </div>
      </div>
    </PageShell>
  );
}
