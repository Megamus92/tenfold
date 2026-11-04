/**
 * ChainReader over the read-only helpers of @tenfold/exec. The module is imported lazily, on first use, and typed
 * through a local shape, so this package compiles and loads even while exec is being changed; a missing helper
 * surfaces as a clear error from the check (caught and reported, never thrown to the caller).
 */
import type { Connection } from "@solana/web3.js";
import type { ChainReader, Holder, MintInfo, PoolInfo, SellRecord } from "./types.js";

/** The exec exports this adapter expects; every one is optional so a rename is reported, not a compile failure. */
interface ExecChainFns {
  getMintInfo?(connection: Connection, mint: string): Promise<MintInfo>;
  getTokenBalances?(connection: Connection, mint: string, wallets: string[]): Promise<Map<string, bigint>>;
  getLargestHolders?(connection: Connection, mint: string, n: number): Promise<Holder[]>;
  getRecentSellersOf?(connection: Connection, mint: string, wallets: string[], sinceSlot: number): Promise<SellRecord[]>;
  /** exec returns LinkedWallet records; plain pubkeys are accepted too. */
  findLinkedWallets?(connection: Connection, mint: string, seeds: string[], maxDepth: number): Promise<(string | { wallet: string })[]>;
  getOwnerPrograms?(connection: Connection, accounts: string[]): Promise<Map<string, string>>;
  findPool?(connection: Connection, mint: string): Promise<PoolInfo | undefined>;
}

/** Load @tenfold/exec once; the cast keeps this independent of exec's current export list. */
async function loadExec(): Promise<ExecChainFns> {
  const mod: unknown = await import("@tenfold/exec");
  return mod as ExecChainFns;
}

function need<K extends keyof ExecChainFns>(exec: ExecChainFns, name: K): NonNullable<ExecChainFns[K]> {
  const fn = exec[name];
  if (typeof fn !== "function") throw new Error(`@tenfold/exec does not export ${name}`);
  return fn as NonNullable<ExecChainFns[K]>;
}

/** A ChainReader bound to one RPC connection. Optional helpers are wired only when exec exports them. */
export function chainReaderFromExec(connection: Connection): ChainReader {
  let loading: Promise<ExecChainFns> | undefined;
  const exec = (): Promise<ExecChainFns> => (loading ??= loadExec());

  return {
    getMintInfo: async (mint) => need(await exec(), "getMintInfo")(connection, mint),
    getTokenBalances: async (mint, wallets) => need(await exec(), "getTokenBalances")(connection, mint, wallets),
    getLargestHolders: async (mint, n) => need(await exec(), "getLargestHolders")(connection, mint, n),
    getRecentSellersOf: async (mint, wallets, sinceSlot) => need(await exec(), "getRecentSellersOf")(connection, mint, wallets, sinceSlot),
    findLinkedWallets: async (mint, seeds, maxDepth) => {
      const found = await need(await exec(), "findLinkedWallets")(connection, mint, seeds, maxDepth);
      return found.map((w) => (typeof w === "string" ? w : w.wallet));
    },
    getSlot: () => connection.getSlot("confirmed"),
    getOwnerPrograms: async (accounts) => {
      const fns = await exec();
      if (fns.getOwnerPrograms) return fns.getOwnerPrograms(connection, accounts);
      return ownerProgramsViaRpc(connection, accounts);
    },
    findPool: async (mint) => {
      const fns = await exec();
      return fns.findPool ? fns.findPool(connection, mint) : undefined;
    },
  };
}

/** Owner program of each account straight from the RPC, 100 accounts per call; missing accounts are skipped. */
async function ownerProgramsViaRpc(connection: Connection, accounts: string[]): Promise<Map<string, string>> {
  const { PublicKey } = await import("@solana/web3.js");
  const out = new Map<string, string>();
  for (let i = 0; i < accounts.length; i += 100) {
    const batch = accounts.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(batch.map((a) => new PublicKey(a)));
    infos.forEach((info, j) => {
      const key = batch[j];
      if (info && key !== undefined) out.set(key, info.owner.toBase58());
    });
  }
  return out;
}
