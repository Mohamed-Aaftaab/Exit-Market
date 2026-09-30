"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";
import styles from "./landing.module.css";

export type NavItem = { href: string; label: string; isActive?: boolean; isExternal?: boolean };

const MOBILE_MAX = 720;

/** Burger + full-screen sheet shown at <= 720px. Closes on overlay click, Escape, link click or resize. */
export function MobileMenu({ items, launchHref, launchLabel }: { items: NavItem[]; launchHref: string; launchLabel: string }) {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const close = () => setIsOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const onResize = () => window.innerWidth > MOBILE_MAX && close();
    document.body.classList.add("menu-open");
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.body.classList.remove("menu-open");
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [isOpen]);

  return (
    <>
      <button
        type="button"
        className={styles.burger}
        aria-label={isOpen ? "Close menu" : "Open menu"}
        aria-expanded={isOpen}
        aria-controls="landing-menu"
        onClick={() => setIsOpen((open) => !open)}
      >
        <span />
        <span />
        <span />
      </button>
      {isOpen && (
        <div className={styles.overlay} onClick={() => setIsOpen(false)}>
          <nav id="landing-menu" className={styles.sheet} aria-label="Menu" onClick={(e) => e.stopPropagation()}>
            {items.map((item, i) => (
              <Link
                key={item.href}
                href={item.href}
                className={`${styles.sheetLink} ${item.isActive ? styles.active : ""}`}
                style={{ "--i": i } as CSSProperties}
                aria-current={item.isActive ? "page" : undefined}
                onClick={() => setIsOpen(false)}
                {...(item.isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              >
                {item.label}
              </Link>
            ))}
            <Link href={launchHref} className={styles.sheetLaunch} style={{ "--i": items.length } as CSSProperties} onClick={() => setIsOpen(false)}>
              {launchLabel}
            </Link>
          </nav>
        </div>
      )}
    </>
  );
}
