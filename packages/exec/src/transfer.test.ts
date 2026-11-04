import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  TransactionExpiredBlockheightExceededError,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type SignatureStatus,
} from "@solana/web3.js";
import bs58 from "bs58";
import { ExecError } from "./errors.js";
import { Signer, createWallet, verifyMessage } from "./signer.js";
import { MAX_MEMO_BYTES, MEMO_PROGRAM_ID, buildTransferInstructions, memoInstruction, postMemo, transferSol } from "./transfer.js";

let dir: string;
let wallet: string;
let signer: Signer;
const password = "transfer test password";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tenfold-transfer-keys-"));
  wallet = createWallet(dir, password, "transfer");
  signer = new Signer(dir, password);
});
afterAll(() => {
  signer.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const dest = Keypair.generate().publicKey;

describe("instruction layout", () => {
  it("builds [transfer, memo] with the System transfer data bytes and the memo's UTF-8 bytes", () => {
    const from = new PublicKey(wallet);
    const ixs = buildTransferInstructions(from, dest, 1_500_000n, { memo: "tenfold fee sweep 2026-10-31" });
    expect(ixs).toHaveLength(2);
    const [transfer, memo] = ixs;
    expect(transfer?.programId.equals(SystemProgram.programId)).toBe(true);
    // u32 LE instruction index 2 (Transfer) + u64 LE lamports
    const data = Buffer.from(transfer?.data ?? []);
    expect(data.length).toBe(12);
    expect(data.readUInt32LE(0)).toBe(2);
    expect(data.readBigUInt64LE(4)).toBe(1_500_000n);
    expect(transfer?.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [wallet, true, true],
      [dest.toBase58(), false, true],
    ]);
    expect(memo?.programId.equals(MEMO_PROGRAM_ID)).toBe(true);
    expect(Buffer.from(memo?.data ?? []).toString("utf8")).toBe("tenfold fee sweep 2026-10-31");
    expect(memo?.keys).toEqual([{ pubkey: from, isSigner: true, isWritable: false }]);
  });

  it("prepends a compute-unit price when a priority fee is given, and rejects bad inputs", () => {
    const from = new PublicKey(wallet);
    const ixs = buildTransferInstructions(from, dest, 1n, { priorityFeeMicroLamports: 20_000 });
    expect(ixs).toHaveLength(2);
    expect(ixs[0]?.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(() => buildTransferInstructions(from, dest, 0n)).toThrow(ExecError);
    expect(() => buildTransferInstructions(from, from, 1n)).toThrow(ExecError);
    expect(() => memoInstruction(from, "")).toThrow(ExecError);
    expect(() => memoInstruction(from, "x".repeat(MAX_MEMO_BYTES + 1))).toThrow(ExecError);
    expect(memoInstruction(from, "é".repeat(10)).data.length).toBe(20);
  });
});

interface Script {
  /** What each sendRawTransaction call does: a signature string to return, or an error to throw. */
  sends: (Error | "ok")[];
  /** What each confirmTransaction call does. */
  confirms: ("ok" | "expire" | "fail")[];
  statuses?: (SignatureStatus | null)[][];
}

interface Recorded {
  raws: Uint8Array[];
  blockhashCalls: number;
  statusCalls: number;
}

function fakeRpc(script: Script): { rpc: Connection; rec: Recorded } {
  const rec: Recorded = { raws: [], blockhashCalls: 0, statusCalls: 0 };
  let sends = 0;
  let confirms = 0;
  const rpc = {
    getLatestBlockhash: async () => {
      rec.blockhashCalls++;
      return { blockhash: bs58.encode(Buffer.alloc(32, rec.blockhashCalls)), lastValidBlockHeight: 1000 + rec.blockhashCalls };
    },
    sendRawTransaction: async (raw: Uint8Array) => {
      const step = script.sends[sends++] ?? "ok";
      if (step instanceof Error) throw step;
      rec.raws.push(raw);
      return bs58.encode(VersionedTransaction.deserialize(raw).signatures[0] as Uint8Array);
    },
    confirmTransaction: async (cfg: { signature: string }) => {
      const step = script.confirms[confirms++] ?? "ok";
      if (step === "expire") throw new TransactionExpiredBlockheightExceededError(cfg.signature);
      if (step === "fail") return { context: { slot: 5 }, value: { err: { InstructionError: [0, "Custom"] } } };
      return { context: { slot: 4321 }, value: { err: null } };
    },
    getSignatureStatuses: async () => {
      const value = script.statuses?.[rec.statusCalls] ?? [null];
      rec.statusCalls++;
      return { context: { slot: 1 }, value };
    },
  };
  return { rpc: rpc as unknown as Connection, rec };
}

const noSleep = async () => undefined;

describe("transferSol", () => {
  it("signs a v0 tx with the transfer and memo, sends it once and returns the signature and slot", async () => {
    const { rpc, rec } = fakeRpc({ sends: ["ok"], confirms: ["ok"] });
    const res = await transferSol(rpc, signer, wallet, dest.toBase58(), 2_500_000n, { memo: "anchor:abc", sleep: noSleep });
    expect(rec.raws).toHaveLength(1);
    const tx = VersionedTransaction.deserialize(rec.raws[0] as Uint8Array);
    expect(res.txSig).toBe(bs58.encode(tx.signatures[0] as Uint8Array));
    expect(res.slot).toBe(4321);
    expect(verifyMessage(wallet, tx.message.serialize(), tx.signatures[0] as Uint8Array)).toBe(true);
    expect(tx.message.version).toBe(0);
    const ixs = TransactionMessage.decompile(tx.message).instructions;
    expect(ixs).toHaveLength(2);
    const transfer = SystemInstruction.decodeTransfer(ixs[0]!);
    expect(transfer.fromPubkey.toBase58()).toBe(wallet);
    expect(transfer.toPubkey.equals(dest)).toBe(true);
    expect(transfer.lamports).toBe(2_500_000n);
    expect(ixs[1]?.programId.equals(MEMO_PROGRAM_ID)).toBe(true);
    expect(Buffer.from(ixs[1]?.data ?? []).toString()).toBe("anchor:abc");
  });

  it("retries a transient send failure with a fresh blockhash, up to 3 attempts", async () => {
    const { rpc, rec } = fakeRpc({ sends: [new Error("429 Too Many Requests"), new Error("Blockhash not found"), "ok"], confirms: ["ok"] });
    const res = await transferSol(rpc, signer, wallet, dest.toBase58(), 1n, { sleep: noSleep });
    expect(res.slot).toBe(4321);
    expect(rec.blockhashCalls).toBe(3);
    expect(rec.raws).toHaveLength(1);

    const exhausted = fakeRpc({ sends: [new Error("fetch failed"), new Error("fetch failed"), new Error("fetch failed")], confirms: [] });
    const err = await transferSol(exhausted.rpc, signer, wallet, dest.toBase58(), 1n, { sleep: noSleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecError);
    expect((err as ExecError).retryable).toBe(true);
    expect(exhausted.rec.blockhashCalls).toBe(3);
  });

  it("does not retry a program rejection", async () => {
    const { rpc, rec } = fakeRpc({ sends: [new Error("Transaction simulation failed: insufficient funds for rent")], confirms: [] });
    const err = await transferSol(rpc, signer, wallet, dest.toBase58(), 1n, { sleep: noSleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecError);
    expect((err as ExecError).retryable).toBe(false);
    expect(rec.blockhashCalls).toBe(1);
  });

  it("settles a lost confirmation against the chain before resending: landed means done, never seen means resend", async () => {
    // First send expires but the chain says it landed: one send, slot from the status.
    const landed = fakeRpc({ sends: ["ok"], confirms: ["expire"], statuses: [[{ slot: 88, confirmations: 2, err: null, confirmationStatus: "confirmed" }]] });
    const res = await transferSol(landed.rpc, signer, wallet, dest.toBase58(), 1n, { sleep: noSleep });
    expect(res.slot).toBe(88);
    expect(landed.rec.raws).toHaveLength(1);

    // First send expires and the chain never saw it: resend with a new blockhash.
    const resent = fakeRpc({ sends: ["ok", "ok"], confirms: ["expire", "ok"], statuses: [[null], [null], [null]] });
    const res2 = await transferSol(resent.rpc, signer, wallet, dest.toBase58(), 1n, { sleep: noSleep });
    expect(res2.slot).toBe(4321);
    expect(resent.rec.raws).toHaveLength(2);
    expect(resent.rec.blockhashCalls).toBe(2);
    const [a, b] = resent.rec.raws.map((r) => VersionedTransaction.deserialize(r).message.recentBlockhash);
    expect(a).not.toBe(b);
  });

  it("stops without resending when the transaction failed on chain or the outcome is unknown", async () => {
    const failed = fakeRpc({ sends: ["ok"], confirms: ["fail"] });
    const err = await transferSol(failed.rpc, signer, wallet, dest.toBase58(), 1n, { sleep: noSleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecError);
    expect((err as ExecError).retryable).toBe(false);
    expect(failed.rec.raws).toHaveLength(1);

    const unknown = fakeRpc({ sends: ["ok"], confirms: ["expire"] });
    (unknown.rpc as unknown as { getSignatureStatuses: () => Promise<never> }).getSignatureStatuses = async () => {
      throw new Error("ECONNRESET");
    };
    const err2 = await transferSol(unknown.rpc, signer, wallet, dest.toBase58(), 1n, { sleep: noSleep }).catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(ExecError);
    expect((err2 as ExecError).outcomeUnknown).toBe(true);
    expect((err2 as ExecError).txSig).toBeDefined();
    expect(unknown.rec.raws).toHaveLength(1);
  });

  it("rejects a wallet the signer does not hold and a non-positive amount before touching the RPC", async () => {
    const { rpc, rec } = fakeRpc({ sends: [], confirms: [] });
    const stranger = Keypair.generate().publicKey.toBase58();
    await expect(transferSol(rpc, signer, stranger, dest.toBase58(), 1n)).rejects.toBeInstanceOf(ExecError);
    await expect(transferSol(rpc, signer, wallet, dest.toBase58(), 0n)).rejects.toBeInstanceOf(ExecError);
    await expect(transferSol(rpc, signer, wallet, "not-a-key", 1n)).rejects.toBeInstanceOf(ExecError);
    expect(rec.blockhashCalls).toBe(0);
  });
});

describe("postMemo", () => {
  it("sends a memo-only transaction signed by the wallet", async () => {
    const { rpc, rec } = fakeRpc({ sends: ["ok"], confirms: ["ok"] });
    const hash = "sha256:" + "ab".repeat(32);
    const res = await postMemo(rpc, signer, wallet, `tenfold-log 2026-10-31 ${hash}`, { sleep: noSleep });
    expect(res.slot).toBe(4321);
    const tx = VersionedTransaction.deserialize(rec.raws[0] as Uint8Array);
    const ixs = TransactionMessage.decompile(tx.message).instructions;
    expect(ixs).toHaveLength(1);
    expect(ixs[0]?.programId.equals(MEMO_PROGRAM_ID)).toBe(true);
    expect(Buffer.from(ixs[0]?.data ?? []).toString()).toBe(`tenfold-log 2026-10-31 ${hash}`);
    expect(ixs[0]?.keys[0]?.pubkey.toBase58()).toBe(wallet);
    expect(verifyMessage(wallet, tx.message.serialize(), tx.signatures[0] as Uint8Array)).toBe(true);
  });
});
