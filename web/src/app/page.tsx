import type { Metadata } from "next";
import { Landing } from "@/components/landing/Landing";

export const metadata: Metadata = {
  title: "Exit Market · Exit Arbitrum without the wait",
  description:
    "Sell a canonical-bridge withdrawal while it is still in its 6.4-day challenge period, proven on-chain against the rollup's own commitments.",
};

export default function Home() {
  return <Landing />;
}
