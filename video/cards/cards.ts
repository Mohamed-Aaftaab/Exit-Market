/**
 * Text cards and transparent overlays for the demo video, rendered as HTML with the project fonts.
 * Usage: node video/cards/cards.ts   ->  video/out/cards/<name>.png (1920x1080)
 * Every figure here is sourced: research/stranded (snapshot 2026-09-29), deployments/, docs/audit/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const OUT = resolve("video/out/cards");
const FONTS = pathToFileURL(resolve("video/assets/fonts")).href;
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

const BASE_CSS = `
@font-face { font-family: Inter; src: url(${FONTS}/Inter-Regular.ttf); font-weight: 400; }
@font-face { font-family: Inter; src: url(${FONTS}/Inter-SemiBold.ttf); font-weight: 600; }
@font-face { font-family: Inter; src: url(${FONTS}/Inter-Bold.ttf); font-weight: 700; }
@font-face { font-family: Mono; src: url(${FONTS}/JetBrainsMono-Regular.ttf); font-weight: 400; }
@font-face { font-family: Mono; src: url(${FONTS}/JetBrainsMono-Bold.ttf); font-weight: 700; }
* { margin: 0; box-sizing: border-box; }
html, body { width: 1920px; height: 1080px; font-family: Inter, sans-serif; color: #fff; }
/* Same language as the site: black canvas lit from above, white type, dark pills with a hairline border. */
.full { background: radial-gradient(ellipse 72% 70% at 50% 0%, rgba(198, 212, 240, 0.2), rgba(198, 212, 240, 0.05) 45%, transparent 72%), #000;
  width: 100%; height: 100%; padding: 140px 160px; display: flex; flex-direction: column; justify-content: center; gap: 36px; }
.eyebrow { display: flex; align-items: center; gap: 26px; font-size: 27px; font-weight: 600; letter-spacing: 5px; text-transform: uppercase; }
.eyebrow::before { content: ""; width: 7px; height: 7px; margin-left: 12px; background: currentColor;
  box-shadow: -12px 0 0 currentColor, 12px 0 0 currentColor; }
.title { font-size: 84px; font-weight: 600; line-height: 1.05; letter-spacing: -2.5px; }
.body { font-size: 36px; line-height: 1.45; color: rgba(208, 208, 208, 0.8); max-width: 1500px; }
.stats { display: flex; gap: 72px; margin-top: 20px; }
.stat b { display: block; font-size: 68px; font-weight: 600; letter-spacing: -2px; color: #fff; }
.stat span { font-size: 26px; color: #8e8e8e; }
.lower { position: absolute; left: 120px; bottom: 270px; padding: 30px 44px; border-radius: 40px;
  background: rgba(20, 20, 21, 0.8); border: 1px solid rgba(255, 255, 255, 0.4); backdrop-filter: blur(6px); }
.lower b { display: block; font-size: 80px; font-weight: 600; letter-spacing: -2.5px; line-height: 1; }
.lower span { display: block; margin-top: 12px; font-size: 30px; color: #c4c2c3; max-width: 900px; }
/* Top right, beside the app's header: the desk's status lines sit along the bottom edge of the frame. */
.tag { position: absolute; right: 44px; top: 40px; padding: 10px 18px; border-radius: 999px; font-family: Mono;
  font-size: 20px; letter-spacing: 0.5px; background: rgba(40, 40, 42, 0.9); border: 1px solid rgba(255, 255, 255, 0.4); color: #4fd39a; }
.src { position: absolute; left: 160px; bottom: 70px; font-family: Mono; font-size: 22px; color: #7c7c7c; }
`;

const WHITE = "#ffffff";
const AMBER = "#e6ad55";
const RED = "#f2776f";
const GREEN = "#4fd39a";

type Card = { name: string; transparent?: boolean; html: string };

const lower = (value: string, label: string, color: string) =>
  `<div class="lower"><b style="color:${color}">${value}</b><span>${label}</span></div>`;

const CARDS: Card[] = [
  { name: "stakes-1", transparent: true, html: lower("$51M", "in token withdrawals left Arbitrum One for Ethereum in 30 days", WHITE) },
  { name: "stakes-2", transparent: true, html: lower("$10.2M", "in tokens sat in the challenge window on the day we measured", AMBER) },
  { name: "stakes-3", transparent: true, html: lower("$5.06M", "3,276 exits finished the wait and were never claimed", RED) },
  {
    name: "zero",
    transparent: true,
    html: lower("0", "WithdrawRedirected events ever emitted by the Arbitrum One and Nova mainnet gateways", AMBER),
  },
  { name: "live-tag", transparent: true, html: `<div class="tag">● LIVE · real transactions</div>` },
  {
    name: "skip",
    html: `<div class="full"><p class="eyebrow" style="color:${AMBER}">~15 minutes later</p>
      <p class="title">The next rollup node is posted.</p>
      <p class="body">The withdrawal is now committed to a pending send root: provable on-chain, 6.4 days before it could be claimed.</p></div>`,
  },
  {
    name: "bold",
    html: `<div class="full"><p class="eyebrow" style="color:#8e8e8e">Arbitrum One · BOLD</p>
      <p class="title">A real pending mainnet withdrawal, proven and listed.</p>
      <p class="body">On an Ethereum mainnet fork, Exit Market registers the real BOLD assertion chain and lists a real pending
      Arbitrum One withdrawal through the real L1 gateway. Every pending ancestor must be unchallenged.</p>
      <div class="stats"><div class="stat"><b>137</b><span>pending assertions walked</span></div>
      <div class="stat"><b>1.1M</b><span>gas for the whole walk</span></div>
      <div class="stat"><b>504.7</b><span>LINK in the withdrawal</span></div></div></div>
      <p class="src">contracts/test/fork/ArbOneBoldFork.t.sol</p>`,
  },
  {
    name: "stylus",
    html: `<div class="full"><p class="eyebrow" style="color:#8e8e8e">Stylus · Rust → WASM</p>
      <p class="title">The proof verifier also runs in Rust.</p>
      <p class="body">The Outbox leaf and Merkle checks, compiled to WASM and activated on Arbitrum Sepolia. Checked on-chain against a
      real Xai Testnet send root, with an honest gas benchmark against the Solidity twin.</p></div>
      <p class="src">0x30ac015003186f187b9a11fff2781d55cc9e1394 · docs/audit/STYLUS_BENCH.json</p>`,
  },
  {
    name: "quality",
    html: `<div class="full"><p class="eyebrow" style="color:${GREEN}">Built to be trusted</p>
      <p class="title">Five review rounds. Every high reproduced, fixed and tested.</p>
      <div class="stats"><div class="stat"><b>413</b><span>Solidity tests, incl. fuzz &amp; invariants</span></div>
      <div class="stat"><b>0</b><span>open Slither findings, all triaged</span></div>
      <div class="stat"><b>9</b><span>mainnet &amp; Xai fork tests</span></div></div>
      <p class="body">Internal AI-assisted review (not a third-party audit): threat model and findings in docs/SECURITY.md.</p></div>`,
  },
];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  for (const card of CARDS) {
    const file = resolve(OUT, `_${card.name}.html`);
    const bg = card.transparent ? "background: transparent;" : "background: #000;";
    writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS} body{${bg}}</style></head><body>${card.html}</body></html>`);
    await page.goto(pathToFileURL(file).href);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: resolve(OUT, `${card.name}.png`), omitBackground: card.transparent ?? false });
    console.log(`card ${card.name}`);
  }
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
