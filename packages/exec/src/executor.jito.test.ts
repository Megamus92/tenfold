/**
 * Live-path tests for the Jito bundle route: the tip lands inside the swap transaction (after an ALT round trip), the
 * bundle is polled to confirmation, and the fill is reconciled from the chain.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PACKET_DATA_SIZE,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import bs58 from "bs58";
import { ExecError, JupiterExecutor } from "./executor.js";
import type { JupiterClient, JupiterQuote, QuoteParams } from "./jupiter.js";
import { Signer, createWallet, verifyMessage } from "./signer.js";
import { TEST_MINT, testConfig, testOrder, testSnapshot, tokenBalance, txResponse } from "./testutil.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

let dir: string;
let wallet: string;
let signer: Signer;
const password = "jito test password";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tenfold-jito-keys-"));
  wallet = createWallet(dir, password, "jito");
  signer = new Signer(dir, password);
});
afterAll(() => {
  signer.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const TIPS = ["96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe"];
const TIP = 100_000n;
const BLOCKHASH = "11111111111111111111111111111111";
const fakeDex = Keypair.generate().publicKey;
const altKey = Keypair.generate().publicKey;
const poolA = Keypair.generate().publicKey;
const poolB = Keypair.generate().publicKey;
const alt = new AddressLookupTableAccount({
  key: altKey,
  state: { deactivationSlot: 0xffffffffffffffffn, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [poolA, poolB] },
});

/** An unsigned v0 "swap" that reaches poolA/poolB through the lookup table, like a real Jupiter transaction. */
function swapTx(extraKeys = 0): VersionedTransaction {
  const payer = new PublicKey(wallet);
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: poolA, isSigner: false, isWritable: true },
    { pubkey: poolB, isSigner: false, isWritable: false },
  ];
  for (let i = 0; i < extraKeys; i++) keys.push({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true });
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: BLOCKHASH,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      new TransactionInstruction({ programId: fakeDex, keys, data: Buffer.from([9, 9, 9]) }),
    ],
  }).compileToV0Message([alt]);
  expect(msg.addressTableLookups).toHaveLength(1);
  return new VersionedTransaction(msg);
}

function fakeJupiter(tx: VersionedTransaction): JupiterClient {
  return {
    async quote(p: QuoteParams): Promise<JupiterQuote> {
      return { inputMint: p.inputMint, outputMint: p.outputMint, inAmount: p.amount, outAmount: 123_000_000n, otherAmountThreshold: 120_000_000n, slippageBps: p.slippageBps, priceImpact: 0.001, hops: 1, raw: {} };
    },
    async swap() {
      return { swapTransaction: Buffer.from(tx.serialize()).toString("base64"), lastValidBlockHeight: 100, prioritizationFeeLamports: 1000 };
    },
  } as unknown as JupiterClient;
}

interface JitoCalls {
  methods: string[];
  bundles: string[][];
}

/** Jito endpoint double: tip accounts, sendBundle capture, and a scripted sequence of bundle statuses. */
function stubJito(statuses: (poll: number) => unknown): JitoCalls {
  const calls: JitoCalls = { methods: [], bundles: [] };
  let polls = 0;
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.methods.push(body.method);
    let result: unknown;
    if (body.method === "getTipAccounts") result = TIPS;
    else if (body.method === "sendBundle") {
      calls.bundles.push(body.params[0] as string[]);
      result = "bundle-1";
    } else if (body.method === "getBundleStatuses") result = statuses(++polls);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  });
  return calls;
}

/** Synthetic getTransaction answer for a buy of 123 tokens for 0.2 SOL, fee 6_000, tip TIP. */
function buyResponse(sig: string, slot: number) {
  const payer = new PublicKey(wallet);
  const ata = Keypair.generate().publicKey;
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: ata, lamports: 1 })] }).compileToV0Message();
  const W = msg.staticAccountKeys.findIndex((k) => k.equals(payer));
  const A = msg.staticAccountKeys.findIndex((k) => k.equals(ata));
  const pre = [0, 0, 0];
  const post = [0, 0, 0];
  pre[W] = 10_000_000_000;
  post[W] = 10_000_000_000 - 200_000_000 - 6_000 - Number(TIP);
  pre[A] = 2_039_280;
  post[A] = 2_039_280;
  return txResponse({
    message: msg,
    signature: sig,
    slot,
    fee: 6_000,
    preBalances: pre,
    postBalances: post,
    preTokenBalances: [tokenBalance(A, TEST_MINT, wallet, 1_000_000n)],
    postTokenBalances: [tokenBalance(A, TEST_MINT, wallet, 124_000_000n)],
  });
}

interface RpcScript {
  getTransaction?: (sig: string) => unknown;
  confirmSlot?: number;
}

function fakeRpc(script: RpcScript, sent: Uint8Array[] = []): Connection {
  return {
    getAddressLookupTable: async (key: PublicKey) => {
      expect(key.equals(altKey)).toBe(true);
      return { context: { slot: 1 }, value: alt };
    },
    sendRawTransaction: async (raw: Uint8Array) => {
      sent.push(raw);
      return bs58.encode(VersionedTransaction.deserialize(raw).signatures[0] as Uint8Array);
    },
    confirmTransaction: async () => ({ context: { slot: script.confirmSlot ?? 700 }, value: { err: null } }),
    getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [null] }),
    getTransaction: async (sig: string) => (script.getTransaction ? script.getTransaction(sig) : null),
  } as unknown as Connection;
}

function executor(rpc: Connection, tx: VersionedTransaction): JupiterExecutor {
  return new JupiterExecutor(rpc, signer, {
    priorityFeeMicroLamports: 50_000,
    jitoUrl: "https://block.example",
    jitoTipLamports: TIP,
    jupiter: fakeJupiter(tx),
    sleep: async () => undefined,
    now: () => 99,
    random: () => 0,
  });
}

describe("JupiterExecutor via Jito", () => {
  const cfg = testConfig({ walletPubkey: "" });
  beforeAll(() => {
    cfg.walletPubkey = wallet;
  });

  it("appends the tip transfer last inside the swap tx, keeps the lookup table, signs, bundles, polls and reconciles", async () => {
    const jito = stubJito((poll) =>
      poll === 1
        ? { context: { slot: 1 }, value: [] }
        : { context: { slot: 2 }, value: [{ bundle_id: "bundle-1", transactions: [], slot: 600, confirmation_status: "confirmed", err: { Ok: null } }] },
    );
    const sent: Uint8Array[] = [];
    const rpc = fakeRpc({ getTransaction: (sig) => buyResponse(sig, 600) }, sent);
    const fill = await executor(rpc, swapTx()).execute(testOrder("buy", 200_000_000n), cfg, testSnapshot());

    // Sent as a bundle, never through the RPC.
    expect(sent).toHaveLength(0);
    expect(jito.methods.slice(0, 2)).toEqual(["getTipAccounts", "sendBundle"]);
    expect(jito.methods.filter((m) => m === "getBundleStatuses")).toHaveLength(2);
    expect(jito.bundles).toHaveLength(1);
    const [bundle] = jito.bundles;
    expect(bundle).toHaveLength(1);
    const tx = VersionedTransaction.deserialize(Buffer.from((bundle as string[])[0] as string, "base64"));

    // Signed by the wallet, over the rebuilt message.
    const sig = tx.signatures[0] as Uint8Array;
    expect(verifyMessage(wallet, tx.message.serialize(), sig)).toBe(true);
    expect(fill.txSig).toBe(bs58.encode(sig));

    // The tip is the last instruction, from the wallet to the tip account picked from the list (random 0 -> TIPS[0]).
    expect(tx.message.version).toBe(0);
    expect(tx.message.addressTableLookups).toHaveLength(1);
    const decompiled = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: [alt] });
    expect(decompiled.instructions).toHaveLength(3);
    const last = decompiled.instructions[2] as TransactionInstruction;
    expect(last.programId.equals(SystemProgram.programId)).toBe(true);
    const transfer = SystemInstruction.decodeTransfer(last);
    expect(transfer.fromPubkey.toBase58()).toBe(wallet);
    expect(transfer.toPubkey.toBase58()).toBe(TIPS[0]);
    expect(transfer.lamports).toBe(TIP);
    // The original swap instruction is intact and still reaches the pool accounts through the table.
    expect((decompiled.instructions[1] as TransactionInstruction).programId.equals(fakeDex)).toBe(true);
    expect((decompiled.instructions[1] as TransactionInstruction).keys[1]?.pubkey.equals(poolA)).toBe(true);

    // Fill reconciled from the chain: amounts, fee + tip, slot; no note.
    expect(fill.inAmount).toBe(200_000_000n);
    expect(fill.outAmount).toBe(123_000_000n);
    expect(fill.feeLamports).toBe(6_000n + TIP);
    expect(fill.slot).toBe(600);
    expect(fill.note).toBeUndefined();
    expect(fill.paper).toBe(false);
  });

  it("falls back to signature confirmation when the bundle status stays silent, and to quote amounts when the tx cannot be read", async () => {
    const jito = stubJito(() => ({ context: { slot: 1 }, value: [] }));
    const sent: Uint8Array[] = [];
    const fill = await executor(fakeRpc({ confirmSlot: 701 }, sent), swapTx()).execute(testOrder("sell", 1_000_000_000n), cfg, testSnapshot());
    expect(sent).toHaveLength(0);
    expect(jito.methods.filter((m) => m === "getBundleStatuses")).toHaveLength(30);
    expect(fill.slot).toBe(701);
    expect(fill.inAmount).toBe(1_000_000_000n);
    expect(fill.outAmount).toBe(123_000_000n);
    // base fee + Jupiter's priority fee + the tip that was paid in the bundle
    expect(fill.feeLamports).toBe(5_000n + 1_000n + TIP);
    expect(fill.note).toBe("amounts from quote");
  });

  it("sends untipped through the RPC when the tip would push the swap over the packet size", async () => {
    // Grow the swap until it sits just under the limit so two more keys (System program + tip account) overflow it.
    let extra = 20;
    let tx = swapTx(extra);
    while (tx.serialize().length + 64 <= PACKET_DATA_SIZE) tx = swapTx(++extra);
    expect(tx.serialize().length).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    const jito = stubJito(() => ({ context: { slot: 1 }, value: [] }));
    const sent: Uint8Array[] = [];
    const fill = await executor(fakeRpc({ confirmSlot: 702 }, sent), tx).execute(testOrder("buy", 200_000_000n), cfg, testSnapshot());
    expect(jito.methods).toEqual(["getTipAccounts"]);
    expect(sent).toHaveLength(1);
    const raw = sent[0] as Uint8Array;
    expect(raw.length).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    const decompiled = TransactionMessage.decompile(VersionedTransaction.deserialize(raw).message, { addressLookupTableAccounts: [alt] });
    expect(decompiled.instructions.some((ix) => ix.programId.equals(SystemProgram.programId))).toBe(false);
    expect(fill.slot).toBe(702);
    expect(fill.feeLamports).toBe(5_000n + 1_000n); // no tip was paid
  });

  it("refuses a Jito configuration without a tip", () => {
    expect(
      () => new JupiterExecutor(fakeRpc({}), signer, { priorityFeeMicroLamports: 1, jitoUrl: "https://block.example", jitoTipLamports: 0n, jupiter: fakeJupiter(swapTx()) }),
    ).toThrow(ExecError);
  });
});
