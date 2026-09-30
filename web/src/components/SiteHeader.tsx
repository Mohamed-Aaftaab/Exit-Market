import Link from "next/link";
import { ConnectButton } from "@/components/ConnectButton";
import { APP_NAME } from "@/lib/format";

type Page = "desk" | "explorer";

const NAV: ReadonlyArray<{ page: Page; href: string; label: string }> = [
  { page: "desk", href: "/", label: "Desk" },
  { page: "explorer", href: "/explorer", label: "Explorer" },
];

export function SiteHeader({ active }: { active: Page }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 py-5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2">
        <div className="min-w-0">
          <p className="font-semibold text-ink">{APP_NAME}</p>
          <p className="truncate text-xs text-muted">Sell a pending Orbit-chain withdrawal instead of waiting it out</p>
        </div>
        <nav aria-label="Main">
          <ul className="flex gap-0.5 rounded-md border border-line bg-surface p-0.5 text-sm">
            {NAV.map(({ page, href, label }) => {
              const isActive = page === active;
              return (
                <li key={page}>
                  <Link
                    href={href}
                    aria-current={isActive ? "page" : undefined}
                    className={`block rounded px-3 py-1 focus-visible:outline-2 focus-visible:outline-accent ${
                      isActive ? "bg-surface-2 font-medium text-ink" : "text-muted hover:text-ink"
                    }`}
                  >
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
      <ConnectButton />
    </header>
  );
}
