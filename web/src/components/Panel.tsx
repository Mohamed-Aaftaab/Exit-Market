import type { ReactNode } from "react";

/** Bordered surface with a title bar; the app's basic layout block. */
export function Panel({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-surface">
      <header className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {meta && <span className="truncate font-mono text-xs text-muted">{meta}</span>}
      </header>
      {children}
    </section>
  );
}
