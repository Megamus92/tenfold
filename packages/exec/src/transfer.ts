/**
 * Plain SOL transfers and memo-only transactions, signed by the Signer and sent through the RPC: fee sweeps to the
 * fee wallet, referral payouts, and the daily log-hash anchor (a memo carrying the hash of the day's ledger entries).
 *
 * Every send is confirmed before it is reported, and a lost confirmation is settled against the chain before any
 * resend, so a transfer is never paid twice because a websocket dropped.
 */
import {
  ComputeBudgetProgram,
  type Connection,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { logger } from "@tenfold/core";
import { confirmSignature, realSleep, STATUS_CHECK_GAP_MS, type Sleep } from "./confirm.js";
import { ExecError, RETRYABLE_SEND_PATTERN } from "./errors.js";
import { isTransientHttpError } from "./http.js";
import type { Signer } from "./signer.js";

/** The SPL Memo program (v2). */
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** Memo bytes beyond this are rejected by the program's compute budget in practice; the daily anchor is far smaller. */
export const MAX_MEMO_BYTES = 566;

/** How many send attempts (fresh blockhash each) before giving up on a transient failure. */
export const TRANSFER_SEND_ATTEMPTS = 3;

export interface TransferOptions {
  /** UTF-8 text attached as a Memo program instruction after the transfer. */
  memo?: string;
  /** Priority fee in micro-lamports per compute unit; omitted = no ComputeBudget instruction. */
  priorityFeeMicroLamports?: number;
  /** Sleep, injectable for tests. */
  sleep?: Sleep;
}

export interface TransferResult {
  txSig: string;
  slot: number;
}

/** A Memo program instruction carrying `text` as UTF-8, signed by `signer` so the memo is attributable on-chain. */
export function memoInstruction(signer: PublicKey, text: string): TransactionInstruction {
  const data = Buffer.from(text, "utf8");
  if (data.length === 0) throw new ExecError("memo text is empty", false);
  if (data.length > MAX_MEMO_BYTES) throw new ExecError(`memo is ${data.length} bytes, max ${MAX_MEMO_BYTES}`, false);
  return new TransactionInstruction({
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM_ID,
    data,
  });
}

/** Instruction list for a SOL transfer: optional compute-unit price, the SystemProgram.transfer, optional memo. */
export function buildTransferInstructions(
  fromPubkey: PublicKey,
  toPubkey: PublicKey,
  lamports: bigint,
  opts: Pick<TransferOptions, "memo" | "priorityFeeMicroLamports"> = {},
): TransactionInstruction[] {
  if (lamports <= 0n) throw new ExecError(`transfer of ${lamports} lamports: amount must be positive`, false);
  if (fromPubkey.equals(toPubkey)) throw new ExecError("transfer to self", false);
  const ixs: TransactionInstruction[] = [];
  if (opts.priorityFeeMicroLamports !== undefined && opts.priorityFeeMicroLamports > 0) {
    ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(Math.round(opts.priorityFeeMicroLamports)) }));
  }
  ixs.push(SystemProgram.transfer({ fromPubkey, toPubkey, lamports }));
  if (opts.memo !== undefined) ixs.push(memoInstruction(fromPubkey, opts.memo));
  return ixs;
}

/**
 * Transfer `lamports` from `fromPubkey` (a wallet held by the signer) to `toPubkey`, optionally with a memo, and
 * confirm it. Up to TRANSFER_SEND_ATTEMPTS sends with a fresh blockhash on transient failures; a lost confirmation
 * is settled against the chain first so a landed transfer is never resent. Throws ExecError.
 */
export async function transferSol(
  connection: Connection,
  signer: Signer,
  fromPubkey: string,
  toPubkey: string,
  lamports: bigint,
  opts: TransferOptions = {},
): Promise<TransferResult> {
  const from = parsePubkey(fromPubkey, "fromPubkey");
  const to = parsePubkey(toPubkey, "toPubkey");
  const ixs = buildTransferInstructions(from, to, lamports, opts);
  return sendInstructions(connection, signer, from, ixs, opts.sleep ?? realSleep, `transfer ${lamports} lamports to ${toPubkey}`);
}

/** Post a memo-only transaction from `fromPubkey` (used to anchor a daily log hash on-chain); returns the signature and slot. */
export async function postMemo(connection: Connection, signer: Signer, fromPubkey: string, text: string, opts: Pick<TransferOptions, "sleep"> = {}): Promise<TransferResult> {
  const from = parsePubkey(fromPubkey, "fromPubkey");
  return sendInstructions(connection, signer, from, [memoInstruction(from, text)], opts.sleep ?? realSleep, "memo");
}

function parsePubkey(s: string, field: string): PublicKey {
  try {
    return new PublicKey(s);
  } catch (e) {
    throw new ExecError(`${field}: not a public key (${s})`, false, e);
  }
}

/** Build a v0 transaction for `ixs` paid by `payer`, sign, send with retries and confirm. */
async function sendInstructions(
  connection: Connection,
  signer: Signer,
  payer: PublicKey,
  ixs: TransactionInstruction[],
  sleep: Sleep,
  what: string,
): Promise<TransferResult> {
  const wallet = payer.toBase58();
  if (!signer.has(wallet)) throw new ExecError(`no key for wallet ${wallet}`, false);
  let lastErr: ExecError | undefined;
  for (let attempt = 0; attempt < TRANSFER_SEND_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(STATUS_CHECK_GAP_MS);

    let blockhash: string;
    let lastValidBlockHeight: number;
    try {
      ({ blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed"));
    } catch (e) {
      lastErr = new ExecError(`getLatestBlockhash failed: ${(e as Error).message}`, true, e);
      continue;
    }
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    signer.sign(wallet, tx);
    const raw = tx.serialize();

    let sig: string;
    try {
      sig = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3, preflightCommitment: "confirmed" });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      const retryable = RETRYABLE_SEND_PATTERN.test(m) || isTransientHttpError(e);
      const detail = e instanceof SendTransactionError ? e.transactionError.message : m;
      lastErr = new ExecError(`${what}: send failed: ${detail}`, retryable, e);
      if (!retryable) throw lastErr;
      logger.warn("transfer send failed, retrying", { what, attempt, err: m });
      continue;
    }

    try {
      const slot = await confirmSignature(connection, sig, blockhash, lastValidBlockHeight, sleep);
      logger.info("transfer confirmed", { what, sig, slot });
      return { txSig: sig, slot };
    } catch (e) {
      if (!(e instanceof ExecError)) throw new ExecError(`${what}: confirmation failed: ${(e as Error).message}`, false, e, sig, true);
      // Not landed for sure (expired, never seen): safe to rebuild and resend. Failed on chain or unknown: stop here.
      if (e.retryable && !e.outcomeUnknown) {
        lastErr = e;
        logger.warn("transfer expired without landing, resending", { what, attempt, sig });
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new ExecError(`${what}: gave up after ${TRANSFER_SEND_ATTEMPTS} attempts`, true);
}
