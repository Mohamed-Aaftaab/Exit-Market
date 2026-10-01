"use client";

import { useState } from "react";
import { zeroAddress, type Address } from "viem";
import { useAccount, useBlock, useReadContracts, useWriteContract } from "wagmi";
import { arbitrumSepolia } from "wagmi/chains";
import { useParentTx } from "@/hooks/useParentTx";
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

function useVaultStats(vault: Address | undefined, user: Address | undefined) {
  const chainId = arbitrumSepolia.id;
  const target = vault ?? zeroAddress; // never read: the query is disabled without a vault
  const holder = user ?? zeroAddress;
  const reads = useReadContracts({
    allowFailure: false,
    contracts: [
      { chainId, address: target, abi: vaultAbi, functionName: "totalAssets" },
      { chainId, address: target, abi: vaultAbi, functionName: "idleAssets" },
      { chainId, address: target, abi: vaultAbi, functionName: "outstandingCost" },
      { chainId, address: target, abi: vaultAbi, functionName: "aprBps" },
      { chainId, address: target, abi: vaultAbi, functionName: "baseFeeBps" },
      { chainId, address: target, abi: vaultAbi, functionName: "maxWithdraw", args: [holder] },
      { chainId, address: target, abi: vaultAbi, functionName: "SHARE_LOCK" },
      { chainId, address: target, abi: vaultAbi, functionName: "shareUnlockTime", args: [holder] },
      { chainId, address: ARBITRUM_SEPOLIA.usdg, abi: erc20Abi, functionName: "balanceOf", args: [holder] },
      // 0 while deposits are paused (an exit from a rejected node is being written off or collected).
      { chainId, address: target, abi: vaultAbi, functionName: "maxDeposit", args: [holder] },
      { chainId, address: target, abi: vaultAbi, functionName: "balanceOf", args: [holder] },
    ],
    query: { enabled: Boolean(vault), refetchInterval: 30_000 },
  });
  // Share locks end at a chain timestamp, so compare with the chain's clock rather than the browser's.
  const block = useBlock({ chainId, query: { refetchInterval: 30_000 } });
  const [totalAssets, idle, outstanding, aprBps, baseFeeBps, withdrawable, shareLock, unlockTime, walletUsdg, maxDeposit, shares] =
    reads.data ?? [];
  // NAV carries each open exit's discount as it accrues toward its deadline (and values rejected exits at 0).
  const accrued =
    totalAssets !== undefined && idle !== undefined && outstanding !== undefined ? totalAssets - idle - outstanding : undefined;
  return {
    error: reads.error,
    refetch: reads.refetch,
    totalAssets,
    idle,
    outstanding,
    accrued,
    aprBps,
    baseFeeBps,
    shareLockHours: shareLock === undefined ? undefined : Number(shareLock) / 3600,
    withdrawable: user ? withdrawable : undefined,
    unlockTime: user && unlockTime ? Number(unlockTime) : undefined,
    isLocked: user && unlockTime !== undefined && block.data ? unlockTime > block.data.timestamp : undefined,
    hasShares: user && shares !== undefined ? shares > 0n : undefined,
    depositsPaused: maxDeposit === 0n,
    walletUsdg: user ? walletUsdg : undefined,
  };
}

function AmountForm({
  label,
  action,
  busyLabel,
  disabled,
  onSubmit,
}: {
  label: string;
  action: string;
  busyLabel: string;
  disabled: boolean;
  onSubmit: (assets: bigint, setStatus: (s: string) => void) => Promise<string>;
}) {
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<string>();
  const [isBusy, setIsBusy] = useState(false);
  const id = `vault-${action.toLowerCase()}-amount`;

  async function submit() {
    if (isBusy) return;
    const assets = parseUsdgInput(amount);
    if (assets === undefined) return setStatus("Enter a USDG amount with at most 6 decimals");
    setIsBusy(true);
    try {
      setStatus(await onSubmit(assets, setStatus));
      setAmount("");
    } catch (err) {
      setStatus(errorText(err));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <label className="sr-only" htmlFor={id}>
          {label}
        </label>
        <input
          id={id}
          inputMode="decimal"
          placeholder={label}
          value={amount}
          disabled={isBusy || disabled}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          className="min-w-0 flex-1 rounded-full border border-line bg-surface-2 px-4 py-2.5 font-mono text-sm text-ink placeholder:text-muted focus:border-white/40 focus:outline-none"
        />
        <button type="button" onClick={submit} disabled={isBusy || disabled} aria-busy={isBusy} className="btn-primary">
          {isBusy ? busyLabel : action}
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

const DEPOSITS_PAUSED =
  "Deposits are paused: the vault holds an exit from a rejected rollup node, so its share price may be understated until that exit pays out or its impairment window ends.";

export function VaultPanel() {
  const { address } = useAccount();
  const vault = DEPLOYMENT.vault;
  const stats = useVaultStats(vault, address);
  const sendTx = useParentTx();
  const { writeContractAsync } = useWriteContract();

  if (!vault) return <p className="p-5 text-sm text-muted">Vault not deployed yet.</p>;

  // The vault reports 0 withdrawable while shares are locked and while it has no idle USDG; say which.
  // Nothing until the chain's clock is known, so a locked wallet never briefly reads as waiting for liquidity.
  const lockNote =
    stats.withdrawable !== 0n || !stats.hasShares || stats.isLocked === undefined
      ? undefined
      : stats.isLocked && stats.unlockTime !== undefined
        ? `Your shares unlock ${new Date(stats.unlockTime * 1000).toLocaleString()}.`
        : "Withdrawals wait for idle USDG, which returns as the vault's exits are collected.";
  const lockDays = stats.shareLockHours === undefined ? undefined : stats.shareLockHours / 24;

  async function deposit(assets: bigint, setStatus: (s: string) => void) {
    // Checked before the approval: a paused vault would take the approval and then revert the deposit.
    if (stats.depositsPaused) throw new Error(DEPOSITS_PAUSED);
    if (stats.walletUsdg !== undefined && assets > stats.walletUsdg) {
      throw new Error(`Your wallet holds ${usdg(stats.walletUsdg)} USDG on Arbitrum Sepolia`);
    }
    setStatus("Approving USDG…");
    await sendTx(() =>
      writeContractAsync({ chainId: arbitrumSepolia.id, address: ARBITRUM_SEPOLIA.usdg, abi: erc20Abi, functionName: "approve", args: [vault!, assets] }),
    );
    setStatus("Depositing…");
    await sendTx(() =>
      writeContractAsync({ chainId: arbitrumSepolia.id, address: vault!, abi: vaultAbi, functionName: "deposit", args: [assets, address!] }),
    );
    void stats.refetch();
    return stats.shareLockHours ? `Deposited. Shares unlock in ${stats.shareLockHours}h.` : "Deposited.";
  }

  async function withdraw(assets: bigint, setStatus: (s: string) => void) {
    if (stats.withdrawable !== undefined && assets > stats.withdrawable) {
      throw new Error(`At most ${usdg(stats.withdrawable)} USDG is withdrawable now (idle liquidity and share lock)`);
    }
    setStatus("Withdrawing…");
    await sendTx(() =>
      writeContractAsync({
        chainId: arbitrumSepolia.id,
        address: vault!,
        abi: vaultAbi,
        functionName: "withdraw",
        args: [assets, address!, address!],
      }),
    );
    void stats.refetch();
    return "Withdrawn to your wallet on Arbitrum Sepolia.";
  }

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
        <Stat label="In pending exits (cost)" value={usdg(stats.outstanding)} />
        <Stat label="Accrued yield" value={stats.accrued === undefined ? "—" : `${stats.accrued < 0n ? "−" : "+"}${usdg(stats.accrued < 0n ? -stats.accrued : stats.accrued)}`} />
        <Stat
          label="Pricing"
          value={stats.aprBps === undefined || stats.baseFeeBps === undefined ? "—" : `${bps(stats.baseFeeBps)} + ${bps(stats.aprBps)} APR`}
        />
        <Stat label="Your withdrawable" value={usdg(stats.withdrawable)} />
      </dl>
      <AmountForm
        label="USDG to deposit"
        action="Deposit"
        busyLabel="Depositing…"
        disabled={!address || stats.depositsPaused}
        onSubmit={deposit}
      />
      <p className="text-xs text-muted">
        {stats.depositsPaused
          ? DEPOSITS_PAUSED
          : lockDays !== undefined && `Each deposit locks all of this wallet's vault shares for ${lockDays} days; the lock restarts with every deposit.`}
      </p>
      <AmountForm
        label="USDG to withdraw"
        action="Withdraw"
        busyLabel="Withdrawing…"
        disabled={!address || !stats.withdrawable}
        onSubmit={withdraw}
      />
      <p className="text-xs text-muted">
        Wallet: {usdg(stats.walletUsdg)} USDG on Arbitrum Sepolia.{lockNote ? ` ${lockNote}` : ""}
      </p>
    </div>
  );
}
