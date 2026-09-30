"use client";

import { useState } from "react";
import { zeroAddress, type Address, type Hash } from "viem";
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
    ],
    query: { enabled: Boolean(vault), refetchInterval: 30_000 },
  });
  const [totalAssets, idle, outstanding, aprBps, baseFeeBps, withdrawable, shareLock, unlockTime, walletUsdg] =
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
    walletUsdg: user ? walletUsdg : undefined,
  };
}

/** Sends a vault transaction on Arbitrum Sepolia and waits for it; throws if it reverted. */
function useVaultTx() {
  const { chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const parent = usePublicClient({ chainId: arbitrumSepolia.id });
  return async (send: () => Promise<Hash>): Promise<void> => {
    if (!parent) throw new Error("Arbitrum Sepolia client unavailable");
    if (chainId !== arbitrumSepolia.id) await switchChainAsync({ chainId: arbitrumSepolia.id });
    const hash = await send();
    const receipt = await parent.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
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

export function VaultPanel() {
  const { address } = useAccount();
  const vault = DEPLOYMENT.vault;
  const stats = useVaultStats(vault, address);
  const sendTx = useVaultTx();
  const { writeContractAsync } = useWriteContract();

  if (!vault) return <p className="p-5 text-sm text-muted">Vault not deployed yet.</p>;

  // The vault itself reports 0 withdrawable while shares are locked; show when they unlock.
  const lockNote =
    stats.unlockTime !== undefined && stats.withdrawable === 0n
      ? `Your shares unlock ${new Date(stats.unlockTime * 1000).toLocaleString()} (or when idle liquidity returns).`
      : undefined;

  async function deposit(assets: bigint, setStatus: (s: string) => void) {
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
      <AmountForm label="USDG to deposit" action="Deposit" busyLabel="Depositing…" disabled={!address} onSubmit={deposit} />
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
