/**
 * Page-side pieces of the recording harness: a window.ethereum bridge to the Node test wallet, a visible
 * cursor (headless capture has none), and human-paced interactions.
 */
import type { Locator, Page } from "playwright-core";
import type { TestWallet } from "./wallet.ts";

/** Runs in the page before the app: forwards EIP-1193 calls to Node and draws the cursor. */
const INIT_SCRIPT = `(() => {
  const listeners = {};
  const ethereum = {
    isMetaMask: false,
    request: ({ method, params }) => window.__walletRequest(method, params || []),
    on(event, cb) { (listeners[event] ||= []).push(cb); return ethereum; },
    removeListener(event, cb) { listeners[event] = (listeners[event] || []).filter((x) => x !== cb); return ethereum; },
  };
  window.__walletEmit = (event, value) => (listeners[event] || []).forEach((cb) => cb(value));
  window.ethereum = ethereum;
  const draw = () => {
    if (document.getElementById("__cursor")) return;
    const c = document.createElement("div");
    c.id = "__cursor";
    c.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24"><path d="M4 2l16 9-7 2-3 7z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: 2147483647, pointerEvents: "none",
      transform: "translate(960px, 700px)", transition: "transform 700ms cubic-bezier(.2,.8,.2,1)",
      filter: "drop-shadow(0 2px 3px rgba(0,0,0,.5))" });
    document.body.appendChild(c);
  };
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", draw) : draw();
})();`;

export async function installWallet(page: Page, wallet: TestWallet): Promise<void> {
  await page.exposeFunction("__walletRequest", (method: string, params: unknown[]) => wallet.request(method, params));
  await page.addInitScript(INIT_SCRIPT);
}

/** Lets the Node wallet push chainChanged/accountsChanged into the page. */
export function emitter(pageRef: { page?: Page }) {
  return async (event: string, value: unknown) => {
    await pageRef.page?.evaluate(([e, v]) => (window as unknown as { __walletEmit: (e: string, v: unknown) => void }).__walletEmit(e, v), [event, value] as const);
  };
}

export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function moveCursorTo(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) return;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.evaluate(([cx, cy]) => {
    const c = document.getElementById("__cursor");
    if (c) c.style.transform = `translate(${cx}px, ${cy}px)`;
  }, [x, y] as const);
  await pause(800);
}

/** Glide the cursor to the element, then click it. */
export async function click(page: Page, target: Locator): Promise<void> {
  await moveCursorTo(page, target);
  await target.click();
  await pause(400);
}

/** Type like a person. */
export async function typeInto(page: Page, target: Locator, text: string): Promise<void> {
  await moveCursorTo(page, target);
  await target.click();
  await target.pressSequentially(text, { delay: 140 });
  await pause(500);
}

/** Smooth-scroll the window by `dy` pixels over `ms`. */
export async function scrollBy(page: Page, dy: number, ms: number): Promise<void> {
  await page.evaluate(([delta, duration]) => new Promise<void>((done) => {
    const start = window.scrollY;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
      window.scrollTo(0, start + delta * eased);
      if (p < 1) requestAnimationFrame(step);
      else done();
    };
    requestAnimationFrame(step);
  }), [dy, ms] as const);
}
