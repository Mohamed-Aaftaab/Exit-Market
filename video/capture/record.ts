/**
 * Records real footage of the live app (Arbitrum Sepolia + Xai Testnet) for the demo video. Every transaction
 * in these clips is real; only the wallet popup is replaced by a Node-side test wallet.
 *
 *   node video/capture/record.ts <scene>      scenes: explorer | withdraw | sell | gasless-start | gasless-settled
 * Env: APP_URL (default http://localhost:3100, a production build), DEPLOYER_PRIVATE_KEY / SELLER_PRIVATE_KEY.
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
    await page.goto(APP_URL);
    await pause(1500);
    await connect(page);
    await click(page, page.getByText("Standard", { exact: true }));
    await typeInto(page, page.locator("#withdraw-amount"), "10");
    await click(page, page.getByRole("button", { name: "Withdraw", exact: true }));
    await page.getByText(/Withdrawal started/).waitFor({ timeout: 3 * MINUTE });
    await pause(3500);
  },
  async sell(page) {
    await page.goto(APP_URL);
    await pause(1500);
    await connect(page);
    const row = page.getByRole("button", { name: /Sellable now/ }).first();
    await row.waitFor({ timeout: 2 * MINUTE });
    await click(page, row);
    const sellButton = page.getByRole("button", { name: /^Get .* USDG now$/ });
    await sellButton.waitFor({ timeout: 2 * MINUTE });
    await pause(4000); // let the proof trace be read
    await click(page, sellButton);
    await sellButton.waitFor({ state: "detached", timeout: 3 * MINUTE });
    await pause(4000);
  },
  async "gasless-start"(page) {
    await page.goto(APP_URL);
    await pause(1500);
    await connect(page);
    // Fast exit is the default mode; the seller holds USDG on Xai but no ETH on Arbitrum Sepolia.
    await typeInto(page, page.locator("#withdraw-amount"), "5");
    await click(page, page.getByRole("button", { name: "Fast exit", exact: true }));
    await page.getByText(/^Signed\./).waitFor({ timeout: 3 * MINUTE });
    await pause(4000);
  },
  async "gasless-settled"(page) {
    await page.goto(APP_URL);
    await connect(page);
    await page.getByRole("link", { name: /settled/ }).first().waitFor({ timeout: 5 * MINUTE });
    await pause(4000);
  },
};

const WALLET_FOR: Record<string, string | undefined> = {
  explorer: undefined,
  withdraw: "DEPLOYER_PRIVATE_KEY",
  sell: "DEPLOYER_PRIVATE_KEY",
  "gasless-start": "SELLER_PRIVATE_KEY",
  "gasless-settled": "SELLER_PRIVATE_KEY",
};

async function main() {
  const name = process.argv[2];
  const scene = name ? scenes[name] : undefined;
  if (!name || !scene) throw new Error(`Usage: record.ts <${Object.keys(scenes).join(" | ")}>`);
  mkdirSync(OUT, { recursive: true });
  const keyVar = WALLET_FOR[name];
  const { context, page } = await open(keyVar === "SELLER_PRIVATE_KEY" ? "seller" : "deployer", keyVar);
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
