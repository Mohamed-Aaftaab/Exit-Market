/**
 * Records real footage of the live app (Arbitrum Sepolia + Xai Testnet) for the demo video. Every transaction
 * in these clips is real; only the wallet popup is replaced by a Node-side test wallet.
 *
 *   node video/capture/record.ts <scene>      scenes: explorer | withdraw | sell | gasless-start | gasless-settled | list | buy-listing
 * Env: APP_URL (default http://localhost:3100, a production build), DEPLOYER_PRIVATE_KEY / SELLER_PRIVATE_KEY /
 * BUYER_PRIVATE_KEY, LIST_PRICE (default 1.99).
 */
import "dotenv/config";
import { mkdirSync } from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import type { Hex } from "viem";
import { click, emitter, installWallet, pause, scrollBy, typeInto } from "./page.ts";
import { startRecording } from "./recorder.ts";
import { createTestWallet } from "./wallet.ts";

const APP_URL = process.env.APP_URL ?? "http://localhost:3100";
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = "video/out/capture";
const MINUTE = 60_000;
const DESK_SCROLL = 240; // past the page title, so the desk's panels fill the frame

async function open(profile: string, keyVar: string | undefined): Promise<{ context: BrowserContext; page: Page }> {
  const context = await chromium.launchPersistentContext(`${OUT}/profiles/${profile}`, {
    executablePath: CHROME,
    headless: true,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1.5, // 1920x1080 device pixels; the app fills the frame and reads well on video
    colorScheme: "dark",
  });
  const page = context.pages()[0] ?? (await context.newPage());
  if (keyVar) {
    const key = process.env[keyVar];
    if (!key) throw new Error(`Missing ${keyVar} in .env`);
    const ref: { page?: Page } = { page };
    const wallet = createTestWallet(key as Hex, emitter(ref));
    const debug = Boolean(process.env.DEBUG_WALLET);
    await installWallet(page, {
      ...wallet,
      async request(method, params) {
        try {
          const result = await wallet.request(method, params);
          if (debug) console.log(`wallet ${method} ->`, JSON.stringify(result)?.slice(0, 80));
          return result;
        } catch (err) {
          console.log(`wallet ${method} FAILED:`, err instanceof Error ? err.message.split("\n")[0] : err);
          throw err;
        }
      },
    });
    if (debug) page.on("console", (m) => m.type() === "error" && console.log("page error:", m.text().slice(0, 200)));
    console.log(`test wallet ${wallet.address}`);
  }
  return { context, page };
}

async function connect(page: Page): Promise<void> {
  const connected = page.getByRole("button", { name: /^Disconnect wallet/ });
  await pause(2500); // let wagmi auto-reconnect a remembered wallet first
  if (!(await connected.isVisible().catch(() => false))) {
    // exact: the connected button's name ("Disconnect wallet 0x…") also contains "connect wallet"
    await click(page, page.getByRole("button", { name: "Connect wallet", exact: true }));
  }
  await connected.waitFor({ timeout: 30_000 });
}

const scenes: Record<string, (page: Page) => Promise<void>> = {
  async explorer(page) {
    await page.goto(`${APP_URL}/explorer`);
    await page.getByText(/Updated \d/).waitFor({ timeout: 2 * MINUTE });
    await pause(2500);
    await scrollBy(page, 820, 5000);
    await pause(2500);
    await scrollBy(page, 900, 4500);
    await pause(2500);
  },
  async withdraw(page) {
    await page.goto(`${APP_URL}/app`);
    await pause(1500);
    await connect(page);
    await scrollBy(page, DESK_SCROLL, 1200);
    await click(page, page.getByText("Standard", { exact: true }));
    await typeInto(page, page.locator("#withdraw-amount"), "10");
    await click(page, page.getByRole("button", { name: "Withdraw", exact: true }));
    await page.getByText(/Withdrawal started/).waitFor({ timeout: 3 * MINUTE });
    await pause(3500);
  },
  async sell(page) {
    await page.goto(`${APP_URL}/app`);
    await pause(1500);
    await connect(page);
    await scrollBy(page, DESK_SCROLL, 1200);
    const row = page.getByRole("button", { name: /Sellable now/ }).first();
    await row.waitFor({ timeout: 2 * MINUTE });
    await click(page, row);
    const sellButton = page.getByRole("button", { name: /^Get .* USDG now$/ });
    await sellButton.waitFor({ timeout: 2 * MINUTE });
    await pause(4000); // let the proof trace be read
    await click(page, sellButton);
    // The button only changes its label while the wallet signs; the sale is done when the receipt line appears.
    await page.getByRole("status").filter({ hasText: /^Sold\./ }).waitFor({ timeout: 3 * MINUTE });
    await pause(1200);
    await scrollBy(page, -(await page.evaluate(() => window.scrollY)), 1400); // back up to the receipt and the list
    await pause(4000);
  },
  async "gasless-start"(page) {
    await page.goto(`${APP_URL}/app`);
    await pause(1500);
    await connect(page);
    await scrollBy(page, DESK_SCROLL, 1200);
    // Fast exit is the default mode; the seller holds USDG on Xai but no ETH on Arbitrum Sepolia.
    await typeInto(page, page.locator("#withdraw-amount"), "5");
    await click(page, page.getByRole("button", { name: "Fast exit", exact: true }));
    await page.getByText(/^Signed\./).waitFor({ timeout: 3 * MINUTE });
    await pause(4000);
  },
  async "gasless-settled"(page) {
    await page.goto(`${APP_URL}/app`);
    await connect(page);
    await scrollBy(page, DESK_SCROLL, 1200);
    await page.getByRole("link", { name: /settled/ }).first().waitFor({ timeout: 5 * MINUTE });
    await pause(4000);
  },
  async list(page) {
    await page.goto(`${APP_URL}/app`);
    await pause(1500);
    await connect(page);
    await scrollBy(page, DESK_SCROLL, 1200);
    const row = page.getByRole("button", { name: /Sellable now/ }).first();
    await row.waitFor({ timeout: 2 * MINUTE });
    await click(page, row);
    const listMode = page.getByRole("button", { name: "List at your price", exact: true });
    await listMode.waitFor({ timeout: 2 * MINUTE });
    await click(page, listMode);
    const price = page.getByLabel("Your price (USDG)");
    await price.fill("");
    await typeInto(page, price, process.env.LIST_PRICE ?? "1.99");
    await click(page, page.getByRole("button", { name: "1 day", exact: true }));
    await pause(2500); // let the payout line be read
    await click(page, page.getByRole("button", { name: /^List for / }));
    await page.getByRole("status").filter({ hasText: /^Listed at/ }).waitFor({ timeout: 3 * MINUTE });
    await pause(1500);
    const listings = page.getByRole("list", { name: "Open listings" });
    await listings.waitFor({ timeout: 2 * MINUTE });
    await listings.scrollIntoViewIfNeeded();
    await pause(4000);
  },
  async "buy-listing"(page) {
    await page.goto(`${APP_URL}/app`);
    await pause(1500);
    await connect(page);
    const buy = page.getByRole("button", { name: /^Buy for .* USDG$/ }).first();
    await buy.waitFor({ timeout: 2 * MINUTE });
    await buy.scrollIntoViewIfNeeded();
    await pause(3000); // let the listing's return and payout time be read
    await click(page, buy);
    await page.getByRole("status").filter({ hasText: /^Bought\./ }).waitFor({ timeout: 3 * MINUTE });
    await pause(4000);
  },
};

const WALLET_FOR: Record<string, string | undefined> = {
  explorer: undefined,
  withdraw: "DEPLOYER_PRIVATE_KEY",
  sell: "DEPLOYER_PRIVATE_KEY",
  "gasless-start": "SELLER_PRIVATE_KEY",
  "gasless-settled": "SELLER_PRIVATE_KEY",
  list: "DEPLOYER_PRIVATE_KEY",
  "buy-listing": "BUYER_PRIVATE_KEY",
};

async function main() {
  const name = process.argv[2];
  const scene = name ? scenes[name] : undefined;
  if (!name || !scene) throw new Error(`Usage: record.ts <${Object.keys(scenes).join(" | ")}>`);
  mkdirSync(OUT, { recursive: true });
  const keyVar = WALLET_FOR[name];
  const { context, page } = await open(keyVar ? keyVar.replace("_PRIVATE_KEY", "").toLowerCase() : "anon", keyVar);
  const recording = await startRecording(page, `${OUT}/${name}.mp4`);
  try {
    await scene(page);
  } finally {
    const file = await recording.stop();
    await context.close();
    console.log(`saved ${file}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
