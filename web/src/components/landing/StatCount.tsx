"use client";

import { useEffect, useRef } from "react";
import styles from "./landing.module.css";

type Props = {
  target: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  /** Position in the row: staggers the start and lengthens the count slightly. */
  index: number;
};

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

function format(value: number, decimals: number, prefix: string, suffix: string): string {
  const number = value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${prefix}${number}${suffix}`;
}

/** Counts up to `target` once, when the stat first scrolls into view. Server-renders the final value. */
export function StatCount({ target, decimals = 0, prefix = "", suffix = "", index }: Props) {
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || target === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    let timer = 0;
    const duration = 1500 + index * 80;
    const run = () => {
      const started = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - started) / duration);
        el.textContent = format(target * easeOutCubic(t), decimals, prefix, suffix);
        if (t < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        el.textContent = format(0, decimals, prefix, suffix);
        timer = window.setTimeout(run, 480 + index * 90);
      },
      { threshold: 0.25 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, [target, decimals, prefix, suffix, index]);

  return (
    <p ref={ref} className={styles.statValue}>
      {format(target, decimals, prefix, suffix)}
    </p>
  );
}
