/**
 * Chain access the coverage check needs, as a small interface so tests run against a fake and the real
 * implementation (packages/exec read-only helpers) is adapted in adapter.ts. Amounts are base units (bigint).
 */

/** Mint account facts that decide the classic rug vectors. */
export interface MintInfo {
  decimals: number;
  supply: bigint;
  /** null = revoked: supply can no longer be inflated. */
  mintAuthority: string | null;
  /** null = revoked: holders can no longer be frozen. */
  freezeAuthority: string | null;
  /** Token program that owns the mint (Token or Token-2022). */
  programId: string;
  /** Token-2022 extension names present on the mint, empty for the classic Token program. */
  extensions: string[];
}

/** One token account holder: the owner wallet (or program PDA) and its balance. */
export interface Holder {
  owner: string;
  amount: bigint;
}

/** One sell of the project token by a watched wallet. */
export interface SellRecord {
  wallet: string;
  txSig: string;
  amount: bigint;
  ts: number;
  slot: number;
}

/** The pool a token trades in, when the reader can find it; lpMint null = the pool has no withdrawable LP token. */
export interface PoolInfo {
  /** Pool program id (PumpSwap, Raydium AMM/CPMM/CLMM, ...). */
  program: string;
  /** Pool account (PDA) address. */
  address: string;
  lpMint: string | null;
}

/** Read-only chain access. Every method may reject; the check catches and reports instead of throwing. */
export interface ChainReader {
  getMintInfo(mint: string): Promise<MintInfo>;
  getTokenBalances(mint: string, wallets: string[]): Promise<Map<string, bigint>>;
  getLargestHolders(mint: string, n: number): Promise<Holder[]>;
  getRecentSellersOf(mint: string, wallets: string[], sinceSlot: number): Promise<SellRecord[]>;
  findLinkedWallets(mint: string, seeds: string[], maxDepth: number): Promise<string[]>;
  /** Optional: current slot, persisted so the next check only scans new sells. */
  getSlot?(): Promise<number>;
  /** Optional: program that owns each account (System program for plain wallets, a locker program for its escrows). */
  getOwnerPrograms?(accounts: string[]): Promise<Map<string, string>>;
  /** Optional: the main pool of the token; absent or undefined result = "LP status unknown". */
  findPool?(mint: string): Promise<PoolInfo | undefined>;
}
