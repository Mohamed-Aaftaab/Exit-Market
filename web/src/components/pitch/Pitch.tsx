import Link from "next/link";
import type { ReactNode } from "react";
// The deck reuses the landing's content blocks (cards, steps, figures, proof rows) so both stay in step.
import land from "@/components/landing/landing.module.css";
import { Reveal } from "@/components/site/Reveal";
import { LIVE_PROOF, shortHash, txUrl } from "@/data/liveProof";
import snapshot from "@/data/mainnet-snapshot.json";
import { DeckControls } from "./DeckControls";
import styles from "./pitch.module.css";

const usdM = (usd: number, digits = 1) => `$${(usd / 1e6).toFixed(digits)}M`;

const TITLES = [
  "Exit Market", "The problem", "The money that waits", "Why it is unsolved", "The hook was already there",
  "How it works", "Verified on-chain", "Gasless exits", "Live on testnet", "Built on Arbitrum",
  "Security and quality", "Competition", "Business model", "What comes next",
];

const COMPETITORS: ReadonlyArray<[string, string, string, string]> = [
  ["Exit Market", "Yes, per withdrawal", "Rollup commitments only", "Any, once deployed for its gateways"],
  ["Native fast withdrawals", "Yes, if the chain opts in", "Validator committee", "Opt-in per chain"],
  ["Across", "No", "Relayers + UMA oracle", "None of the five"],
  ["Circle CCTP", "No", "Circle attestation", "USDC only, no L3s"],
  ["Stargate / Relay", "No", "Pools / solvers", "ApeChain only"],
];

const TECH: ReadonlyArray<[string, string]> = [
  ["Token bridge", "transferExitAndCall on the real parent gateways"],
  ["Outbox", "Leaves rebuilt byte for byte; NodeInterface proofs"],
  ["Orbit L3", "Live end to end on Xai Testnet"],
  ["BOLD", "A real pending Arbitrum One exit proven over its real pending chain (mainnet fork, ~1.3M gas)"],
  ["Stylus", "The proof core in Rust, live, with an honest gas benchmark"],
  ["Rollup nodes", "Pending legacy nodes already commit to their send roots"],
];

function Slide({ n, lit, center, children }: { n: number; lit?: boolean; center?: boolean; children: ReactNode }) {
  return (
    <section id={`slide-${n}`} className={`${styles.slide} ${lit ? styles.lit : ""}`} aria-label={`Slide ${n}: ${TITLES[n - 1]}`}>
      <Reveal className={`${styles.body} ${center ? styles.center : ""}`}>{children}</Reveal>
      <span className={styles.count} aria-hidden="true">
        {String(n).padStart(2, "0")} / {TITLES.length}
      </span>
    </section>
  );
}

function Problem() {
  const { flow30d, challengeWindow, stranded } = snapshot;
  return (
    <>
      <Slide n={2}>
        <p className="eyebrow">The problem</p>
        <p className={styles.giant}>6.4 days</p>
        <p className={styles.tagline}>Leaving Arbitrum the safe way takes a week. Once a withdrawal has started, nothing can speed it up.</p>
        <p className={styles.hint}>Challenge period: 45,818 L1 blocks on Arbitrum One and mainnet Orbit chains.</p>
      </Slide>
      <Slide n={3}>
        <p className="eyebrow">Arbitrum One → Ethereum · snapshot {snapshot.snapshot.date}</p>
        <h2 className={styles.title}>The money that waits</h2>
        <div className={land.figures} style={{ marginTop: 0 }}>
          <div className={`${land.card} ${land.figure}`}>
            <strong>{usdM(flow30d.tokenUsd, 0)}</strong>
            <span>in token withdrawals through the canonical bridge in 30 days</span>
          </div>
          <div className={`${land.card} ${land.figure}`}>
            <strong>{usdM(challengeWindow.tokenUsd)}</strong>
            <span>in tokens sitting in the challenge window on one day</span>
          </div>
          <div className={`${land.card} ${land.figure}`}>
            <strong>{usdM(stranded.allTime.usd, 2)}</strong>
            <span>in {stranded.allTime.count.toLocaleString("en-US")} exits that finished the wait and were never claimed</span>
          </div>
        </div>
        <p className={styles.hint}>Tokens only, from chain data, reproducible in research/stranded. Native ETH bypasses the token gateway unless withdrawn as WETH.</p>
      </Slide>
    </>
  );
}

function Insight() {
  return (
    <>
      <Slide n={4}>
        <p className="eyebrow">Why it is still unsolved</p>
        <h2 className={styles.title}>Nobody rescues a withdrawal in flight</h2>
        <div className={styles.grid3}>
          <div className={`${land.card} ${styles.cell}`}>
            <h3>Fast bridges</h3>
            <p>A route you pick before withdrawing, with its own relayers, oracles or attesters. Across lists none of Xai, ApeChain, RARI, Sanko or EDU Chain.</p>
          </div>
          <div className={`${land.card} ${styles.cell}`}>
            <h3>Native fast withdrawals</h3>
            <p>A chain-wide validator committee. Per Arbitrum&apos;s docs, such a chain &quot;would technically no longer be a Rollup&quot;.</p>
          </div>
          <div className={`${land.card} ${styles.cell} ${styles.ours}`}>
            <h3>Exit Market</h3>
            <p>Per withdrawal, after it started, on the chain as deployed. No committee, oracle or relayer decides validity.</p>
          </div>
        </div>
      </Slide>
      <Slide n={5}>
        <p className="eyebrow">The insight</p>
        <h2 className={styles.title}>The hook was already there</h2>
        <div className={styles.two}>
          <div className={styles.stack}>
            <code className={styles.code}>
              L1ArbitrumExtendedGateway.
              <wbr />
              transferExitAndCall(exitNum, …)
            </code>
            <p className={styles.text}>
              Every Arbitrum token gateway can hand a pending withdrawal to a new owner. Its source says: <i>&quot;It is assumed the
              _exitNum is validated off-chain.&quot;</i> So nobody could safely buy one. Exit Market is that missing validation, on-chain.
            </p>
          </div>
          <div className={styles.zeroBig}>
            <strong>0</strong>
            <span>WithdrawRedirected events on the Arbitrum One and Nova mainnet gateways</span>
          </div>
        </div>
      </Slide>
    </>
  );
}

function Mechanism() {
  const steps = [
    ["Withdraw", "A standard bridge withdrawal on the child chain"],
    ["Prove", "Leaf and Merkle path against a still-pending root"],
    ["Sell", "The vault pays USDG now and owns the exit"],
    ["Collect", "A permissionless keeper executes; LPs earn the discount"],
  ];
  const checks = [
    ["Market owns the exit", "gateway.getExternalCall(exitNum, initialDestination)"],
    ["Leaf is this withdrawal", "Outbox item rebuilt byte for byte, minimal Merkle path"],
    ["Root is real while pending", "Legacy: node.confirmData · BOLD: assertion chain · both: no rival at any pending level"],
    ["Not claimed yet", "!Outbox.isSpent(index)"],
  ];
  return (
    <>
      <Slide n={6}>
        <p className="eyebrow">How it works</p>
        <h2 className={styles.title}>One signature instead of a week</h2>
        <ol className={land.steps}>
          {steps.map(([title, body], i) => (
            <li key={title} className={`${land.card} ${land.step}`}>
              <span className={land.stepNum}>0{i + 1}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </li>
          ))}
        </ol>
        <p className={styles.text}>Sellable about 15 minutes after withdrawing, when the next rollup node posts, not 6.4 days later.</p>
      </Slide>
      <Slide n={7}>
        <p className="eyebrow">Verified on-chain, in the seller&apos;s transaction</p>
        <h2 className={styles.title}>Only Arbitrum&apos;s own commitments</h2>
        <div className={`${land.card} ${land.proof}`}>
          {checks.map(([check, how]) => (
            <div key={check} className={land.proofRow}>
              <p className={land.proofLabel}>{check}</p>
              <span className={land.tx}>{how}</span>
            </div>
          ))}
        </div>
        <p className={styles.text}>No oracle, no committee, and the market has no owner. The buyer&apos;s risk is a pending rollup node being rejected, which the vault prices and writes off; the moment a validator disputes it, it stops trading.</p>
      </Slide>
      <Slide n={8}>
        <p className="eyebrow">Gasless exits</p>
        <h2 className={styles.title}>No ETH on the other side? Sign once.</h2>
        <div className={styles.two}>
          <ol className={styles.stack} style={{ listStyle: "none", margin: 0, padding: 0 }}>
            <li className={styles.text}>01 · Withdraw on the child chain straight to the ExitIntentRouter.</li>
            <li className={styles.text}>02 · Sign one EIP-712 sell order. No gas, no transaction.</li>
            <li className={styles.text}>03 · Any relayer settles it into the vault and earns a small fee.</li>
          </ol>
          <div className={`${land.card} ${styles.cell} ${styles.ours}`}>
            <p className="eyebrow">Live · exit #7</p>
            <h3 style={{ fontSize: 44, letterSpacing: "-0.035em" }}>0 ETH</h3>
            <p>held by the seller on Arbitrum Sepolia, who still received the USDG.</p>
          </div>
        </div>
      </Slide>
    </>
  );
}

function Evidence() {
  const numbers = [["450", "tests: unit, fuzz, invariants, forks"], ["99.4%", "line coverage, production code"], ["6", "internal review rounds"], ["0", "open Slither findings, all triaged"]];
  return (
    <>
      <Slide n={9}>
        <p className="eyebrow">Live on testnet · Xai Testnet → Arbitrum Sepolia</p>
        <h2 className={styles.title}>Every step is a real transaction</h2>
        <div className={`${land.card} ${land.proof}`}>
          {LIVE_PROOF.map((tx) => (
            <div key={tx.hash} className={land.proofRow}>
              <p className={land.proofLabel}>{tx.label}</p>
              <a className={land.tx} href={txUrl(tx)} target="_blank" rel="noopener noreferrer">
                {shortHash(tx.hash)} <span aria-hidden="true">↗</span>
              </a>
            </div>
          ))}
        </div>
      </Slide>
      <Slide n={10}>
        <p className="eyebrow">Use of Arbitrum technology</p>
        <h2 className={styles.title}>Built on the protocol, not beside it</h2>
        <div className={styles.grid3}>
          {TECH.map(([name, body]) => (
            <div key={name} className={`${land.card} ${styles.cell}`}>
              <h3>{name}</h3>
              <p>{body}</p>
            </div>
          ))}
        </div>
      </Slide>
      <Slide n={11}>
        <p className="eyebrow">Security and quality</p>
        <h2 className={styles.title}>Every high finding fixed, with a regression test</h2>
        <div className={land.numbers}>
          {numbers.map(([value, label]) => (
            <div key={label} className={land.number}>
              <strong>{value}</strong>
              <span>{label}</span>
            </div>
          ))}
        </div>
        <p className={styles.text}>
          Round four found a critical balance-delta bug in the first router; round five found the same pattern in the market and an owner key
          that could allow a hostile gateway. Each was reproduced as an exploit test, fixed and redeployed; the live market now has no owner.
          AI-assisted internal reviews, not a third-party audit.
        </p>
      </Slide>
    </>
  );
}

function Market() {
  return (
    <>
      <Slide n={12}>
        <p className="eyebrow">Competition</p>
        <h2 className={styles.title}>Rescue an exit already in flight</h2>
        <div className={`${land.card} ${styles.scroll}`} tabIndex={0} role="region" aria-label="Competition table">
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Option</th>
                <th>Works after withdrawing?</th>
                <th>Trust for validity</th>
                <th>Orbit L3s</th>
              </tr>
            </thead>
            <tbody>
              {COMPETITORS.map((row, i) => (
                <tr key={row[0]} className={i === 0 ? styles.us : undefined}>
                  {row.map((cell) => (
                    <td key={cell}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.hint}>Sources checked 2026-09-29. On price, CCTP and Stargate are cheaper on the routes they serve; we do not compete there.</p>
      </Slide>
      <Slide n={13}>
        <p className="eyebrow">Business model · first 30 days on mainnet</p>
        <h2 className={styles.title}>Idle capital becomes yield</h2>
        <div className={styles.grid3} style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
          <div className={`${land.card} ${styles.cell}`}>
            <h3>Revenue</h3>
            <p>A 0.25% market fee to the protocol. The vault discount, about 0.27% for a full window, goes to LPs: roughly 15.7% APR gross at full utilisation.</p>
          </div>
          <div className={`${land.card} ${styles.cell}`}>
            <h3>KPIs</h3>
            <p>20+ exits from 10+ sellers, $100K+ face value. $50K+ vault TVL at 40%+ utilisation with zero write-offs. 5%+ of eligible in-window value bought.</p>
          </div>
        </div>
        <p className={styles.hint}>All measurable on-chain from ExitVerified, sale events and vault totalAssets.</p>
      </Slide>
    </>
  );
}

export function Pitch() {
  return (
    <div className={styles.deck}>
      <DeckControls titles={TITLES} />
      <Slide n={1} lit center>
        <p className="eyebrow">Arbitrum Open House Singapore · Buildathon</p>
        <h1 className={styles.cover}>Exit Market</h1>
        <p className={styles.tagline}>The safest way out of Arbitrum. Now instant.</p>
        <div className={styles.chips}>
          {["Live on Arbitrum Sepolia", "Xai Testnet · Orbit L3", "BOLD", "Stylus"].map((chip) => (
            <span key={chip} className={styles.chip}>
              {chip}
            </span>
          ))}
        </div>
        <p className={styles.hint}>Scroll, or use the arrow keys</p>
      </Slide>
      <Problem />
      <Insight />
      <Mechanism />
      <Evidence />
      <Market />
      <Slide n={14} lit center>
        <p className="eyebrow">What comes next</p>
        <h2 className={styles.title}>From Offchain Labs research to the deployed bridge</h2>
        <p className={styles.text}>
          Moosavi, Salehi, Goldman &amp; Clark (AFT 2023) showed tradeable exits on a modified Nitro. Exit Market runs on the bridge that is
          already live. Next: Arbitrum One → Ethereum on mainnet with the BOLD verifier, one vault per asset, and an instant-exit button in
          Orbit chains&apos; own bridge UIs.
        </p>
        <div className={land.actions} style={{ marginTop: 0 }}>
          <Link href="/app" className="btn-primary">
            Open the desk
          </Link>
          <Link href="/explorer" className="btn-dark">
            See it live in the Explorer
          </Link>
        </div>
      </Slide>
    </div>
  );
}
