"use client";

import "./globals.css";

/**
 * Last-resort fallback when the root layout itself fails (it replaces the whole document, so no providers or site
 * frame are available here): a plain message in the site's colours, a retry and a link home.
 */
export default function GlobalError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body className="min-h-full">
        <title>Something went wrong · Exit Market</title>
        <main className="mx-auto max-w-xl space-y-4 px-6 py-24">
          <p className="eyebrow">Something went wrong</p>
          <h1 className="text-3xl text-ink">Exit Market could not load</h1>
          <p className="text-muted">Try again in a moment; funds and exits are on-chain and unaffected.</p>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn-primary" onClick={() => retry()}>
              Try again
            </button>
            {/* A full page load on purpose: the root layout itself failed, so client-side navigation is not trusted here. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" className="btn-dark">
              Home
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
