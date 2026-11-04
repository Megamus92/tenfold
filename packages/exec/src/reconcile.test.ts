import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, type Connection } from "@solana/web3.js";
import { WSOL_MINT } from "@tenfold/core";
import { RECONCILE_ATTEMPTS, fetchOnChainFill, reconcileFill } from "./reconcile.js";
import { TEST_MINT, TEST_WALLET, TOKEN_2022_ID, tokenBalance, txResponse } from "./testutil.js";

const SIG = "3xReconcileSigXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const wallet = new PublicKey(TEST_WALLET);
const ata = Keypair.generate().publicKey;
const wsolTemp = Keypair.generate().publicKey;
const tipAccount = Keypair.generate().publicKey;

/** A message whose static keys put the wallet at 0, its token account at 1 and a temp WSOL account at 2. */
function message() {
  return new TransactionMessage({
    payerKey: wallet,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [
      SystemProgram.transfer({ fromPubkey: wallet, toPubkey: ata, lamports: 1 }),
      SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wsolTemp, lamports: 1 }),
      SystemProgram.transfer({ fromPubkey: wallet, toPubkey: tipAccount, lamports: 1 }),
    ],
  }).compileToV0Message();
}

const msg = message();
const keys = msg.staticAccountKeys.map((k) => k.toBase58());
const W = keys.indexOf(TEST_WALLET);
const A = keys.indexOf(ata.toBase58());
const S = keys.indexOf(wsolTemp.toBase58());
const T = keys.indexOf(tipAccount.toBase58());

function balances(over: Record<number, number>, base = 0): number[] {
  const arr = new Array<number>(keys.length).fill(base);
  for (const [i, v] of Object.entries(over)) arr[Number(i)] = v;
  return arr;
}

describe("reconcileFill", () => {
  it("buy: SOL spent = wallet delta minus fee, tip and the rent of the ATA the swap created; tokens from the Token-2022 entry", () => {
    // Wallet pays 0.2 SOL for the swap + 5_000 fee + 1_000_000 priority (fee field already includes it) + 100_000 tip,
    // and 2_039_280 lamports rent into a freshly created Token-2022 ATA. It receives 950_000_000 base units (950 tokens).
    const fee = 1_005_000;
    const tip = 100_000n;
    const rent = 2_039_280;
    const swapIn = 200_000_000;
    const pre = 10_000_000_000;
    const resp = txResponse({
      message: msg,
      signature: SIG,
      slot: 4242,
      fee,
      preBalances: balances({ [W]: pre, [A]: 0, [S]: 0, [T]: 1_000 }),
      postBalances: balances({ [W]: pre - swapIn - fee - Number(tip) - rent, [A]: rent, [S]: 0, [T]: 1_000 + Number(tip) }),
      preTokenBalances: [],
      postTokenBalances: [
        tokenBalance(A, TEST_MINT, TEST_WALLET, 950_000_000n, 6, TOKEN_2022_ID),
        // another holder's account of the same mint in the same tx (the pool): must be ignored
        tokenBalance(S, TEST_MINT, Keypair.generate().publicKey.toBase58(), 123n),
      ],
    });
    const fill = reconcileFill(resp, "buy", TEST_WALLET, TEST_MINT, tip);
    expect(fill).toEqual({ inAmount: 200_000_000n, outAmount: 950_000_000n, feeLamports: BigInt(fee) + tip, slot: 4242 });
  });

  it("sell: tokens from the balance decrease, SOL received = wallet delta plus fee (no tip on the RPC path)", () => {
    const fee = 15_000;
    const pre = 5_000_000_000;
    const out = 199_400_000;
    const resp = txResponse({
      message: msg,
      signature: SIG,
      slot: 77,
      fee,
      preBalances: balances({ [W]: pre, [A]: 2_039_280 }),
      postBalances: balances({ [W]: pre + out - fee, [A]: 2_039_280 }),
      preTokenBalances: [tokenBalance(A, TEST_MINT, TEST_WALLET, 5_000_000_000n), tokenBalance(S, WSOL_MINT, TEST_WALLET, 0n, 9)],
      postTokenBalances: [tokenBalance(A, TEST_MINT, TEST_WALLET, 4_000_000_000n), tokenBalance(S, WSOL_MINT, TEST_WALLET, 0n, 9)],
    });
    const fill = reconcileFill(resp, "sell", TEST_WALLET, TEST_MINT, 0n);
    expect(fill).toEqual({ inAmount: 1_000_000_000n, outAmount: 199_400_000n, feeLamports: 15_000n, slot: 77 });
  });

  it("returns undefined without meta, on a failed tx, or when the wallet has no token account for the mint", () => {
    const ok = txResponse({ message: msg, signature: SIG, preBalances: balances({}), postBalances: balances({}) });
    expect(reconcileFill({ ...ok, meta: null }, "buy", TEST_WALLET, TEST_MINT, 0n)).toBeUndefined();
    expect(reconcileFill(txResponse({ message: msg, signature: SIG, preBalances: [], postBalances: [], err: { InstructionError: [0, "Custom"] } }), "buy", TEST_WALLET, TEST_MINT, 0n)).toBeUndefined();
    expect(reconcileFill(ok, "buy", TEST_WALLET, TEST_MINT, 0n)).toBeUndefined();
  });
});

describe("fetchOnChainFill", () => {
  it("asks getTransaction up to 3 times and gives up with undefined", async () => {
    let calls = 0;
    const rpc = {
      getTransaction: async () => {
        calls++;
        if (calls === 1) throw new Error("fetch failed");
        return null;
      },
    } as unknown as Connection;
    const res = await fetchOnChainFill(rpc, SIG, "buy", TEST_WALLET, TEST_MINT, 0n, async () => undefined);
    expect(res).toBeUndefined();
    expect(calls).toBe(RECONCILE_ATTEMPTS);
  });

  it("returns the reconciled fill once the transaction is indexed", async () => {
    let calls = 0;
    const resp = txResponse({
      message: msg,
      signature: SIG,
      fee: 5000,
      preBalances: balances({ [W]: 1_000_000_000, [A]: 2_039_280 }),
      postBalances: balances({ [W]: 1_000_000_000 + 50_000_000 - 5000, [A]: 2_039_280 }),
      preTokenBalances: [tokenBalance(A, TEST_MINT, TEST_WALLET, 300_000_000n)],
      postTokenBalances: [tokenBalance(A, TEST_MINT, TEST_WALLET, 50_000_000n)],
    });
    const rpc = {
      getTransaction: async (sig: string, cfg: { maxSupportedTransactionVersion: number; commitment: string }) => {
        calls++;
        expect(sig).toBe(SIG);
        expect(cfg).toEqual({ maxSupportedTransactionVersion: 0, commitment: "confirmed" });
        return calls < 2 ? null : resp;
      },
    } as unknown as Connection;
    const res = await fetchOnChainFill(rpc, SIG, "sell", TEST_WALLET, TEST_MINT, 0n, async () => undefined);
    expect(res).toEqual({ inAmount: 250_000_000n, outAmount: 50_000_000n, feeLamports: 5000n, slot: 1000 });
    expect(calls).toBe(2);
  });

  it("rejects an inconsistent reconciliation (zero amount) so the caller falls back to the quote", async () => {
    const resp = txResponse({
      message: msg,
      signature: SIG,
      preBalances: balances({ [W]: 1_000_000_000, [A]: 1 }),
      postBalances: balances({ [W]: 1_000_000_000 - 5000, [A]: 1 }),
      preTokenBalances: [tokenBalance(A, TEST_MINT, TEST_WALLET, 1n)],
      postTokenBalances: [tokenBalance(A, TEST_MINT, TEST_WALLET, 1n)],
    });
    const rpc = { getTransaction: async () => resp } as unknown as Connection;
    expect(await fetchOnChainFill(rpc, SIG, "buy", TEST_WALLET, TEST_MINT, 0n, async () => undefined)).toBeUndefined();
  });
});
