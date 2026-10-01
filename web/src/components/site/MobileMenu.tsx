"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { NAV, type PageId } from "./nav";
import styles from "./site.module.css";

const MOBILE_MAX = 720;

/** Burger + full-screen sheet shown at <= 720px. Closes on overlay click, Escape, link click or resize. */
export function MobileMenu({ active }: { active?: PageId }) {
  const [isOpen, setIsOpen] = useState(false);
  const burgerRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const burger = burgerRef.current;
    const main = document.querySelector("main");
    const close = () => setIsOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const onResize = () => window.innerWidth > MOBILE_MAX && close();
    document.body.classList.add("menu-open");
    main?.setAttribute("inert", ""); // the page under the overlay is out of the tab order while the menu is open
    sheetRef.current?.querySelector("a")?.focus();
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.body.classList.remove("menu-open");
      main?.removeAttribute("inert");
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      burger?.focus(); // the sheet unmounts: hand focus back instead of dropping it on <body>
    };
  }, [isOpen]);

  return (
    <>
      <button
        ref={burgerRef}
        type="button"
        className={styles.burger}
        aria-label={isOpen ? "Close menu" : "Open menu"}
        aria-expanded={isOpen}
        aria-controls={isOpen ? "site-menu" : undefined}
        onClick={() => setIsOpen((open) => !open)}
      >
        <span />
        <span />
        <span />
      </button>
      {isOpen && (
        <div className={styles.overlay} onClick={() => setIsOpen(false)}>
          <nav ref={sheetRef} id="site-menu" className={styles.sheet} aria-label="Menu" onClick={(e) => e.stopPropagation()}>
            {NAV.map((item, i) => (
              <Link
                key={item.id}
                href={item.href}
                className={`${styles.sheetLink} ${item.id === active ? styles.active : ""}`}
                style={{ "--i": i } as CSSProperties}
                aria-current={item.id === active ? "page" : undefined}
                onClick={() => setIsOpen(false)}
              >
                {item.label}
              </Link>
            ))}
            <Link href="/app" className={styles.sheetLaunch} style={{ "--i": NAV.length } as CSSProperties} onClick={() => setIsOpen(false)}>
              Launch app
            </Link>
          </nav>
        </div>
      )}
    </>
  );
}
