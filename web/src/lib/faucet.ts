import { getAddress, parseEther, type Address } from "viem";

/** 1.5 USDG: above the vault's 1 USDG minimum, so one drip is enough to try a sale or a listing. */
export const FAUCET_USDG = 1_500_000n;
/** sXAI for Xai Testnet gas: a withdrawal costs ~0.00002, so this covers hundreds. */
export const FAUCET_GAS = parseEther("0.01");
/** Per IP: a few drips an hour (per server instance; the per-address rule below is the durable one). */
export const FAUCET_WINDOW_MS = 60 * 60_000;
export const FAUCET_MAX_PER_WINDOW = 3;

export type FaucetRequest = { ok: true; address: Address } | { ok: false; error: string };

export function parseFaucetRequest(body: unknown): FaucetRequest {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid body" };
  const raw = (body as Record<string, unknown>).address;
  if (typeof raw !== "string") return { ok: false, error: "Missing address" };
  try {
    return { ok: true, address: getAddress(raw) };
  } catch {
    return { ok: false, error: "Invalid address" };
  }
}

export interface DripInputs {
  /** The faucet already sent USDG to this address (its own transfer logs on Xai are the record). */
  alreadyFunded: boolean;
  recipientGas: bigint;
  faucetUsdg: bigint;
  faucetGas: bigint;
}

export type DripPlan = { ok: true; usdg: bigint; gas: bigint } | { ok: false; status: 409 | 503; error: string };

/** What to send so the recipient can make one withdrawal: USDG once per address, gas only when short. */
export function planDrip({ alreadyFunded, recipientGas, faucetUsdg, faucetGas }: DripInputs): DripPlan {
  if (alreadyFunded) return { ok: false, status: 409, error: "This address already received test funds" };
  const gas = recipientGas >= FAUCET_GAS ? 0n : FAUCET_GAS - recipientGas;
  // The faucet also pays its own transfer gas, so keep a margin of one drip.
  if (faucetUsdg < FAUCET_USDG || faucetGas < gas + FAUCET_GAS) {
    return { ok: false, status: 503, error: "The test faucet is empty right now" };
  }
  return { ok: true, usdg: FAUCET_USDG, gas };
}
