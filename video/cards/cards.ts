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
html, body { width: 1920px; height: 1080px; font-family: Inter, sans-serif; color: #e8ebf0; }
.full { background: radial-gradient(ellipse at 30% 20%, #111a2b 0%, #07090d 70%); width: 100%; height: 100%;
  padding: 140px 160px; display: flex; flex-direction: column; justify-content: center; gap: 36px; }
.eyebrow { font-family: Mono; font-size: 30px; letter-spacing: 4px; text-transform: uppercase; }
.title { font-size: 84px; font-weight: 700; line-height: 1.05; letter-spacing: -1.5px; }
.body { font-size: 36px; line-height: 1.45; color: #aeb7c5; max-width: 1500px; }
.stats { display: flex; gap: 72px; margin-top: 20px; }
.stat b { display: block; font-family: Mono; font-size: 64px; font-weight: 700; color: #e8ebf0; }
.stat span { font-size: 26px; color: #8b95a5; }
.lower { position: absolute; left: 120px; bottom: 270px; padding: 30px 42px; border-radius: 18px;
  background: rgba(7, 9, 13, 0.72); border: 1px solid rgba(76, 147, 245, 0.35); backdrop-filter: blur(6px); }
.lower b { display: block; font-family: Mono; font-size: 76px; font-weight: 700; line-height: 1; }
.lower span { display: block; margin-top: 12px; font-size: 30px; color: #c3cad5; max-width: 900px; }
.tag { position: absolute; left: 48px; bottom: 40px; padding: 10px 18px; border-radius: 999px; font-family: Mono;
  font-size: 22px; letter-spacing: 1px; background: rgba(7, 9, 13, 0.78); border: 1px solid rgba(63, 191, 136, 0.55); color: #3fbf88; }
.src { position: absolute; left: 160px; bottom: 70px; font-family: Mono; font-size: 22px; color: #6b7686; }
`;

type Card = { name: string; transparent?: boolean; html: string };

const lower = (value: string, label: string, color: string) =>
  `<div class="lower"><b style="color:${color}">${value}</b><span>${label}</span></div>`;

const CARDS: Card[] = [
  { name: "stakes-1", transparent: true, html: lower("$51M", "in token withdrawals left Arbitrum One for Ethereum in 30 days", "#4c93f5") },
  { name: "stakes-2", transparent: true, html: lower("$10.2M", "in tokens sat in the challenge window on the day we measured", "#e0a345") },
  { name: "stakes-3", transparent: true, html: lower("$5.06M", "3,276 exits finished the wait and were never claimed", "#ef6b63") },
  {
    name: "zero",
    transparent: true,
    html: lower("0", "WithdrawRedirected events ever emitted by the Arbitrum One and Nova mainnet gateways", "#e0a345"),
  },
  { name: "live-tag", transparent: true, html: `<div class="tag">● LIVE · Xai Testnet → Arbitrum Sepolia · real transactions</div>` },
  {
    name: "skip",
    html: `<div class="full"><p class="eyebrow" style="color:#e0a345">~15 minutes later</p>
      <p class="title">The next rollup node is posted.</p>
      <p class="body">The withdrawal is now committed to a pending send root: provable on-chain, 6.4 days before it could be claimed.</p></div>`,
  },
  {
    name: "bold",
    html: `<div class="full"><p class="eyebrow" style="color:#4c93f5">Arbitrum One · BOLD</p>
      <p class="title">A real pending mainnet withdrawal, proven and listed.</p>
      <p class="body">On an Ethereum mainnet fork, Exit Market registers the real BOLD assertion chain and lists a real pending
      Arbitrum One withdrawal through the real L1 gateway. Every pending ancestor must be unchallenged.</p>
      <div class="stats"><div class="stat"><b>137</b><span>pending assertions walked</span></div>
      <div class="stat"><b>1.37M</b><span>gas for the whole walk</span></div>
      <div class="stat"><b>504.7</b><span>LINK in the withdrawal</span></div></div></div>
      <p class="src">contracts/test/fork/ArbOneBoldFork.t.sol</p>`,
  },
  {
    name: "stylus",
    html: `<div class="full"><p class="eyebrow" style="color:#3fd0c9">Stylus · Rust → WASM</p>
      <p class="title">The proof verifier also runs in Rust.</p>
      <p class="body">The Outbox leaf and Merkle checks, compiled to WASM and activated on Arbitrum Sepolia. Checked on-chain against a
      real Xai Testnet send root, with an honest gas benchmark against the Solidity twin.</p></div>
      <p class="src">0x30ac015003186f187b9a11fff2781d55cc9e1394 · docs/audit/STYLUS_BENCH.json</p>`,
  },
  {
    name: "quality",
    html: `<div class="full"><p class="eyebrow" style="color:#3fbf88">Built to be trusted</p>
      <p class="title">Four review rounds. Every high fixed, with a regression test.</p>
      <div class="stats"><div class="stat"><b>400+</b><span>Solidity tests, incl. fuzz &amp; invariants</span></div>
      <div class="stat"><b>0</b><span>Slither high / medium</span></div>
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
    const bg = card.transparent ? "background: transparent;" : "background: #07090d;";
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
