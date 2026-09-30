import Link from "next/link";
import type { CSSProperties } from "react";
import snapshot from "@/data/mainnet-snapshot.json";
import { APP_NAME } from "@/lib/format";
import { BackgroundVideo } from "./BackgroundVideo";
import { doto, inter } from "./fonts";
import styles from "./landing.module.css";
import { MobileMenu, type NavItem } from "./MobileMenu";
import { StatCount } from "./StatCount";

const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL;
/** 45,818 L1 blocks at 12 s: the challenge period a sold exit no longer waits for. */
const CHALLENGE_DAYS = (45_818 * 12) / 86_400;

const NAV: NavItem[] = [
  { href: "/", label: "Home", isActive: true },
  { href: "/app", label: "Desk" },
  { href: "/explorer", label: "Explorer" },
  ...(REPO_URL ? [{ href: REPO_URL, label: "Docs", isExternal: true }] : []),
];

// The chains a withdrawal crosses, in the colours of the 3D layers: Orbit L3, Arbitrum, Ethereum.
const CHAIN_COLORS = ["#3fd0c9", "#28a0f0", "#8c8dfc"];

type Stat = { icon: string; target: number; decimals?: number; prefix?: string; suffix?: string; label: string };

// Figures come from the reproducible mainnet snapshot (research/stranded), not from literals.
const STATS: Stat[] = [
  { icon: "<", target: CHALLENGE_DAYS, decimals: 1, suffix: " days", label: "Challenge period skipped" },
  { icon: "$", target: snapshot.flow30d.tokenUsd / 1e6, prefix: "$", suffix: "M", label: "Withdrawn in 30 days" },
  { icon: "#", target: snapshot.stranded.allTime.count, label: "Exits never claimed" },
  { icon: "*", target: 0, label: "Mainnet uses before us" },
];

const delay = (seconds: number) => ({ "--d": `${seconds}s` }) as CSSProperties;

function LogoMark() {
  // Three chain layers with a withdrawal passing straight through them.
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="#0b0e13">
      <rect x="10" y="2.5" width="4" height="19" rx="2" />
      {[6, 12, 18].map((y) => (
        <g key={y}>
          <rect x="2.5" y={y - 1.1} width="5.8" height="2.2" rx="1.1" />
          <rect x="15.7" y={y - 1.1} width="5.8" height="2.2" rx="1.1" />
        </g>
      ))}
    </svg>
  );
}

export function Landing() {
  return (
    <div className={`${styles.page} ${inter.variable} ${doto.variable}`}>
      <BackgroundVideo />

      <header className={styles.header}>
        <Link href="/" className={styles.logo} aria-label={`${APP_NAME} home`}>
          <LogoMark />
        </Link>
        <nav className={styles.nav} aria-label="Main">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.navLink} ${item.isActive ? styles.active : ""}`}
              aria-current={item.isActive ? "page" : undefined}
              {...(item.isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <Link href="/app" className={styles.launch}>
          Launch app
        </Link>
        <MobileMenu items={NAV} launchHref="/app" launchLabel="Launch app" />
      </header>

      <main className={styles.hero}>
        <div className={`${styles.trust} ${styles.anim}`}>
          {CHAIN_COLORS.map((color) => (
            <span key={color} className={styles.ring}>
              <span className={styles.ringInner}>
                <span className={styles.chainDot} style={{ background: color }} />
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

        <Link href="/app" className={`${styles.cta} ${styles.anim}`}>
          Open the desk
        </Link>
      </main>

      <section className={styles.stats} aria-label="Key numbers">
        {STATS.map((stat, i) => (
          <div key={stat.label} className={`${styles.stat} ${styles.anim}`} style={delay(0.5 + i * 0.08)}>
            <span className={styles.statIcon} aria-hidden="true">
              {stat.icon}
            </span>
            <StatCount target={stat.target} decimals={stat.decimals} prefix={stat.prefix} suffix={stat.suffix} index={i} />
            <span className={styles.statLabel}>{stat.label}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
