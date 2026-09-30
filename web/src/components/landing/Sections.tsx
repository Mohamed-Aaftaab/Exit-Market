import Link from "next/link";
import { LIVE_PROOF, shortHash, txUrl } from "@/data/liveProof";
import snapshot from "@/data/mainnet-snapshot.json";
import { Reveal } from "@/components/site/Reveal";
import styles from "./landing.module.css";

const usdM = (usd: number, digits = 1) => `$${(usd / 1e6).toFixed(digits)}M`;

const STACK = [
  ["Token bridge", "transferExitAndCall"],
  ["Outbox", "Merkle proofs"],
  ["Rollup", "Pending nodes + BOLD"],
  ["Orbit", "Live on Xai Testnet"],
  ["Stylus", "Rust verifier, benchmarked"],
] as const;

const STEPS = [
  ["Withdraw", "Start a standard bridge withdrawal on the child chain. Nothing special, nothing extra to trust."],
  ["Prove", "About 15 minutes later the next rollup node posts. Exit Market rebuilds your withdrawal and proves it sits in that node's send root."],
  ["Sell", "The vault pays you now and becomes the owner of the exit, inside the gateway's own hook, in one transaction."],
  ["Collect", "When the challenge period ends a permissionless keeper executes the exit and the vault collects face value."],
] as const;

const FEATURES = [
  {
    kicker: "On-chain",
    title: "Proof, not trust",
    body: "Every check runs inside the seller's transaction, against Arbitrum's own contracts. No oracle, no committee, and the market has no owner.",
    rows: [["Ownership", "getExternalCall"], ["Withdrawal", "leaf + Merkle path"], ["Root", "pending node / BOLD"], ["Unclaimed", "!Outbox.isSpent"]],
  },
  {
    kicker: "Gasless",
    title: "Sign once, get paid",
    body: "Withdraw straight to the router and sign one order. A relayer settles it and pays the gas, so you never need ETH on the other side.",
    rows: [["Order", "EIP-712"], ["Seller gas", "0 ETH"], ["Relayer fee", "0.02 USDG"]],
    isRaised: true,
  },
  {
    kicker: "Liquidity",
    title: "The wait becomes yield",
    body: "An ERC-4626 vault buys exits at a small discount and collects face value at confirmation. The discount accrues to LPs.",
    rows: [["Vault", "ERC-4626 · USDG"], ["Pricing", "0.10% + 10% APR"], ["Buyer risk", "a rejected node"]],
  },
] as const;

const NUMBERS = [
  ["137", "pending BOLD assertions walked for a real Arbitrum One exit (mainnet fork)"],
  ["1.1M", "gas for that whole ancestor walk, measured on a mainnet fork"],
  ["422", "tests: unit, fuzz, invariants, exploit regressions, mainnet forks"],
  ["99.4%", "line coverage of the production contracts"],
] as const;

function Head({ eyebrow, title, lead }: { eyebrow: string; title: string; lead?: string }) {
  return (
    <Reveal className={styles.head}>
      <p className="eyebrow">{eyebrow}</p>
      <h2 className={styles.h2}>{title}</h2>
      {lead && <p className={styles.lead}>{lead}</p>}
    </Reveal>
  );
}

function Stack() {
  return (
    <section className={styles.section} style={{ paddingBottom: 0 }} aria-label="Built on Arbitrum">
      <Reveal className={`${styles.inner} ${styles.card} ${styles.strip}`}>
        {STACK.map(([label, value]) => (
          <div key={label} className={styles.stripCell}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </Reveal>
    </section>
  );
}

function Problem() {
  const { flow30d, challengeWindow, stranded, snapshot: meta } = snapshot;
  const figures = [
    [usdM(flow30d.tokenUsd, 0), "in token withdrawals left Arbitrum One through the canonical bridge in 30 days"],
    [usdM(challengeWindow.tokenUsd), "in tokens sat in the challenge window on the day we measured"],
    [usdM(stranded.allTime.usd, 2), `in ${stranded.allTime.count.toLocaleString("en-US")} exits finished the wait and were never claimed`],
  ];
  return (
    <section className={styles.section} id="problem">
      <div className={styles.inner}>
        <div className={styles.split}>
          <Reveal className={`${styles.card} ${styles.waitCard}`}>
            <p className="eyebrow">Challenge period</p>
            <p className={styles.waitBig}>
              6.4<small>days</small>
            </p>
            <div>
              <div className={styles.days} aria-hidden="true">
                {Array.from({ length: 7 }, (_, i) => (
                  <i key={i} />
                ))}
              </div>
              <p className={styles.waitNote} style={{ marginTop: 12 }}>
                45,818 L1 blocks before a withdrawal can be claimed
              </p>
            </div>
          </Reveal>
          <Reveal className={styles.copy} delay={0.12}>
            <p className="eyebrow">The problem</p>
            <h2 className={styles.h2}>Withdrawals wait a week</h2>
            <p>
              The canonical bridge is the only way out of Arbitrum that needs no trust beyond the rollup itself. It is also
              locked for 6.4 days, and once a withdrawal has started, nothing can speed it up.
            </p>
            <p>
              Fast bridges are a route you pick before you withdraw, with their own relayers and oracles. Nothing rescues
              a withdrawal that is already in flight.
            </p>
            <div className={styles.zero}>
              <strong>0</strong>
              <span>
                times the bridge&apos;s own exit-transfer hook had been used on mainnet. The gateway cannot tell a real
                withdrawal from a fake one, so nobody could safely buy one.
              </span>
            </div>
          </Reveal>
        </div>
        <div className={styles.figures}>
          {figures.map(([value, label], i) => (
            <Reveal key={label} className={`${styles.card} ${styles.figure}`} delay={i * 0.08}>
              <strong>{value}</strong>
              <span>{label}</span>
            </Reveal>
          ))}
        </div>
        <p className={styles.source}>
          Arbitrum One → Ethereum, snapshot {meta.date}, tokens only. Reproducible from chain data in research/stranded.
        </p>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section className={styles.section} id="how">
      <div className={styles.inner}>
        <Head
          eyebrow="How it works"
          title="One signature instead of a week"
          lead="Arbitrum's token gateway has always let the owner of a pending withdrawal hand it to someone else. Exit Market adds the missing piece: proving on-chain that the withdrawal is real."
        />
        <ol className={styles.steps}>
          {STEPS.map(([title, body], i) => (
            <Reveal as="li" key={title} delay={i * 0.08}>
              <div className={`${styles.card} ${styles.step}`}>
                <span className={styles.stepNum}>0{i + 1}</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section className={styles.section} id="features">
      <div className={styles.inner}>
        <Head eyebrow="What you get" title="Built for the exit" />
        <div className={styles.features}>
          {FEATURES.map((feature, i) => (
            <Reveal as="article" key={feature.title} delay={i * 0.08} className={`${styles.card} ${styles.feature} ${"isRaised" in feature ? styles.raised : ""}`}>
              <span className={styles.kicker}>{feature.kicker}</span>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
              <dl className={styles.rows}>
                {feature.rows.map(([term, value]) => (
                  <div key={term}>
                    <dt>{term}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function LiveProof() {
  return (
    <section className={styles.section} id="proof">
      <div className={styles.inner}>
        <Head
          eyebrow="Live on testnet"
          title="Every step is a real transaction"
          lead="Xai Testnet to Arbitrum Sepolia, end to end. Open any of them."
        />
        <Reveal className={`${styles.card} ${styles.proof}`}>
          {LIVE_PROOF.map((tx) => (
            <div key={tx.hash} className={styles.proofRow}>
              <p className={styles.proofLabel}>
                {tx.label}
                <small>{tx.detail}</small>
              </p>
              <a className={styles.tx} href={txUrl(tx)} target="_blank" rel="noopener noreferrer">
                {shortHash(tx.hash)} <span aria-hidden="true">↗</span>
              </a>
            </div>
          ))}
        </Reveal>
        <div className={styles.actions}>
          <Link href="/explorer" className="btn-dark">
            See every exit in the Explorer
          </Link>
        </div>
      </div>
    </section>
  );
}

function Depth() {
  return (
    <section className={styles.section} id="depth">
      <div className={styles.inner}>
        <Head
          eyebrow="Beyond the demo"
          title="Proven against mainnet"
          lead="Arbitrum One runs BOLD, so the verifier walks real pending assertions. Five internal review rounds; every high-severity finding reproduced, fixed and covered by a regression test. Not a third-party audit."
        />
        <div className={styles.numbers}>
          {NUMBERS.map(([value, label], i) => (
            <Reveal key={label} className={styles.number} delay={i * 0.08}>
              <strong>{value}</strong>
              <span>{label}</span>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section className={styles.section}>
      <Reveal className={`${styles.inner} ${styles.card} ${styles.closing}`}>
        <p className="eyebrow">Ready when you are</p>
        <h2 className={styles.h2}>Exit without the wait</h2>
        <p className={styles.lead}>Connect a wallet on Xai Testnet, start a withdrawal, and sell it as soon as the next node posts.</p>
        <div className={styles.actions} style={{ marginTop: 8 }}>
          <Link href="/app" className="btn-primary">
            Open the desk
          </Link>
          <Link href="/pitch" className="btn-dark">
            Read the pitch
          </Link>
        </div>
      </Reveal>
    </section>
  );
}

export function Sections() {
  return (
    <>
      <Stack />
      <Problem />
      <HowItWorks />
      <Features />
      <LiveProof />
      <Depth />
      <Closing />
    </>
  );
}
