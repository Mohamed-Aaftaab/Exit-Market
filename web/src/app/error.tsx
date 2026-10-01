"use client";

import Link from "next/link";
import { PageShell } from "@/components/site/PageShell";

/**
 * Fallback for an unexpected error while rendering a page (the root layout's providers stay up): the site's frame,
 * a retry, and the way home instead of a blank screen. Production messages from the server are generic by design.
 */
export default function PageError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <PageShell
      eyebrow="Something went wrong"
      title="This Page Hit An Error"
      lead="Part of this page failed to render. Try again; your funds and exits live on-chain and are unaffected."
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-3">
          <button type="button" className="btn-primary" onClick={() => retry()}>
            Try again
          </button>
          <Link href="/" className="btn-dark">
            Home
          </Link>
        </div>
        {error.digest && <p className="font-mono text-xs text-muted">Reference: {error.digest}</p>}
      </div>
    </PageShell>
  );
}
