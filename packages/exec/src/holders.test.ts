import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, type AccountInfo, type Connection, type ConfirmedSignatureInfo, type VersionedTransactionResponse } from "@solana/web3.js";
import { ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { WSOL_MINT } from "@tenfold/core";
import {
  ACCOUNTS_CHUNK,
  ChainReadError,
  dangerousExtensionsOf,
  findLinkedWallets,
  getLargestHolders,
  getMintInfo,
  getRecentSellersOf,
  getTokenBalances,
} from "./holders.js";
import { TimeoutError, withTimeout } from "./http.js";
import { accountInfo, mint2022Data, mintData, tokenAccountData, tokenBalance, txResponse } from "./testutil.js";

const mint = Keypair.generate().publicKey;
const MINT = mint.toBase58();
const authority = Keypair.generate().publicKey;

interface ChainState {
  accounts: Map<string, AccountInfo<Buffer>>;
  signatures: Map<string, ConfirmedSignatureInfo[]>;
  txs: Map<string, VersionedTransactionResponse>;
  largest?: { address: PublicKey; amount: string }[];
}

interface Calls {
  multiple: number[];
  sigLimits: number[];
}

/** A Connection double backed by maps of accounts, signature lists and transactions. */
function fakeRpc(state: ChainState): { rpc: Connection; calls: Calls } {
  const calls: Calls = { multiple: [], sigLimits: [] };
  const rpc = {
    getAccountInfo: async (key: PublicKey) => state.accounts.get(key.toBase58()) ?? null,
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      calls.multiple.push(keys.length);
      return keys.map((k) => state.accounts.get(k.toBase58()) ?? null);
    },
    getTokenLargestAccounts: async () => ({ context: { slot: 1 }, value: (state.largest ?? []).map((l) => ({ ...l, decimals: 6, uiAmount: null })) }),
    getSignaturesForAddress: async (key: PublicKey, opts: { limit: number }) => {
      calls.sigLimits.push(opts.limit);
      return state.signatures.get(key.toBase58()) ?? [];
    },
    getTransaction: async (sig: string) => state.txs.get(sig) ?? null,
  };
  return { rpc: rpc as unknown as Connection, calls };
}

function sigInfo(signature: string, slot: number, err: ConfirmedSignatureInfo["err"] = null): ConfirmedSignatureInfo {
  return { signature, slot, err, memo: null, blockTime: 1_700_000_000 + slot, confirmationStatus: "confirmed" };
}

describe("getMintInfo", () => {
  it("reads a Token-2022 mint with a transfer hook and names the dangerous extension", async () => {
    const data = mint2022Data(
      { decimals: 6, supply: 1_000_000_000_000n, mintAuthority: authority },
      [
        { type: ExtensionType.MetadataPointer, len: 64 },
        { type: ExtensionType.TransferHook, len: 64 },
      ],
    );
    const { rpc } = fakeRpc({ accounts: new Map([[MINT, accountInfo(TOKEN_2022_PROGRAM_ID, data)]]), signatures: new Map(), txs: new Map() });
    const info = await getMintInfo(rpc, MINT);
    expect(info).toEqual({
      decimals: 6,
      supply: 1_000_000_000_000n,
      mintAuthority: authority.toBase58(),
      freezeAuthority: null,
      programId: "token-2022",
      extensions: ["MetadataPointer", "TransferHook"],
    });
    expect(dangerousExtensionsOf(info.extensions)).toEqual(["TransferHook"]);
  });

  it("reads a classic mint with both authorities revoked, and rejects non-mints", async () => {
    const { rpc } = fakeRpc({
      accounts: new Map([
        [MINT, accountInfo(TOKEN_PROGRAM_ID, mintData({ decimals: 9, supply: 42n }))],
        [authority.toBase58(), accountInfo(SystemProgram.programId, Buffer.alloc(0))],
      ]),
      signatures: new Map(),
      txs: new Map(),
    });
    expect(await getMintInfo(rpc, MINT)).toEqual({ decimals: 9, supply: 42n, mintAuthority: null, freezeAuthority: null, programId: "token", extensions: [] });
    await expect(getMintInfo(rpc, authority.toBase58())).rejects.toBeInstanceOf(ChainReadError);
    const missing = await getMintInfo(rpc, Keypair.generate().publicKey.toBase58()).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(ChainReadError);
    expect((missing as ChainReadError).retryable).toBe(false);
  });

  it("bounds every call with the per-call timeout", async () => {
    const never = new Promise<never>(() => undefined);
    const err = await withTimeout(never, "getAccountInfo", 20).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toMatch(/getAccountInfo timed out after 20 ms/);
  });
});

describe("getTokenBalances", () => {
  it("sums ATAs of both programs, counts a missing ATA as 0, and batches 100 accounts per call", async () => {
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    const c = Keypair.generate().publicKey;
    const accounts = new Map<string, AccountInfo<Buffer>>();
    accounts.set(getAssociatedTokenAddressSync(mint, a, true, TOKEN_PROGRAM_ID).toBase58(), accountInfo(TOKEN_PROGRAM_ID, tokenAccountData(mint, a, 1_000n)));
    accounts.set(getAssociatedTokenAddressSync(mint, b, true, TOKEN_2022_PROGRAM_ID).toBase58(), accountInfo(TOKEN_2022_PROGRAM_ID, tokenAccountData(mint, b, 5n)));
    const { rpc, calls } = fakeRpc({ accounts, signatures: new Map(), txs: new Map() });
    const wallets = [a, b, c, ...Array.from({ length: 57 }, () => Keypair.generate().publicKey)].map((k) => k.toBase58());
    const balances = await getTokenBalances(rpc, MINT, [...wallets, a.toBase58()]);
    expect(balances.get(a.toBase58())).toBe(1_000n);
    expect(balances.get(b.toBase58())).toBe(5n);
    expect(balances.get(c.toBase58())).toBe(0n);
    expect(balances.size).toBe(60);
    // 60 wallets x 2 programs = 120 addresses -> one full chunk and one of 20
    expect(calls.multiple).toEqual([ACCOUNTS_CHUNK, 20]);
  });
});

describe("getLargestHolders", () => {
  it("resolves the largest token accounts to their owners, largest first, capped at n", async () => {
    const owners = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    const tokenAccounts = owners.map((o) => getAssociatedTokenAddressSync(mint, o, true));
    const amounts = [500n, 9_000n, 70n];
    const accounts = new Map<string, AccountInfo<Buffer>>();
    tokenAccounts.forEach((ta, i) => accounts.set(ta.toBase58(), accountInfo(TOKEN_PROGRAM_ID, tokenAccountData(mint, owners[i] as PublicKey, amounts[i] as bigint))));
    const { rpc } = fakeRpc({
      accounts,
      signatures: new Map(),
      txs: new Map(),
      largest: [1, 0, 2].map((i) => ({ address: tokenAccounts[i] as PublicKey, amount: String(amounts[i]) })),
    });
    const holders = await getLargestHolders(rpc, MINT, 2);
    expect(holders).toEqual([
      { owner: owners[1]?.toBase58(), tokenAccount: tokenAccounts[1]?.toBase58(), amount: 9_000n },
      { owner: owners[0]?.toBase58(), tokenAccount: tokenAccounts[0]?.toBase58(), amount: 500n },
    ]);
  });
});

describe("getRecentSellersOf", () => {
  it("detects one sell (token balance down, SOL up) since the slot, skipping transfers and old transactions", async () => {
    const wallet = Keypair.generate().publicKey;
    const W = wallet.toBase58();
    const ata = getAssociatedTokenAddressSync(mint, wallet, true, TOKEN_PROGRAM_ID);
    const pool = Keypair.generate().publicKey;
    const msg = new TransactionMessage({
      payerKey: wallet,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [SystemProgram.transfer({ fromPubkey: wallet, toPubkey: ata, lamports: 1 }), SystemProgram.transfer({ fromPubkey: wallet, toPubkey: pool, lamports: 1 })],
    }).compileToV0Message();
    const idx = (k: PublicKey) => msg.staticAccountKeys.findIndex((x) => x.equals(k));
    const [iW, iA, iP] = [idx(wallet), idx(ata), idx(pool)];
    const bal = (w: number, a: number, p: number) => {
      const arr = new Array<number>(msg.staticAccountKeys.length).fill(0);
      arr[iW] = w;
      arr[iA] = a;
      arr[iP] = p;
      return arr;
    };
    const txs = new Map<string, VersionedTransactionResponse>();
    // old sell, before sinceSlot
    txs.set("s-old", txResponse({ message: msg, signature: "s-old", slot: 900, preBalances: bal(1e9, 2e6, 5e9), postBalances: bal(1.1e9 - 5000, 2e6, 4.9e9), preTokenBalances: [tokenBalance(iA, MINT, W, 2_000n)], postTokenBalances: [tokenBalance(iA, MINT, W, 1_000n)] }));
    // the sell: 600 tokens out, 0.1 SOL in (minus the fee)
    txs.set("s-sell", txResponse({ message: msg, signature: "s-sell", slot: 1100, blockTime: 1_700_001_100, preBalances: bal(1e9, 2e6, 5e9), postBalances: bal(1e9 + 1e8 - 5000, 2e6, 5e9 - 1e8), preTokenBalances: [tokenBalance(iA, MINT, W, 1_000n), tokenBalance(iP, WSOL_MINT, pool.toBase58(), 0n, 9)], postTokenBalances: [tokenBalance(iA, MINT, W, 400n), tokenBalance(iP, WSOL_MINT, pool.toBase58(), 0n, 9)] }));
    // a plain token transfer out: tokens down, SOL down by the fee -> not a sell
    txs.set("s-xfer", txResponse({ message: msg, signature: "s-xfer", slot: 1200, preBalances: bal(1e9, 2e6, 0), postBalances: bal(1e9 - 5000, 2e6, 0), preTokenBalances: [tokenBalance(iA, MINT, W, 400n)], postTokenBalances: [tokenBalance(iA, MINT, W, 300n)] }));
    // a buy: tokens up
    txs.set("s-buy", txResponse({ message: msg, signature: "s-buy", slot: 1300, preBalances: bal(1e9, 2e6, 0), postBalances: bal(1e9 - 5e7, 2e6, 5e7), preTokenBalances: [tokenBalance(iA, MINT, W, 300n)], postTokenBalances: [tokenBalance(iA, MINT, W, 800n)] }));
    const { rpc, calls } = fakeRpc({
      accounts: new Map([[MINT, accountInfo(TOKEN_PROGRAM_ID, mintData({ decimals: 6, supply: 1n }))]]),
      signatures: new Map([[ata.toBase58(), [sigInfo("s-buy", 1300), sigInfo("s-xfer", 1200), sigInfo("s-failed", 1150, { InstructionError: [0, "Custom"] }), sigInfo("s-sell", 1100), sigInfo("s-old", 900)]]]),
      txs,
    });
    const sells = await getRecentSellersOf(rpc, MINT, [W, Keypair.generate().publicKey.toBase58()], 1000);
    expect(sells).toEqual([{ wallet: W, txSig: "s-sell", amount: 600n, ts: 1_700_001_100_000, slot: 1100 }]);
    expect(calls.sigLimits).toEqual([50, 50]);
  });
});

describe("findLinkedWallets", () => {
  it("follows SystemProgram.transfers out of the seeds and keeps the destinations that hold the mint", async () => {
    const seed = Keypair.generate().publicKey;
    const x = Keypair.generate().publicKey; // funded by seed, holds the mint
    const y = Keypair.generate().publicKey; // funded by seed, holds nothing
    const z = Keypair.generate().publicKey; // funded by x, holds the mint (depth 2)
    const bh = "11111111111111111111111111111111";
    const transferTx = (from: PublicKey, to: PublicKey, lamports: number, sig: string, slot: number) => {
      const msg = new TransactionMessage({ payerKey: from, recentBlockhash: bh, instructions: [SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports })] }).compileToV0Message();
      const n = msg.staticAccountKeys.length;
      return txResponse({ message: msg, signature: sig, slot, preBalances: new Array<number>(n).fill(0), postBalances: new Array<number>(n).fill(0) });
    };
    const txs = new Map<string, VersionedTransactionResponse>([
      ["t-x", transferTx(seed, x, 1_000_000_000, "t-x", 100)],
      ["t-y", transferTx(seed, y, 500_000_000, "t-y", 200)],
      ["t-x2", transferTx(seed, x, 5, "t-x2", 300)], // second top-up: not the first funding
      ["t-back", transferTx(x, seed, 7, "t-back", 400)], // into the seed, ignored
      ["t-z", transferTx(x, z, 250_000_000, "t-z", 500)],
    ]);
    const accounts = new Map<string, AccountInfo<Buffer>>();
    accounts.set(getAssociatedTokenAddressSync(mint, x, true).toBase58(), accountInfo(TOKEN_PROGRAM_ID, tokenAccountData(mint, x, 100n)));
    accounts.set(getAssociatedTokenAddressSync(mint, z, true, TOKEN_2022_PROGRAM_ID).toBase58(), accountInfo(TOKEN_2022_PROGRAM_ID, tokenAccountData(mint, z, 7n)));
    const { rpc, calls } = fakeRpc({
      accounts,
      // newest first, as the RPC returns them
      signatures: new Map([
        [seed.toBase58(), [sigInfo("t-back", 400), sigInfo("t-x2", 300), sigInfo("t-y", 200), sigInfo("t-x", 100)]],
        [x.toBase58(), [sigInfo("t-z", 500), sigInfo("t-back", 400), sigInfo("t-x2", 300), sigInfo("t-x", 100)]],
      ]),
      txs,
    });
    const depth1 = await findLinkedWallets(rpc, MINT, [seed.toBase58()]);
    expect(depth1).toEqual([{ wallet: x.toBase58(), fundedBy: seed.toBase58(), txSig: "t-x", slot: 100, lamports: 1_000_000_000n, depth: 1, balance: 100n }]);
    expect(calls.sigLimits).toEqual([200]);

    const depth2 = await findLinkedWallets(rpc, MINT, [seed.toBase58()], 2);
    expect(depth2.map((l) => [l.wallet, l.fundedBy, l.depth, l.balance])).toEqual([
      [x.toBase58(), seed.toBase58(), 1, 100n],
      [z.toBase58(), x.toBase58(), 2, 7n],
    ]);
  });
});
