"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import styles from "./site.module.css";

const INNER_PAGE_OFFSET = 12;
const HERO_FRACTION = 0.7; // over the landing's video hero the header stays bare until most of it has scrolled by

function subscribe(onChange: () => void) {
  window.addEventListener("scroll", onChange, { passive: true });
  window.addEventListener("resize", onChange);
  return () => {
    window.removeEventListener("scroll", onChange);
    window.removeEventListener("resize", onChange);
  };
}

/**
 * The fixed strip the header floats in. Once the page has scrolled, it fades a dark backdrop in behind the
 * header so page content passes under it cleanly instead of showing between the pills. Over the landing's hero
 * the header also plays its entrance; on inner pages it holds still, so navigation does not replay it.
 */
export function HeaderBar({ children, isOverHero = false }: { children: ReactNode; isOverHero?: boolean }) {
  const isScrolled = useSyncExternalStore(
    subscribe,
    () => window.scrollY > (isOverHero ? window.innerHeight * HERO_FRACTION : INNER_PAGE_OFFSET),
    () => false,
  );

  return (
    <div className={`${styles.bar} ${isOverHero ? styles.entrance : ""}`} data-scrolled={isScrolled}>
      {children}
    </div>
  );
}
