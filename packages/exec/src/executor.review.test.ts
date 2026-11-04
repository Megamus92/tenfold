/**
 * Review tests for the live execution path: a lost confirmation must not turn a landed fill into a "failed" order,
 * and RPC calls must have a deadline.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, TransactionExpiredBlockheightExceededError, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { Connection, SignatureStatus } from "@solana/web3.js";
import { ExecError, JupiterExecutor } from "./executor.js";
import { makeRpc } from "./index.js";
import type { JupiterClient, JupiterQuote, QuoteParams } from "./jupiter.js";
import { Signer, createWallet } from "./signer.js";
import { testConfig, testOrder, testSnapshot } from "./testutil.js";

let dir: string;
let wallet: string;
let signer: Signer;
const password = "review password";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tenfold-review-keys-"));
  wallet = createWallet(dir, password, "review");
  signer = new Signer(dir, password);
});
afterAll(() => {
  signer.dispose();
  rmSync(dir, { recursive: true, force: true });
});

/** A Jupiter double: a fixed quote and a real unsigned v0 transaction paid by the wallet. */
function fakeJupiter(): JupiterClient {
  const payer = new PublicKey(wallet);
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  return {
    async quote(p: QuoteParams): Promise<JupiterQuote> {
      return { inputMint: p.inputMint, outputMint: p.outputMint, inAmount: p.amount, outAmount: 123_000_000n, otherAmountThreshold: 120_000_000n, slippageBps: p.slippageBps, priceImpact: 0.001, hops: 1, raw: {} };
    },
    async swap() {
      return { swapTransaction: Buffer.from(tx.serialize()).toString("base64"), lastValidBlockHeight: 100, prioritizationFeeLamports: 1000 };
    },
  } as unknown as JupiterClient;
}

const SIG = "5igLostConfirmationXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

/** An RPC double whose confirmTransaction always reports expiry; getSignatureStatuses is scripted. */
function fakeRpc(statuses: () => Promise<(SignatureStatus | null)[]>): Connection {
  return {
    sendRawTransaction: async () => SIG,
    confirmTransaction: async () => {
      throw new TransactionExpiredBlockheightExceededError(SIG);
    },
    getSignatureStatuses: async () => ({ context: { slot: 7 }, value: await statuses() }),
  } as unknown as Connection;
}

function executor(rpc: Connection): JupiterExecutor {
  return new JupiterExecutor(rpc, signer, { priorityFeeMicroLamports: 50_000, jitoTipLamports: 0n, jupiter: fakeJupiter(), sleep: async () => undefined, now: () => 99 });
}

describe("review: JupiterExecutor after a lost confirmation", () => {
  const cfg = testConfig({ walletPubkey: "" });
  beforeAll(() => {
    cfg.walletPubkey = wallet;
  });

  it("returns the fill when the chain says the transaction landed", async () => {
    const ex = executor(fakeRpc(async () => [{ slot: 42, confirmations: 3, err: null, confirmationStatus: "confirmed" }]));
    const fill = await ex.execute(testOrder("sell", 1_000_000_000n), cfg, testSnapshot());
    expect(fill.txSig).toBe(SIG);
    expect(fill.slot).toBe(42);
    expect(fill.inAmount).toBe(1_000_000_000n);
    expect(fill.outAmount).toBe(123_000_000n);
    expect(fill.paper).toBe(false);
  });

  it("throws a non-retryable error when the transaction landed but failed", async () => {
    const ex = executor(fakeRpc(async () => [{ slot: 42, confirmations: 3, err: { InstructionError: [2, "Custom"] }, confirmationStatus: "confirmed" }]));
    const err = await ex.execute(testOrder("sell", 1_000_000_000n), cfg, testSnapshot()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecError);
    expect((err as ExecError).retryable).toBe(false);
    expect((err as ExecError).outcomeUnknown).toBe(false);
    expect((err as ExecError).txSig).toBe(SIG);
  });

  it("throws a known-not-landed error when the chain has never seen the signature", async () => {
    let calls = 0;
    const ex = executor(
      fakeRpc(async () => {
        calls++;
        return [null];
      }),
    );
    const err = await ex.execute(testOrder("sell", 1_000_000_000n), cfg, testSnapshot()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecError);
    expect((err as ExecError).outcomeUnknown).toBe(false);
    expect((err as ExecError).retryable).toBe(true);
    expect((err as ExecError).txSig).toBe(SIG);
    expect(calls).toBe(3);
  });

  it("flags the outcome as unknown when the chain cannot be asked", async () => {
    const ex = executor(
      fakeRpc(async () => {
        throw new Error("fetch failed");
      }),
    );
    const err = await ex.execute(testOrder("buy", 200_000_000n), cfg, testSnapshot()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecError);
    expect((err as ExecError).outcomeUnknown).toBe(true);
    expect((err as ExecError).txSig).toBe(SIG);
    expect((err as ExecError).message).toMatch(/outcome unknown/);
  });
});

describe("review: makeRpc", () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    // An endpoint that accepts the connection and never answers.
    server = createServer(() => undefined);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    url = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("gives every RPC call a deadline instead of hanging", async () => {
    const rpc = makeRpc(url, 300);
    const started = Date.now();
    await expect(rpc.getBalance(new PublicKey(wallet))).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
