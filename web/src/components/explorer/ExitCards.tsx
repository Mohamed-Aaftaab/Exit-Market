import { xaiTxUrl } from "@/lib/explorer/display";
import type { ExplorerExit } from "@/lib/explorer/status";
import { Age, Amount, ExternalLink, OwnerCell, SenderLink, StatusPill, isOurs, statusDetail } from "./ExitParts";

function ExitCard({ exit, now }: { exit: ExplorerExit; now: number }) {
  return (
    <li className={`space-y-2 px-4 py-3 ${isOurs(exit) ? "bg-accent/5 shadow-[inset_3px_0_0_var(--accent)]" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base">
            <Amount exit={exit} />
          </p>
          <p className="font-mono text-xs text-muted">
            <ExternalLink href={xaiTxUrl(exit.txHash)}>exit #{exit.exitNum.toString()}</ExternalLink> ·{" "}
            <Age exit={exit} now={now} />
          </p>
        </div>
        <StatusPill exit={exit} />
      </div>
      <p className="text-xs text-muted">{statusDetail(exit)}</p>
      <dl className="grid grid-cols-2 gap-3 text-sm text-ink">
        <div className="min-w-0">
          <dt className="text-xs text-muted">Sender</dt>
          <dd>
            <SenderLink exit={exit} />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted">Owner</dt>
          <dd>
            <OwnerCell exit={exit} />
          </dd>
        </div>
      </dl>
    </li>
  );
}

/** Narrow screens: stacked cards instead of a wide table. */
export function ExitCards({ exits, now }: { exits: ExplorerExit[]; now: number }) {
  return (
    <ul className="divide-y divide-line md:hidden" aria-label="Token withdrawals from Xai Testnet, newest first">
      {exits.map((exit) => (
        <ExitCard key={exit.exitNum.toString()} exit={exit} now={now} />
      ))}
    </ul>
  );
}
