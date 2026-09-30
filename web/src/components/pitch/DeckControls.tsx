"use client";

import { useEffect, useState } from "react";
import styles from "./pitch.module.css";

const slideId = (i: number) => `slide-${i + 1}`;

/** Progress rail plus keyboard paging (arrows, PageUp/PageDown, Space, Home/End) for the pitch deck. */
export function DeckControls({ titles }: { titles: string[] }) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const slides = titles.map((_, i) => document.getElementById(slideId(i))).filter((el): el is HTMLElement => el !== null);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(slides.indexOf(entry.target as HTMLElement));
        }
      },
      { rootMargin: "-45% 0px -45% 0px" }, // the slide crossing the middle of the viewport is the current one
    );
    slides.forEach((slide) => observer.observe(slide));
    return () => observer.disconnect();
  }, [titles]);

  useEffect(() => {
    const go = (index: number) => {
      const target = Math.max(0, Math.min(titles.length - 1, index));
      const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
      document.getElementById(slideId(target))?.scrollIntoView({ behavior, block: "start" });
    };
    const onKey = (e: KeyboardEvent) => {
      // Leave browser shortcuts (Alt+Left, Ctrl+End, Shift+Space), form fields, the scrollable table and the
      // open mobile menu alone; Space still activates a focused button or link.
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (document.body.classList.contains("menu-open")) return;
      const focused = e.target instanceof HTMLElement ? e.target : null;
      if (focused?.closest("input, textarea, select, [contenteditable], [role='region']")) return;
      if (e.key === " " && focused?.closest("button, a")) return;
      const step: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, PageDown: 1, " ": 1, ArrowUp: -1, ArrowLeft: -1, PageUp: -1 };
      if (e.key in step) {
        e.preventDefault();
        go(active + step[e.key]);
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        go(e.key === "Home" ? 0 : titles.length - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, titles.length]);

  return (
    <nav className={styles.rail} aria-label="Slides">
      {titles.map((title, i) => (
        <a key={title} href={`#${slideId(i)}`} className={styles.dot} aria-label={`Slide ${i + 1}: ${title}`} aria-current={i === active} />
      ))}
    </nav>
  );
}
