import Link from "next/link";
import { APP_NAME } from "@/lib/format";
import { NAV, REPO_URL, VIDEO_URL } from "./nav";
import styles from "./site.module.css";

const BUILT_WITH = ["Arbitrum Sepolia", "Xai Testnet · Orbit L3", "BOLD assertions", "Stylus · Rust", "Paxos USDG"];

/** Link when we have a URL, plain text otherwise (the repo and video links arrive at submission). */
function MaybeLink({ href, children }: { href?: string; children: string }) {
  if (!href) return <span className={styles.footerLink}>{children}</span>;
  return (
    <a className={styles.footerLink} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.footerGrid}>
        <div>
          <p className={styles.footerBrand}>{APP_NAME}</p>
          <p className={styles.footerNote}>
            Sell a canonical-bridge withdrawal while it is still inside its challenge period, proven on-chain against the
            rollup&apos;s own commitments.
          </p>
        </div>
        <div>
          <p className={styles.footerHead}>App</p>
          {NAV.map((item) => (
            <Link key={item.id} href={item.href} className={styles.footerLink}>
              {item.label}
            </Link>
          ))}
        </div>
        <div>
          <p className={styles.footerHead}>Built with</p>
          {BUILT_WITH.map((name) => (
            <span key={name} className={styles.footerLink}>
              {name}
            </span>
          ))}
        </div>
        <div>
          <p className={styles.footerHead}>Project</p>
          <MaybeLink href={REPO_URL}>Source code</MaybeLink>
          <MaybeLink href={REPO_URL && `${REPO_URL}/blob/main/docs/SECURITY.md`}>Security model</MaybeLink>
          <MaybeLink href={REPO_URL && `${REPO_URL}/tree/main/research/stranded`}>Research data</MaybeLink>
          <MaybeLink href={VIDEO_URL}>Demo video</MaybeLink>
        </div>
      </div>
      <div className={styles.footerMeta}>
        <span>Built for the Arbitrum Open House Singapore Buildathon · testnet software, not audited by a third party</span>
        <span>
          Font made from{" "}
          <a href="https://www.onlinewebfonts.com/fonts" target="_blank" rel="noopener noreferrer">
            Web Fonts
          </a>{" "}
          is licensed by CC BY 4.0
        </span>
      </div>
    </footer>
  );
}
