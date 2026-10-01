import Link from "next/link";
import type { ReactNode } from "react";
import { APP_NAME } from "@/lib/format";
import { HeaderBar } from "./HeaderBar";
import { LogoMark } from "./LogoMark";
import { MobileMenu } from "./MobileMenu";
import { NAV, type PageId } from "./nav";
import styles from "./site.module.css";

/**
 * The floating header every page shares: logo disc, white pill nav with the three-dot active marker, and a dark
 * pill on the right. `action` replaces the default "Launch app" pill (the desk puts its wallet button there);
 * `isOverHero` keeps the header bare while the landing's video hero is behind it.
 */
export function SiteNav({ active, action, isOverHero }: { active?: PageId; action?: ReactNode; isOverHero?: boolean }) {
  return (
    <HeaderBar isOverHero={isOverHero}>
      <header className={styles.header}>
        <Link href="/" className={styles.logo} aria-label={`${APP_NAME} home`}>
          <LogoMark />
        </Link>
        <nav className={styles.nav} aria-label="Main">
          {NAV.map((item) => (
            <Link
              key={item.id}
              href={item.href}
              className={`${styles.navLink} ${item.id === active ? styles.active : ""}`}
              aria-current={item.id === active ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        {action ? (
          <div className={styles.action}>{action}</div>
        ) : (
          <Link href="/app" className={`${styles.action} ${styles.pill} ${styles.launch}`}>
            Launch app
          </Link>
        )}
        <MobileMenu active={active} />
      </header>
    </HeaderBar>
  );
}
