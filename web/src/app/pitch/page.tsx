import type { Metadata } from "next";
import { Pitch } from "@/components/pitch/Pitch";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteNav } from "@/components/site/SiteNav";

export const metadata: Metadata = {
  title: "Pitch · Exit Market",
  description: "The Exit Market pitch deck: the 6.4-day problem, the unused bridge hook, how it works, live proof and the plan.",
};

export default function PitchPage() {
  return (
    <>
      <SiteNav active="pitch" />
      <main>
        <Pitch />
      </main>
      <SiteFooter />
    </>
  );
}
