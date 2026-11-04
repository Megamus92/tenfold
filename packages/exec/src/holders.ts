/**
 * Read-only chain helpers for the badge module: mint authorities and Token-2022 extensions, holder balances, the
 * largest holders, recent insider sells and wallets funded by a seed wallet. No signing, no keys; every RPC call is
 * bounded by the 5 s per-call timeout. Amounts are bigint base units.
 */
import { type AccountInfo, type Connection, PublicKey, SystemProgram, type VersionedTransactionResponse } from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  unpackMint,
} from "@solana/spl-token";
import { WSOL_MINT } from "@tenfold/core";
import { isTransientHttpError, withTimeout } from "./http.js";

export type TokenProgram = "token" | "token-2022";

/** Token-2022 extensions that let the mint authority hurt holders; a gold badge needs none of them. */
export const DANGEROUS_EXTENSIONS: readonly string[] = ["TransferFeeConfig", "TransferHook", "PermanentDelegate", "DefaultAccountState", "NonTransferable"];

export interface MintInfo {
  decimals: number;
  supply: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  programId: TokenProgram;
  /** Extension names as in spl-token's ExtensionType (Token-2022 only; empty for the classic program). */
  extensions: string[];
}

export interface Holder {
  owner: string;
  tokenAccount: string;
  amount: bigint;
}

export interface SellEvent {
  wallet: string;
  txSig: string;
  /** Tokens that left the wallet, base units. */
  amount: bigint;
  /** Block time, unix ms (0 when the RPC did not report one). */
  ts: number;
  slot: number;
}

export interface LinkedWallet {
  wallet: string;
  /** The seed (or already-linked wallet) whose SystemProgram.transfer funded it. */
  fundedBy: string;
  txSig: string;
  slot: number;
  /** Lamports of that first funding transfer. */
  lamports: bigint;
  /** 1 = funded directly by a seed, 2 = funded by a depth-1 wallet, and so on. */
  depth: number;
  /** Current balance of the mint, base units (> 0 by construction). */
  balance: bigint;
}

/** Thrown by the chain readers; `retryable` is true for timeouts and transient RPC conditions. */
export class ChainReadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ChainReadError";
  }
}

/** getMultipleAccountsInfo batch size. */
export const ACCOUNTS_CHUNK = 100;
/** Signatures scanned per ATA when looking for sells. */
export const SELL_SCAN_LIMIT = 50;
/** Signatures scanned per seed wallet when looking for funded wallets. */
export const LINK_SCAN_LIMIT = 200;

/** Run one RPC call under the 5 s deadline and wrap any failure as ChainReadError. */
async function rpcCall<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await withTimeout(fn(), label);
  } catch (e) {
    if (e instanceof ChainReadError) throw e;
    throw new ChainReadError(`${label}: ${e instanceof Error ? e.message : String(e)}`, isTransientHttpError(e), e);
  }
}

function pk(s: string, field: string): PublicKey {
  try {
    return new PublicKey(s);
  } catch (e) {
    throw new ChainReadError(`${field}: not a public key (${s})`, false, e);
  }
}

/** Which token program owns an account, or undefined for anything else. */
export function tokenProgramOf(owner: PublicKey): TokenProgram | undefined {
  if (owner.equals(TOKEN_PROGRAM_ID)) return "token";
  if (owner.equals(TOKEN_2022_PROGRAM_ID)) return "token-2022";
  return undefined;
}

function programKey(p: TokenProgram): PublicKey {
  return p === "token" ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
}

/** Decode the raw amount of a token account's data (both programs share the first 165 bytes); 0 when malformed. */
export function decodeTokenAmount(info: AccountInfo<Buffer> | null): bigint {
  if (!info || info.data.length < ACCOUNT_SIZE) return 0n;
  return AccountLayout.decode(info.data.subarray(0, ACCOUNT_SIZE)).amount;
}

/** Decode the owner of a token account's data, or undefined when malformed. */
export function decodeTokenOwner(info: AccountInfo<Buffer> | null): string | undefined {
  if (!info || info.data.length < ACCOUNT_SIZE) return undefined;
  return AccountLayout.decode(info.data.subarray(0, ACCOUNT_SIZE)).owner.toBase58();
}

/** The subset of `extensions` that can hurt holders (see DANGEROUS_EXTENSIONS). */
export function dangerousExtensionsOf(extensions: string[]): string[] {
  return extensions.filter((e) => DANGEROUS_EXTENSIONS.includes(e));
}

/** Decimals, supply, authorities, owning token program and Token-2022 extension names of a mint. */
export async function getMintInfo(connection: Connection, mint: string): Promise<MintInfo> {
  const key = pk(mint, "mint");
  const info = await rpcCall("getAccountInfo(mint)", () => connection.getAccountInfo(key, "confirmed"));
  if (!info) throw new ChainReadError(`mint ${mint} not found`, false);
  const programId = tokenProgramOf(info.owner);
  if (!programId) throw new ChainReadError(`${mint} is not a token mint (owner ${info.owner.toBase58()})`, false);
  let m: ReturnType<typeof unpackMint>;
  try {
    m = unpackMint(key, info, programKey(programId));
  } catch (e) {
    throw new ChainReadError(`${mint}: mint account did not decode: ${(e as Error).message}`, false, e);
  }
  const extensions = programId === "token-2022" ? getExtensionTypes(m.tlvData).map((t) => ExtensionType[t] ?? `Unknown(${t})`) : [];
  return {
    decimals: m.decimals,
    supply: m.supply,
    mintAuthority: m.mintAuthority ? m.mintAuthority.toBase58() : null,
    freezeAuthority: m.freezeAuthority ? m.freezeAuthority.toBase58() : null,
    programId,
    extensions,
  };
}

/** Owning program of a mint (one getAccountInfo). */
async function mintProgram(connection: Connection, mintKey: PublicKey): Promise<TokenProgram> {
  const info = await rpcCall("getAccountInfo(mint)", () => connection.getAccountInfo(mintKey, "confirmed"));
  const p = info ? tokenProgramOf(info.owner) : undefined;
  if (!p) throw new ChainReadError(`${mintKey.toBase58()} is not a token mint`, false);
  return p;
}

/** Fetch account infos for many keys, ACCOUNTS_CHUNK at a time, preserving order. */
async function accountsInfo(connection: Connection, keys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
  const out: (AccountInfo<Buffer> | null)[] = [];
  for (let i = 0; i < keys.length; i += ACCOUNTS_CHUNK) {
    const chunk = keys.slice(i, i + ACCOUNTS_CHUNK);
    const infos = await rpcCall("getMultipleAccountsInfo", () => connection.getMultipleAccountsInfo(chunk, "confirmed"));
    for (let j = 0; j < chunk.length; j++) out.push(infos[j] ?? null);
  }
  return out;
}

/**
 * Balance of `mint` for each wallet: the sum of its associated token accounts under both token programs, 0 when
 * neither exists. Batched with getMultipleAccountsInfo in chunks of ACCOUNTS_CHUNK.
 */
export async function getTokenBalances(connection: Connection, mint: string, wallets: string[]): Promise<Map<string, bigint>> {
  const mintKey = pk(mint, "mint");
  const unique = [...new Set(wallets)];
  const result = new Map<string, bigint>(unique.map((w) => [w, 0n]));
  const lookups: { wallet: string; ata: PublicKey }[] = [];
  for (const w of unique) {
    const owner = pk(w, "wallet");
    for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      lookups.push({ wallet: w, ata: getAssociatedTokenAddressSync(mintKey, owner, true, program) });
    }
  }
  const infos = await accountsInfo(
    connection,
    lookups.map((l) => l.ata),
  );
  for (let i = 0; i < lookups.length; i++) {
    const info = infos[i] ?? null;
    if (!info || tokenProgramOf(info.owner) === undefined) continue;
    const l = lookups[i] as { wallet: string; ata: PublicKey };
    result.set(l.wallet, (result.get(l.wallet) ?? 0n) + decodeTokenAmount(info));
  }
  return result;
}

/** The `n` largest token accounts of the mint (RPC caps at 20) resolved to their owners, largest first. */
export async function getLargestHolders(connection: Connection, mint: string, n = 20): Promise<Holder[]> {
  const mintKey = pk(mint, "mint");
  const res = await rpcCall("getTokenLargestAccounts", () => connection.getTokenLargestAccounts(mintKey, "confirmed"));
  const top = res.value.slice(0, Math.max(0, n));
  const infos = await accountsInfo(
    connection,
    top.map((t) => t.address),
  );
  const holders: Holder[] = [];
  for (let i = 0; i < top.length; i++) {
    const t = top[i];
    if (!t) continue;
    const owner = decodeTokenOwner(infos[i] ?? null);
    if (!owner) continue; // closed between the two calls
    holders.push({ owner, tokenAccount: t.address.toBase58(), amount: BigInt(t.amount) });
  }
  holders.sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1));
  return holders;
}

/** All account keys of a fetched transaction (static, then loaded from lookup tables when the meta carries them). */
export function accountKeysOf(resp: VersionedTransactionResponse): PublicKey[] {
  const msg = resp.transaction.message;
  const loaded = resp.meta?.loadedAddresses;
  if (msg.version === "legacy") return msg.staticAccountKeys;
  if (msg.addressTableLookups.length === 0 || !loaded) return msg.staticAccountKeys;
  return [...msg.staticAccountKeys, ...loaded.writable, ...loaded.readonly];
}

/** Net change of `owner`'s balance of `mint` across the transaction (sum over its token accounts), base units. */
export function tokenDeltaOf(resp: VersionedTransactionResponse, owner: string, mint: string): bigint {
  const meta = resp.meta;
  if (!meta) return 0n;
  let pre = 0n;
  let post = 0n;
  for (const b of meta.preTokenBalances ?? []) if (b.owner === owner && b.mint === mint) pre += BigInt(b.uiTokenAmount.amount);
  for (const b of meta.postTokenBalances ?? []) if (b.owner === owner && b.mint === mint) post += BigInt(b.uiTokenAmount.amount);
  return post - pre;
}

/** Net change of `wallet`'s native SOL across the transaction, lamports (0 when the wallet is not among the keys). */
export function lamportsDeltaOf(resp: VersionedTransactionResponse, wallet: string): bigint {
  const meta = resp.meta;
  if (!meta) return 0n;
  const idx = accountKeysOf(resp).findIndex((k) => k.toBase58() === wallet);
  if (idx < 0) return 0n;
  const pre = meta.preBalances[idx];
  const post = meta.postBalances[idx];
  if (pre === undefined || post === undefined) return 0n;
  return BigInt(post) - BigInt(pre);
}

/**
 * Tokens of `mint` sold by `wallet` in this transaction: a decrease of its token balance together with an increase of
 * its SOL (native or wrapped). Returns the amount sold, or undefined when the transaction is not a sell.
 */
export function detectSell(resp: VersionedTransactionResponse, wallet: string, mint: string): bigint | undefined {
  if (!resp.meta || resp.meta.err) return undefined;
  const tokens = tokenDeltaOf(resp, wallet, mint);
  if (tokens >= 0n) return undefined;
  const sol = lamportsDeltaOf(resp, wallet) + tokenDeltaOf(resp, wallet, WSOL_MINT);
  if (sol <= 0n) return undefined;
  return -tokens;
}

/**
 * Sells of `mint` by each wallet since `sinceSlot`: the last SELL_SCAN_LIMIT signatures of the wallet's ATA (under the
 * mint's program) are fetched and kept when the wallet's token balance fell while its SOL rose. Newest first.
 */
export async function getRecentSellersOf(connection: Connection, mint: string, wallets: string[], sinceSlot: number): Promise<SellEvent[]> {
  const mintKey = pk(mint, "mint");
  const program = programKey(await mintProgram(connection, mintKey));
  const events: SellEvent[] = [];
  for (const wallet of new Set(wallets)) {
    const owner = pk(wallet, "wallet");
    const ata = getAssociatedTokenAddressSync(mintKey, owner, true, program);
    const sigs = await rpcCall("getSignaturesForAddress(ata)", () => connection.getSignaturesForAddress(ata, { limit: SELL_SCAN_LIMIT }, "confirmed"));
    for (const s of sigs) {
      if (s.err || s.slot < sinceSlot) continue;
      const tx = await rpcCall("getTransaction", () => connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }));
      if (!tx) continue;
      const amount = detectSell(tx, wallet, mint);
      if (amount === undefined) continue;
      const blockTime = tx.blockTime ?? s.blockTime ?? 0;
      events.push({ wallet, txSig: s.signature, amount, ts: blockTime * 1000, slot: tx.slot });
    }
  }
  events.sort((a, b) => b.slot - a.slot);
  return events;
}

/** SystemProgram.transfer instructions in a transaction as (from, to, lamports), in order. */
export function systemTransfersOf(resp: VersionedTransactionResponse): { from: string; to: string; lamports: bigint }[] {
  const keys = accountKeysOf(resp);
  const out: { from: string; to: string; lamports: bigint }[] = [];
  for (const ix of resp.transaction.message.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (!program || !program.equals(SystemProgram.programId)) continue;
    const data = Buffer.from(ix.data);
    if (data.length < 12 || data.readUInt32LE(0) !== 2) continue; // 2 = Transfer
    const from = keys[ix.accountKeyIndexes[0] ?? -1];
    const to = keys[ix.accountKeyIndexes[1] ?? -1];
    if (!from || !to) continue;
    out.push({ from: from.toBase58(), to: to.toBase58(), lamports: data.readBigUInt64LE(4) });
  }
  return out;
}

/**
 * Wallets funded by a seed wallet that hold the mint. For each seed, the last LINK_SCAN_LIMIT signatures are scanned
 * (oldest first) for SystemProgram.transfers out of the seed; every destination not seen before is a candidate, its
 * first such transfer is recorded, and with maxDepth > 1 the candidates are scanned in turn. Candidates with a zero
 * balance of the mint are dropped at the end (but still expanded, since a pass-through wallet may fund holders).
 */
export async function findLinkedWallets(connection: Connection, mint: string, seeds: string[], maxDepth = 1): Promise<LinkedWallet[]> {
  const seen = new Set<string>(seeds);
  const candidates = new Map<string, Omit<LinkedWallet, "balance">>();
  let frontier = [...new Set(seeds)];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const seed of frontier) {
      const seedKey = pk(seed, "seed");
      const sigs = await rpcCall("getSignaturesForAddress(seed)", () => connection.getSignaturesForAddress(seedKey, { limit: LINK_SCAN_LIMIT }, "confirmed"));
      for (const s of [...sigs].reverse()) {
        if (s.err) continue;
        const tx = await rpcCall("getTransaction", () => connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }));
        if (!tx || !tx.meta || tx.meta.err) continue;
        for (const t of systemTransfersOf(tx)) {
          if (t.from !== seed || seen.has(t.to)) continue;
          seen.add(t.to);
          candidates.set(t.to, { wallet: t.to, fundedBy: seed, txSig: s.signature, slot: tx.slot, lamports: t.lamports, depth });
          next.push(t.to);
        }
      }
    }
    frontier = next;
  }
  if (candidates.size === 0) return [];
  const balances = await getTokenBalances(connection, mint, [...candidates.keys()]);
  const linked: LinkedWallet[] = [];
  for (const c of candidates.values()) {
    const balance = balances.get(c.wallet) ?? 0n;
    if (balance > 0n) linked.push({ ...c, balance });
  }
  return linked;
}
