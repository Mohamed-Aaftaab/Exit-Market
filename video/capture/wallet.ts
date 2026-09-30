/**
 * A test wallet for recording the live app: an EIP-1193 request handler that runs in Node (the key never
 * enters the page) and signs/sends REAL testnet transactions with viem. The page gets a thin window.ethereum
 * that forwards every request here (see page.ts).
 */
import {
  createPublicClient,
  createWalletClient,
  hexToBigInt,
  http,
  numberToHex,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { xaiTestnet } from "../../scripts/lib/clients.ts";

type Emit = (event: "chainChanged" | "accountsChanged", value: unknown) => Promise<void>;
type TypedField = { name: string; type: string };

export interface TestWallet {
  address: Hex;
  request(method: string, params: unknown[]): Promise<unknown>;
  sent: Hex[];
}

export function createTestWallet(key: Hex, emit: Emit): TestWallet {
  const account = privateKeyToAccount(key);
  const chains: Record<number, Chain> = { [arbitrumSepolia.id]: arbitrumSepolia, [xaiTestnet.id]: xaiTestnet };
  const publics = new Map<number, PublicClient>();
  const wallets = new Map<number, WalletClient>();
  for (const chain of Object.values(chains)) {
    const transport = http(chain.rpcUrls.default.http[0]);
    publics.set(chain.id, createPublicClient({ chain, transport }) as PublicClient);
    wallets.set(chain.id, createWalletClient({ account, chain, transport }));
  }
  let chainId: number = arbitrumSepolia.id;
  const sent: Hex[] = [];

  async function sendTransaction(tx: Record<string, Hex | undefined>): Promise<Hex> {
    const wallet = wallets.get(chainId)!;
    const hash = await wallet.sendTransaction({
      account,
      chain: chains[chainId],
      to: tx.to,
      data: tx.data,
      value: tx.value ? hexToBigInt(tx.value) : undefined,
      gas: tx.gas ? hexToBigInt(tx.gas) : undefined,
    });
    sent.push(hash);
    return hash;
  }

  async function signTypedData(json: string): Promise<Hex> {
    const typed = JSON.parse(json) as {
      domain: Record<string, unknown>;
      types: Record<string, TypedField[]>;
      primaryType: string;
      message: Record<string, unknown>;
    };
    const { EIP712Domain: _domain, ...types } = typed.types;
    // Wallet JSON carries integers as strings; viem wants bigints for (u)int fields.
    const message = Object.fromEntries(
      Object.entries(typed.message).map(([k, v]) => {
        const field = types[typed.primaryType]?.find((f) => f.name === k);
        return [k, field && /^u?int/.test(field.type) ? BigInt(v as string) : v];
      }),
    );
    return account.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message });
  }

  async function request(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [account.address];
      case "eth_chainId":
        return numberToHex(chainId);
      case "net_version":
        return String(chainId);
      case "wallet_requestPermissions":
      case "wallet_getPermissions":
        return [{ parentCapability: "eth_accounts" }];
      case "wallet_addEthereumChain":
      case "wallet_watchAsset":
      case "wallet_revokePermissions":
        return null;
      case "wallet_switchEthereumChain": {
        const next = Number((params[0] as { chainId: Hex }).chainId);
        if (!chains[next]) throw Object.assign(new Error("Unrecognized chain"), { code: 4902 });
        chainId = next;
        await emit("chainChanged", numberToHex(next));
        return null;
      }
      case "eth_sendTransaction":
        return sendTransaction(params[0] as Record<string, Hex | undefined>);
      case "eth_signTypedData_v4":
        return signTypedData(params[1] as string);
      case "personal_sign":
        return account.signMessage({ message: { raw: params[0] as Hex } });
      default:
        return publics.get(chainId)!.request({ method, params } as never);
    }
  }

  return { address: account.address, request, sent };
}
