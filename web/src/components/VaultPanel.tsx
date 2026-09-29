"use client";

import { useState } from "react";
import type { Address } from "viem";
import { useAccount, usePublicClient, useReadContracts, useSwitchChain, useWriteContract } from "wagmi";
import { arbitrumSepolia } from "wagmi/chains";
import { ARBITRUM_SEPOLIA, DEPLOYMENT, erc20Abi, vaultAbi } from "@/lib/contracts";
import { bps, errorText, parseUsdgInput, usdg } from "@/lib/format";

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
  const holder = user ?? vault;
  const reads = useReadContracts({
    allowFailure: false,
    contracts: [
      { chainId, address: vault, abi: vaultAbi, functionName: "totalAssets" },
      { chainId, address: vault, abi: vaultAbi, functionName: "idleAssets" },
      { chainId, address: vault, abi: vaultAbi, functionName: "outstandingCost" },
      { chainId, address: vault, abi: vaultAbi, functionName: "aprBps" },
      { chainId, address: vault, abi: vaultAbi, functionName: "baseFeeBps" },
      { chainId, address: vault, abi: vaultAbi, functionName: "maxWithdraw", args: [holder] },
      { chainId, address: vault, abi: vaultAbi, functionName: "SHARE_LOCK" },
      { chainId, address: ARBITRUM_SEPOLIA.usdg, abi: erc20Abi, functionName: "balanceOf", args: [holder] },
    ],
    query: { refetchInterval: 30_000 },
  });
  const [totalAssets, idle, outstanding, aprBps, baseFeeBps, withdrawable, shareLock, walletUsdg] = reads.data ?? [];
  return {
    error: reads.error,
    refetch: reads.refetch,
    totalAssets,
    idle,
    outstanding,
    aprBps,
    baseFeeBps,
    shareLockHours: shareLock === undefined ? undefined : Number(shareLock) / 3600,
    withdrawable: user ? withdrawable : undefined,
    walletUsdg: user ? walletUsdg : undefined,
  };
}

function DepositForm({ vault, lockHours, onDone }: { vault: Address; lockHours?: number; onDone: () => void }) {
  const { address, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const parent = usePublicClient({ chainId: arbitrumSepolia.id });
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<string>();
  const [isBusy, setIsBusy] = useState(false);

  async function deposit() {
    if (!address || !parent || isBusy) return;
    const assets = parseUsdgInput(amount);
    if (assets === undefined) return setStatus("Enter a USDG amount with at most 6 decimals");

    setIsBusy(true);
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
      await parent.waitForTransactionReceipt({ hash: approve, timeout: 120_000 });
      setStatus("Depositing…");
      const hash = await writeContractAsync({
        chainId: arbitrumSepolia.id,
        address: vault,
        abi: vaultAbi,
        functionName: "deposit",
        args: [assets, address],
      });
      await parent.waitForTransactionReceipt({ hash, timeout: 120_000 });
      setStatus(lockHours ? `Deposited. Shares unlock in ${lockHours}h.` : "Deposited.");
      setAmount("");
      onDone();
    } catch (err) {
      setStatus(errorText(err));
    } finally {
      setIsBusy(false);
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
          disabled={isBusy}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm text-ink"
        />
        <button
          type="button"
          onClick={deposit}
          disabled={!address || isBusy}
          aria-busy={isBusy}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
        >
          {isBusy ? "Depositing…" : "Deposit"}
        </button>
      </div>
      {status && (
        <p role="status" className="text-xs text-muted">
          {status}
        </p>
      )}
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
      {stats.error && (
        <p role="alert" className="text-sm text-bad">
          Could not read the vault: {errorText(stats.error)}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Stat label="Total assets" value={usdg(stats.totalAssets)} />
        <Stat label="Available now" value={usdg(stats.idle)} />
        <Stat label="In pending exits" value={usdg(stats.outstanding)} />
        <Stat label="Pricing" value={stats.aprBps === undefined ? "—" : `${bps(stats.aprBps)} APR`} />
        <Stat label="Base fee" value={stats.baseFeeBps === undefined ? "—" : bps(stats.baseFeeBps)} />
        <Stat label="Your withdrawable" value={usdg(stats.withdrawable)} />
      </dl>
      <DepositForm vault={vault} lockHours={stats.shareLockHours} onDone={() => stats.refetch()} />
      <p className="text-xs text-muted">Wallet: {usdg(stats.walletUsdg)} USDG on Arbitrum Sepolia</p>
    </div>
  );
}
