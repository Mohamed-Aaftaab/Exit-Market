import type { Metadata } from "next";
import Link from "next/link";
import { PageShell } from "@/components/site/PageShell";

export const metadata: Metadata = {
  title: "Page not found · Exit Market",
};

/** Any URL that matches no page: the site's own frame, with the ways back in. */
export default function NotFound() {
  return (
    <PageShell
      eyebrow="404"
      title="Page Not Found"
      lead="There is nothing at this address. The desk, the live explorer and the pitch are all one click away."
    >
      <div className="flex flex-wrap gap-3">
        <Link href="/app" className="btn-primary">
          Open the desk
        </Link>
        <Link href="/explorer" className="btn-dark">
          Exit explorer
        </Link>
        <Link href="/" className="btn-dark">
          Home
        </Link>
      </div>
    </PageShell>
  );
}
