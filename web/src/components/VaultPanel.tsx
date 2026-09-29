"use client";

import { useState } from "react";
import { parseUnits, type Address } from "viem";
import { useAccount, usePublicClient, useReadContracts, useSwitchChain, useWriteContract } from "wagmi";
import { arbitrumSepolia } from "wagmi/chains";
import { ARBITRUM_SEPOLIA, DEPLOYMENT, USDG_DECIMALS, erc20Abi, vaultAbi } from "@/lib/contracts";
import { bps, usdg } from "@/lib/format";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-mono text-base text-ink">{value}</dd>
    </div>
  );
}

function useVaultStats(vault: Address, user: Address | undefined) {
  const chainId = arbitrumSepolia.id;
  const reads = useReadContracts({
    contracts: [
      { chainId, address: vault, abi: vaultAbi, functionName: "totalAssets" },
      { chainId, address: vault, abi: vaultAbi, functionName: "idleAssets" },
      { chainId, address: vault, abi: vaultAbi, functionName: "outstandingCost" },
      { chainId, address: vault, abi: vaultAbi, functionName: "aprBps" },
      { chainId, address: vault, abi: vaultAbi, functionName: "baseFeeBps" },
      { chainId, address: vault, abi: vaultAbi, functionName: "maxWithdraw", args: [user ?? vault] },
      { chainId, address: ARBITRUM_SEPOLIA.usdg, abi: erc20Abi, functionName: "balanceOf", args: [user ?? vault] },
    ],
    query: { refetchInterval: 15_000 },
  });
  const r = reads.data?.map((x) => x.result);
  return {
    refetch: reads.refetch,
    totalAssets: r?.[0] as bigint | undefined,
    idle: r?.[1] as bigint | undefined,
    outstanding: r?.[2] as bigint | undefined,
    aprBps: r?.[3] as number | undefined,
    baseFeeBps: r?.[4] as number | undefined,
    withdrawable: user ? (r?.[5] as bigint | undefined) : undefined,
    walletUsdg: user ? (r?.[6] as bigint | undefined) : undefined,
  };
}

function DepositForm({ vault, onDone }: { vault: Address; onDone: () => void }) {
  const { address, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const parent = usePublicClient({ chainId: arbitrumSepolia.id });
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<string>();

  async function deposit() {
    if (!address || !parent) return;
    const assets = parseUnits(amount || "0", USDG_DECIMALS);
    if (assets <= 0n) return setStatus("Enter an amount");
    try {
      if (chainId !== arbitrumSepolia.id) await switchChainAsync({ chainId: arbitrumSepolia.id });
      setStatus("Approving USDG…");
      const approve = await writeContractAsync({
        chainId: arbitrumSepolia.id,
        address: ARBITRUM_SEPOLIA.usdg,
        abi: erc20Abi,
        functionName: "approve",
        args: [vault, assets],
      });
      await parent.waitForTransactionReceipt({ hash: approve });
      setStatus("Depositing…");
      const hash = await writeContractAsync({
        chainId: arbitrumSepolia.id,
        address: vault,
        abi: vaultAbi,
        functionName: "deposit",
        args: [assets, address],
      });
      await parent.waitForTransactionReceipt({ hash });
      setStatus("Deposited. Shares unlock in 24h.");
      setAmount("");
      onDone();
    } catch (err) {
      setStatus(err instanceof Error ? err.message.split("\n")[0] : "Deposit failed");
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <label className="sr-only" htmlFor="deposit-amount">
          USDG to deposit
        </label>
        <input
          id="deposit-amount"
          inputMode="decimal"
          placeholder="USDG"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm text-ink"
        />
        <button
          type="button"
          onClick={deposit}
          disabled={!address}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
        >
          Deposit
        </button>
      </div>
      {status && <p className="text-xs text-muted">{status}</p>}
    </div>
  );
}

export function VaultPanel() {
  const { address } = useAccount();
  const vault = DEPLOYMENT.vault;
  const stats = useVaultStats(vault ?? ARBITRUM_SEPOLIA.usdg, address);

  if (!vault) return <p className="p-5 text-sm text-muted">Vault not deployed yet.</p>;

  return (
    <div className="space-y-5 p-5">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Stat label="Total assets" value={usdg(stats.totalAssets)} />
        <Stat label="Available now" value={usdg(stats.idle)} />
        <Stat label="In pending exits" value={usdg(stats.outstanding)} />
        <Stat label="Pricing" value={stats.aprBps === undefined ? "—" : `${bps(stats.aprBps)} APR`} />
        <Stat label="Base fee" value={stats.baseFeeBps === undefined ? "—" : bps(stats.baseFeeBps)} />
        <Stat label="Your withdrawable" value={usdg(stats.withdrawable)} />
      </dl>
      <DepositForm vault={vault} onDone={() => stats.refetch()} />
      <p className="text-xs text-muted">Wallet: {usdg(stats.walletUsdg)} USDG on Arbitrum Sepolia</p>
    </div>
  );
}
