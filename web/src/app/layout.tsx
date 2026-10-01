import type { Metadata } from "next";
import { Doto, Geist_Mono, Inter } from "next/font/google";
import { Providers } from "./providers";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"], weight: ["400", "500", "600"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
// Self-hosted fallback for the display face, should the dot-matrix webfont (declared in globals.css) fail to load.
const doto = Doto({ variable: "--font-doto", subsets: ["latin"], weight: "variable", axes: ["ROND"] });

/**
 * Absolute base for link previews (og:image and friends must be absolute URLs): NEXT_PUBLIC_SITE_URL if set, else the
 * production domain Vercel exposes at build time, else local dev.
 */
function siteUrl(): URL {
  const candidates = [
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return new URL(candidate);
    } catch {
      // A malformed value must not break the build: fall through to the next source.
    }
  }
  return new URL("http://localhost:3000");
}

const TITLE = "Exit Market · Exit Arbitrum without the wait";
const DESCRIPTION =
  "Sell a pending Arbitrum withdrawal while it is still in its challenge period, proven on-chain against the rollup's own commitments.";

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: "Exit Market",
  description: DESCRIPTION,
  // The image comes from app/opengraph-image.tsx; X falls back to it for the large card.
  openGraph: { type: "website", siteName: "Exit Market", title: TITLE, description: DESCRIPTION },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable} ${doto.variable} h-full antialiased`}>
      <body className="min-h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
