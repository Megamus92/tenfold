/**
 * @tenfold/exec: feeds, executors and the signer.
 *
 * Import rule: apps/engine may import everything. apps/agent and apps/proof must NOT import `Signer`,
 * `createWallet` or `loadKeypair` (see signer.ts); they only ever see public keys.
 */
import { Connection } from "@solana/web3.js";

export * from "./signer.js";
export * from "./feed.js";
export * from "./executor.js";
export * from "./jupiter.js";
export * from "./jito.js";
export * from "./reconcile.js";
export * from "./transfer.js";
export * from "./holders.js";
export { confirmSignature, settleLostConfirmation, realSleep, type Sleep } from "./confirm.js";
export { HttpError, TimeoutError, isTransientHttpError, isTimeoutError, withTimeout, DEFAULT_HTTP_TIMEOUT_MS } from "./http.js";

/** Hard deadline for a single RPC call; a silent endpoint then fails the tick instead of stalling the runner. */
export const RPC_TIMEOUT_MS = 30_000;

/** A Connection at 'confirmed' commitment with a 60 s confirm timeout and a per-call deadline, the only RPC handle Tenfold uses. */
export function makeRpc(url: string, timeoutMs = RPC_TIMEOUT_MS): Connection {
  return new Connection(url, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000,
    fetchMiddleware: (info, init, next) => next(info, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  });
}
