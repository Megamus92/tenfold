/**
 * Error type shared by everything in @tenfold/exec that sends a transaction (executor, transfer, memo anchor).
 * Kept in its own module so the confirmation helpers and the executor can both import it without a cycle.
 */

/**
 * Thrown by executors and senders; `retryable` tells the engine whether re-quoting and resending makes sense.
 * `outcomeUnknown` is set when the transaction was sent (`txSig`) but neither its success nor its failure could be
 * established: the engine must then assume it may have moved the vault.
 */
export class ExecError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly cause?: unknown,
    readonly txSig?: string,
    readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = "ExecError";
  }
}

/** Message patterns of send failures that are worth a resend (expiry, rate limit, node lag); program errors are not. */
export const RETRYABLE_SEND_PATTERN =
  /Blockhash not found|block height exceeded|429|Too Many Requests|timed? ?out|ECONNRESET|fetch failed|Node is behind|unhealthy/i;
