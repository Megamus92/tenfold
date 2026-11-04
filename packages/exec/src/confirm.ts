/**
 * Confirmation helpers shared by the executor and the transfer/memo senders: wait for a signature against its
 * blockhash expiry, and when that wait is lost, ask the chain what happened before calling the send a failure.
 */
import type { Connection } from "@solana/web3.js";
import { logger } from "@tenfold/core";
import { ExecError } from "./errors.js";

/** Upper bound on waiting for a confirmation. The blockhash expires long before this; it only bites when the RPC is silent. */
export const CONFIRM_TIMEOUT_MS = 180_000;
/** How many times, and how far apart, the chain is asked for a transaction whose confirmation was lost. */
export const STATUS_CHECK_ATTEMPTS = 3;
export const STATUS_CHECK_GAP_MS = 1_500;

export type Sleep = (ms: number) => Promise<void>;

/** Default sleep: a real timer. Tests inject a no-op. */
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The confirmation of `sig` was lost (blockhash expired, subscription dropped, RPC timeout). Returns the slot when the
 * transaction is on chain and succeeded; throws ExecError: not retryable when it failed on chain, retryable when the
 * chain says it never landed, and `outcomeUnknown` when the chain could not be asked.
 */
export async function settleLostConfirmation(rpc: Connection, sig: string, cause: unknown, sleep: Sleep = realSleep): Promise<number> {
  const why = cause instanceof Error ? cause.message : String(cause);
  let rpcError: unknown;
  let inconclusive = false;
  for (let attempt = 0; attempt < STATUS_CHECK_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(STATUS_CHECK_GAP_MS);
    try {
      const res = await rpc.getSignatureStatuses([sig], { searchTransactionHistory: true });
      const st = res.value[0];
      if (!st) continue;
      const landed = st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized" || (st.confirmations ?? 0) > 0;
      if (!landed) {
        inconclusive = true; // seen at 'processed' only: keep asking
        continue;
      }
      if (st.err) throw new ExecError(`tx ${sig} failed on-chain: ${JSON.stringify(st.err)}`, false, st.err, sig);
      logger.warn("confirmation lost but tx landed", { sig, slot: st.slot, why });
      return st.slot;
    } catch (e) {
      if (e instanceof ExecError) throw e;
      rpcError = e;
    }
  }
  if (rpcError !== undefined || inconclusive) {
    const detail = rpcError !== undefined ? `status check failed: ${rpcError instanceof Error ? rpcError.message : String(rpcError)}` : "seen but not confirmed";
    throw new ExecError(`tx ${sig} outcome unknown (${why}; ${detail})`, true, cause, sig, true);
  }
  throw new ExecError(`tx ${sig} expired before confirmation and is not on chain (${why})`, true, cause, sig);
}

/**
 * Wait for `sig` at 'confirmed' against its blockhash expiry (bounded by CONFIRM_TIMEOUT_MS), then fall back to
 * `settleLostConfirmation` when the wait is lost. Returns the slot; throws ExecError as documented there.
 */
export async function confirmSignature(
  rpc: Connection,
  sig: string,
  blockhash: string,
  lastValidBlockHeight: number,
  sleep: Sleep = realSleep,
): Promise<number> {
  try {
    const res = await rpc.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight, abortSignal: AbortSignal.timeout(CONFIRM_TIMEOUT_MS) },
      "confirmed",
    );
    if (res.value.err) {
      throw new ExecError(`tx ${sig} failed on-chain: ${JSON.stringify(res.value.err)}`, false, res.value.err, sig);
    }
    return res.context.slot;
  } catch (e) {
    if (e instanceof ExecError) throw e;
    // An expiry or a lost websocket notification does not mean the transaction did not land. Ask the chain before
    // giving up: a sell that did fill but was recorded as failed would escape the daily cap.
    return settleLostConfirmation(rpc, sig, e, sleep);
  }
}
