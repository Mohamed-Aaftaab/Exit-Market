import { xaiTxUrl } from "@/lib/explorer/display";
import type { ExplorerExit } from "@/lib/explorer/status";
import { Age, Amount, ExternalLink, OwnerCell, SenderLink, StatusPill, isOurs, statusDetail } from "./ExitParts";

const RAIL = "bg-accent/5 shadow-[inset_3px_0_0_var(--accent)]";
const HEADERS = ["Exit", "Amount", "Sender", "Age", "Status", "Owner"] as const;

function ExitRow({ exit, now }: { exit: ExplorerExit; now: number }) {
  return (
    <tr className={isOurs(exit) ? RAIL : "hover:bg-surface-2/60"}>
      <td className="px-4 py-3 align-top">
        <ExternalLink href={xaiTxUrl(exit.txHash)} className="font-mono text-ink">
          #{exit.exitNum.toString()}
        </ExternalLink>
        <span className="block font-mono text-xs text-muted">outbox #{exit.position.toString()}</span>
      </td>
      <td className="px-4 py-3 align-top">
        <Amount exit={exit} />
      </td>
      <td className="px-4 py-3 align-top text-sm text-ink">
        <SenderLink exit={exit} />
      </td>
      <td className="px-4 py-3 align-top">
        <Age exit={exit} now={now} />
      </td>
      <td className="px-4 py-3 align-top">
        <StatusPill exit={exit} />
        <span className="mt-1 block text-xs text-muted">{statusDetail(exit)}</span>
      </td>
      <td className="px-4 py-3 align-top text-sm text-ink">
        <OwnerCell exit={exit} />
      </td>
    </tr>
  );
}

/** Wide screens: one row per exit. */
export function ExitTable({ exits, now }: { exits: ExplorerExit[]; now: number }) {
  return (
    <div className="hidden overflow-x-auto md:block">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Token withdrawals from Xai Testnet, newest first</caption>
        <thead className="border-b border-line text-xs text-muted">
          <tr>
            {HEADERS.map((h) => (
              <th key={h} scope="col" className="px-4 py-2 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {exits.map((exit) => (
            <ExitRow key={exit.exitNum.toString()} exit={exit} now={now} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
