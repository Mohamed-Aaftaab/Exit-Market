import { safeHttpUrl } from "@/lib/explorer/display";

export type PageId = "home" | "desk" | "explorer" | "pitch";

export type NavItem = { id: PageId; href: string; label: string };

/** The site's four destinations, in header order. */
export const NAV: ReadonlyArray<NavItem> = [
  { id: "home", href: "/", label: "Home" },
  { id: "desk", href: "/app", label: "Desk" },
  { id: "explorer", href: "/explorer", label: "Explorer" },
  { id: "pitch", href: "/pitch", label: "Pitch" },
];

// Only http(s) links are ever rendered; anything else in the environment is ignored.
export const REPO_URL = safeHttpUrl(process.env.NEXT_PUBLIC_REPO_URL);
export const VIDEO_URL = safeHttpUrl(process.env.NEXT_PUBLIC_DEMO_VIDEO_URL);
