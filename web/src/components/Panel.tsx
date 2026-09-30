import type { CSSProperties, ReactNode } from "react";

type Props = {
  title: string;
  meta?: string;
  /** Stagger of the entrance animation, in seconds. */
  delay?: number;
  children: ReactNode;
};

/** Rounded surface with a title bar; the app's basic layout block. */
export function Panel({ title, meta, delay = 0, children }: Props) {
  return (
    <section className="panel reveal" style={{ "--d": `${delay}s` } as CSSProperties}>
      <header className="flex items-baseline justify-between gap-3 border-b border-line px-5 py-4">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {meta && <span className="truncate font-mono text-xs text-muted">{meta}</span>}
      </header>
      {children}
    </section>
  );
}
