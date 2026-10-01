"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { erc20Abi, formatEther, type Address, type Hash } from "viem";
import { usePublicClient } from "wagmi";
import { ARBITRUM_SEPOLIA, XAI_TESTNET } from "@/lib/contracts";
import { FAUCET_GAS, FAUCET_USDG } from "@/lib/faucet";
import { errorText, usdg } from "@/lib/format";
import { xaiTestnet } from "@/lib/wagmi";

/** Smallest exit the vault buys (ExitVault.minExitAmount defaults to one whole USDG). */
const MIN_SELLABLE = 1_000_000n;

type FaucetResult = { usdgTx: Hash; gasTx?: Hash };

async function requestFunds(address: Address): Promise<FaucetResult> {
  const res = await fetch("/api/faucet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  const json = (await res.json()) as { error?: string } & Partial<FaucetResult>;
  if (!res.ok || !json.usdgTx) throw new Error(json.error ?? `Faucet error (${res.status})`);
  return { usdgTx: json.usdgTx, gasTx: json.gasTx };
}

function XaiTx({ hash, children }: { hash: Hash; children: string }) {
  return (
    <a className="text-ok underline-offset-2 hover:underline" href={`${XAI_TESTNET.explorerUrl}/tx/${hash}`} target="_blank" rel="noopener noreferrer">
      {children} ↗
    </a>
  );
}

/** The wallet's balances on Xai Testnet, and one click of test funds when they are too low to try an exit. */
export function TestFunds({ address }: { address: Address }) {
  const child = usePublicClient({ chainId: xaiTestnet.id });
  const queryClient = useQueryClient();
  const balances = useQuery({
    queryKey: ["xai-balances", address],
    enabled: Boolean(child),
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!child) throw new Error("Xai Testnet client unavailable");
      const [usdgBalance, gas] = await Promise.all([
        child.readContract({ address: ARBITRUM_SEPOLIA.usdgOnXai, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
        child.getBalance({ address }),
      ]);
      return { usdg: usdgBalance, gas };
    },
  });
  const faucet = useMutation({ mutationFn: () => requestFunds(address), onSuccess: () => queryClient.invalidateQueries() });

  if (!balances.data) return null;
  const needsFunds = balances.data.usdg < MIN_SELLABLE || balances.data.gas === 0n;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs" role="group" aria-label="Your balances on Xai Testnet">
      <span className="font-mono text-muted">
        On Xai: {usdg(balances.data.usdg)} USDG · {Number(formatEther(balances.data.gas)).toFixed(4)} sXAI gas
      </span>
      {faucet.isSuccess ? (
        <span className="flex gap-3">
          <XaiTx hash={faucet.data.usdgTx}>USDG sent</XaiTx>
          {faucet.data.gasTx && <XaiTx hash={faucet.data.gasTx}>gas sent</XaiTx>}
        </span>
      ) : (
        needsFunds && (
          <button type="button" className="text-ink underline underline-offset-2 disabled:opacity-50" onClick={() => faucet.mutate()} disabled={faucet.isPending}>
            {faucet.isPending ? "Sending test funds…" : `Get test funds (${usdg(FAUCET_USDG, 1)} USDG + ${formatEther(FAUCET_GAS)} sXAI)`}
          </button>
        )
      )}
      {faucet.isError && (
        <p role="alert" className="w-full text-bad">
          {errorText(faucet.error)}
        </p>
      )}
    </div>
  );
}
