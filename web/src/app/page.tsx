import { ConnectButton } from "@/components/ConnectButton";
import { ExitDesk, Panel } from "@/components/ExitDesk";
import { VaultPanel } from "@/components/VaultPanel";
import { APP_NAME } from "@/lib/format";

const STEPS = [
  ["Redirect", "You call the Arbitrum gateway's own transferExitAndCall, handing your pending exit to the market."],
  ["Prove", "The market rebuilds your withdrawal leaf and checks it against the Outbox tree of a pending rollup node."],
  ["Check", "It confirms the node is unresolved and the Outbox slot is unspent, so no one else can claim it."],
  ["Settle", "The vault pays you in USDG and becomes the exit's owner. The 6.4-day wait becomes the LPs' yield."],
] as const;

export default function Home() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-16">
      <header className="flex items-center justify-between gap-4 py-5">
        <div className="min-w-0">
          <p className="font-semibold text-ink">{APP_NAME}</p>
          <p className="truncate text-xs text-muted">Sell a pending Orbit-chain withdrawal instead of waiting it out</p>
        </div>
        <ConnectButton />
      </header>

      <main className="space-y-4">
        <ExitDesk />

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <Panel title="How the market verifies an exit" meta="all on-chain, inside your transaction">
            <ol className="grid gap-px bg-line sm:grid-cols-2">
              {STEPS.map(([title, body], i) => (
                <li key={title} className="bg-surface p-4">
                  <p className="font-mono text-xs text-accent">0{i + 1}</p>
                  <p className="text-sm font-medium text-ink">{title}</p>
                  <p className="mt-1 text-sm text-muted">{body}</p>
                </li>
              ))}
            </ol>
          </Panel>

          <Panel title="Exit liquidity vault · evUSDG" meta="ERC-4626">
            <VaultPanel />
          </Panel>
        </div>
      </main>
    </div>
  );
}
