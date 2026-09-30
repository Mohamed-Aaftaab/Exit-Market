import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteNav } from "@/components/site/SiteNav";
import { Hero } from "./Hero";
import { Sections } from "./Sections";

/** The home page: the video hero as the first viewport, then the story in scrolling sections. */
export function Landing() {
  return (
    <>
      <SiteNav active="home" />
      <main>
        <Hero />
        <Sections />
      </main>
      <SiteFooter />
    </>
  );
}
