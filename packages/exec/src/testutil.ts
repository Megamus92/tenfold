/** Fixtures shared by the exec tests (not exported from the package). */
import type { Order, ProjectConfig, Snapshot } from "@tenfold/core";
import { DEFAULT_RULES, DEFAULT_STRATEGY, WSOL_MINT } from "@tenfold/core";

export const TEST_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
export const TEST_WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

export function testConfig(over: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: "test",
    name: "Test",
    mint: TEST_MINT,
    decimals: 6,
    walletPubkey: TEST_WALLET,
    mode: "paper",
    rules: { ...DEFAULT_RULES },
    strategy: { ...DEFAULT_STRATEGY, defense: { enabled: false, levels: [] } },
    createdAt: 0,
    paused: false,
    ...over,
  };
}

export function testSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    projectId: "test",
    ts: 1_700_000_000_000,
    price: 0.0002,
    liquiditySol: 100,
    buyFlow5mSol: 0,
    sellFlow5mSol: 0,
    vaultTokens: 1_000_000_000_000n,
    vaultLamports: 10_000_000_000n,
    ...over,
  };
}

export function testOrder(side: "buy" | "sell", amountIn: bigint, over: Partial<Order> = {}): Order {
  return {
    id: `o-${side}`,
    projectId: "test",
    side,
    reason: side === "buy" ? "DEF" : "DIST",
    inputMint: side === "buy" ? WSOL_MINT : TEST_MINT,
    outputMint: side === "buy" ? TEST_MINT : WSOL_MINT,
    amountIn,
    maxSlippageBps: 100,
    refPrice: 0.0002,
    status: "approved",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

// ---- chain fixtures (synthetic account data and getTransaction responses) ----
import { PublicKey, type AccountInfo, type TokenBalance, type TransactionError, type VersionedMessage, type VersionedTransactionResponse } from "@solana/web3.js";
import { ACCOUNT_SIZE, AccountLayout, AccountState, MINT_SIZE, MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

export const TOKEN_2022_ID = TOKEN_2022_PROGRAM_ID.toBase58();
export const TOKEN_ID = TOKEN_PROGRAM_ID.toBase58();

/** Raw data of a classic SPL mint account. */
export function mintData(opts: { decimals: number; supply: bigint; mintAuthority?: PublicKey; freezeAuthority?: PublicKey }): Buffer {
  const buf = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: opts.mintAuthority ? 1 : 0,
      mintAuthority: opts.mintAuthority ?? PublicKey.default,
      supply: opts.supply,
      decimals: opts.decimals,
      isInitialized: true,
      freezeAuthorityOption: opts.freezeAuthority ? 1 : 0,
      freezeAuthority: opts.freezeAuthority ?? PublicKey.default,
    },
    buf,
  );
  return buf;
}

/** Raw data of a Token-2022 mint: base mint, padding to the account size, the Mint account-type byte, then TLV extensions. */
export function mint2022Data(base: Parameters<typeof mintData>[0], extensions: { type: number; len: number }[]): Buffer {
  const parts: Buffer[] = [mintData(base), Buffer.alloc(ACCOUNT_SIZE - MINT_SIZE), Buffer.from([1])];
  for (const e of extensions) {
    const hdr = Buffer.alloc(4);
    hdr.writeUInt16LE(e.type, 0);
    hdr.writeUInt16LE(e.len, 2);
    parts.push(hdr, Buffer.alloc(e.len));
  }
  return Buffer.concat(parts);
}

/** Raw data of a token account (both programs share this 165-byte prefix). */
export function tokenAccountData(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const buf = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: AccountState.Initialized,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    buf,
  );
  return buf;
}

export function accountInfo(owner: PublicKey, data: Buffer, lamports = 2_039_280): AccountInfo<Buffer> {
  return { executable: false, owner, lamports, data, rentEpoch: 0 };
}

export function tokenBalance(accountIndex: number, mint: string, owner: string, amount: bigint, decimals = 6, programId = TOKEN_ID): TokenBalance {
  return { accountIndex, mint, owner, programId, uiTokenAmount: { amount: amount.toString(), decimals, uiAmount: Number(amount) / 10 ** decimals } };
}

export interface TxResponseOpts {
  message: VersionedMessage;
  signature: string;
  slot?: number;
  blockTime?: number;
  fee?: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: TokenBalance[];
  postTokenBalances?: TokenBalance[];
  err?: TransactionError | null;
}

/** A getTransaction response for a real compiled message plus hand-written meta. */
export function txResponse(o: TxResponseOpts): VersionedTransactionResponse {
  return {
    slot: o.slot ?? 1000,
    blockTime: o.blockTime ?? 1_700_000_000,
    transaction: { message: o.message, signatures: [o.signature] },
    meta: {
      fee: o.fee ?? 5000,
      err: o.err ?? null,
      preBalances: o.preBalances,
      postBalances: o.postBalances,
      preTokenBalances: o.preTokenBalances ?? [],
      postTokenBalances: o.postTokenBalances ?? [],
      innerInstructions: [],
      logMessages: [],
    },
    version: o.message.version,
  };
}
