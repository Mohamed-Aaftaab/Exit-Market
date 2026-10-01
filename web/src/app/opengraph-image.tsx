import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { LogoMark } from "@/components/site/LogoMark";

// The link-preview card for every page (X, Discord, HackQuest...), rendered once at build time.
export const alt = "Exit Market: sell a pending Arbitrum withdrawal while it is still in its challenge period";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BADGES = ["Live on Arbitrum Sepolia", "Xai Testnet · Orbit L3", "BOLD verifier", "Paxos USDG"];

export default async function OpengraphImage() {
  // Inter (SIL OFL, web/assets/fonts/Inter-OFL.txt): the site's body face.
  const [semiBold, regular] = await Promise.all([
    readFile(join(process.cwd(), "assets/fonts/Inter-SemiBold.ttf")),
    readFile(join(process.cwd(), "assets/fonts/Inter-Regular.ttf")),
  ]);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: "linear-gradient(180deg, #101011 0%, #000000 100%)",
          color: "#ffffff",
          fontFamily: "Inter",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          <div
            style={{
              width: 76,
              height: 76,
              borderRadius: 38,
              background: "#ffffff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <LogoMark size={46} />
          </div>
          <div style={{ fontSize: 38, fontWeight: 600 }}>Exit Market</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {/* The landing hero's two lines. */}
          <div style={{ display: "flex", flexDirection: "column", fontSize: 82, fontWeight: 600, lineHeight: 1.04, letterSpacing: -2 }}>
            <div>Exit Arbitrum</div>
            <div>without the wait</div>
          </div>
          <div style={{ fontSize: 32, lineHeight: 1.35, color: "#a1a1aa", maxWidth: 1000 }}>
            Sell a pending canonical-bridge withdrawal while it is still in its challenge period, proven on-chain against
            the rollup&apos;s own commitments.
          </div>
        </div>
        <div style={{ display: "flex", gap: 14 }}>
          {BADGES.map((badge) => (
            <div
              key={badge}
              style={{ display: "flex", padding: "10px 24px", borderRadius: 999, background: "#1c1c1e", color: "#e4e4e7", fontSize: 24 }}
            >
              {badge}
            </div>
          ))}
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Inter", data: semiBold, style: "normal", weight: 600 },
        { name: "Inter", data: regular, style: "normal", weight: 400 },
      ],
    },
  );
}
