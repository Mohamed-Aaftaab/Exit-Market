import Link from "next/link";
import type { CSSProperties } from "react";
import snapshot from "@/data/mainnet-snapshot.json";
import { BackgroundVideo } from "./BackgroundVideo";
import styles from "./landing.module.css";
import { StatCount } from "./StatCount";

/** 45,818 L1 blocks at 12 s: the challenge period a sold exit no longer waits for. */
export const CHALLENGE_DAYS = (45_818 * 12) / 86_400;

type Stat = { icon: string; target: number; decimals?: number; prefix?: string; suffix?: string; label: string };

// Figures come from the reproducible mainnet snapshot (research/stranded), not from literals.
const STATS: Stat[] = [
  { icon: "<", target: CHALLENGE_DAYS, decimals: 1, suffix: " days", label: "Challenge period skipped" },
  { icon: "$", target: snapshot.flow30d.tokenUsd / 1e6, prefix: "$", suffix: "M", label: "Withdrawn in 30 days" },
  { icon: "#", target: snapshot.stranded.allTime.count, label: "Exits never claimed" },
  { icon: "*", target: 0, label: "Mainnet uses of the hook, ever" },
];

// Abstract glyphs for the three layers a withdrawal crosses (stacked L3, a rollup cell, the base chain).
const CHAIN_ICONS = [
  <path key="l3" d="M12 3 3 8l9 5 9-5-9-5Zm-7.6 8.6L3 12.4l9 5 9-5-1.4-.8L12 15.8l-7.6-4.2Zm0 4.2L3 16.6l9 5 9-5-1.4-.8L12 20l-7.6-4.2Z" />,
  <path key="l2" fillRule="evenodd" d="M12 2.5 3.8 7.25v9.5L12 21.5l8.2-4.75v-9.5L12 2.5Zm0 3.5 5.2 3v6L12 18l-5.2-3V9L12 6Z" />,
  <path key="l1" d="M12 2 5.5 12.2 12 16l6.5-3.8L12 2Zm-6.5 11.6L12 22l6.5-8.4L12 17.4l-6.5-3.8Z" />,
];

const delay = (seconds: number) => ({ "--d": `${seconds}s` }) as CSSProperties;

/** First viewport: the full-bleed video, the status row, the dot-matrix headline, one action and four stats. */
export function Hero() {
  return (
    <section className={styles.hero}>
      <BackgroundVideo />
      <div className={styles.heroTop} />

      <div className={styles.heroBody}>
        <div className={`${styles.trust} ${styles.anim}`}>
          {CHAIN_ICONS.map((icon) => (
            <span key={icon.key} className={styles.ring}>
              <span className={styles.ringInner}>
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  {icon}
                </svg>
              </span>
            </span>
          ))}
          <span className={styles.trustPill}>Live on Arbitrum Sepolia + Xai Testnet</span>
        </div>

        <h1 className={styles.headline}>
          <span>Exit Arbitrum</span>
          <span>Without The Wait</span>
        </h1>

        <p className={`${styles.sub} ${styles.anim}`}>
          Sell a canonical-bridge withdrawal while it is still in its 6.4-day challenge period, proven on-chain
          against the rollup&apos;s own commitments.
        </p>

        <Link href="/app" className={`btn-primary ${styles.cta} ${styles.anim}`}>
          Get Started
        </Link>
      </div>

      <div className={styles.stats} role="group" aria-label="Key numbers">
        {STATS.map((stat, i) => (
          <div key={stat.label} className={`${styles.stat} ${styles.anim}`} style={delay(0.5 + i * 0.08)}>
            <span className={styles.statIcon} aria-hidden="true">
              {stat.icon}
            </span>
            <StatCount target={stat.target} decimals={stat.decimals} prefix={stat.prefix} suffix={stat.suffix} index={i} />
            <span className={styles.statLabel}>{stat.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
