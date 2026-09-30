import type { ReactNode } from "react";
import type { PageId } from "./nav";
import { SiteFooter } from "./SiteFooter";
import { SiteNav } from "./SiteNav";
import styles from "./site.module.css";

type Props = {
  active: PageId;
  eyebrow: string;
  title: string;
  lead?: ReactNode;
  /** Replaces the header's "Launch app" pill (the desk puts its wallet button there). */
  action?: ReactNode;
  children: ReactNode;
};

/** Frame shared by every inner page: the floating header, light from above, a display-font title, the footer. */
export function PageShell({ active, eyebrow, title, lead, action, children }: Props) {
  return (
    <div className={styles.shell}>
      <div className={styles.glow} aria-hidden="true" />
      <SiteNav active={active} action={action} />
      <main className={styles.shellMain}>
        <div className={`${styles.pageHead} reveal`}>
          <p className="eyebrow">{eyebrow}</p>
          <h1 className={styles.pageTitle}>{title}</h1>
          {lead && <p className={styles.pageLead}>{lead}</p>}
        </div>
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
