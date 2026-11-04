/**
 * On-chain fill reconciliation: after a swap confirms, read what actually moved from the transaction's meta
 * (SOL pre/post balances, token pre/post balances) instead of trusting the quote. The on-chain fill can differ
 * from the quote by up to maxSlippageBps, and the ledger must record what happened, not what was promised.
 */
import type { Connection, VersionedTransactionResponse } from "@solana/web3.js";
import type { Side } from "@tenfold/core";
import { logger } from "@tenfold/core";
import { STATUS_CHECK_GAP_MS, realSleep, type Sleep } from "./confirm.js";

/** Amounts read from the chain for one swap. */
export interface OnChainFill {
  inAmount: bigint;
  outAmount: bigint;
  /** Network fee charged (base + priority) plus the Jito tip when one was paid, lamports. */
  feeLamports: bigint;
  slot: number;
}

/** How many times getTransaction is asked before the fill falls back to the quote amounts. */
export const RECONCILE_ATTEMPTS = 3;

/** Note attached to a fill whose amounts could not be read from the chain. */
export const AMOUNTS_FROM_QUOTE_NOTE = "amounts from quote";

/**
 * Compute the real in/out amounts of a swap from a getTransaction response. SOL side: the wallet's lamport delta,
 * corrected for the fee, the tip and rent moved into or out of the wallet's own token accounts for the mint (an ATA
 * created by the swap is not part of the price). Token side: the sum over the wallet's token accounts for the mint,
 * matched by owner + mint so Token-2022 accounts count too. Returns undefined when the response has no usable meta.
 */
export function reconcileFill(
  resp: VersionedTransactionResponse,
  side: Side,
  wallet: string,
  mint: string,
  tipLamports: bigint,
): OnChainFill | undefined {
  const meta = resp.meta;
  if (!meta || meta.err) return undefined;
  const keys = resp.transaction.message.staticAccountKeys;
  let walletIdx = keys.findIndex((k) => k.toBase58() === wallet);
  if (walletIdx < 0) walletIdx = 0; // the fee payer is always first; the wallet pays for its own swaps
  const pre = meta.preBalances[walletIdx];
  const post = meta.postBalances[walletIdx];
  if (pre === undefined || post === undefined) return undefined;
  const fee = BigInt(meta.fee);
  const walletDelta = BigInt(post) - BigInt(pre);

  // Token accounts of the wallet for this mint, by account index, from both pre and post lists.
  const preTok = new Map<number, bigint>();
  const postTok = new Map<number, bigint>();
  const indices = new Set<number>();
  for (const b of meta.preTokenBalances ?? []) {
    if (b.owner === wallet && b.mint === mint) {
      preTok.set(b.accountIndex, BigInt(b.uiTokenAmount.amount));
      indices.add(b.accountIndex);
    }
  }
  for (const b of meta.postTokenBalances ?? []) {
    if (b.owner === wallet && b.mint === mint) {
      postTok.set(b.accountIndex, BigInt(b.uiTokenAmount.amount));
      indices.add(b.accountIndex);
    }
  }
  if (indices.size === 0) return undefined;
  let tokenDelta = 0n;
  let rentDelta = 0n;
  for (const i of indices) {
    tokenDelta += (postTok.get(i) ?? 0n) - (preTok.get(i) ?? 0n);
    const rp = meta.preBalances[i];
    const rq = meta.postBalances[i];
    if (rp !== undefined && rq !== undefined) rentDelta += BigInt(rq) - BigInt(rp);
  }
  // Lamports that left (buy) or reached (sell) the wallet because of the swap itself.
  const swapLamports = walletDelta + fee + tipLamports + rentDelta;
  const feeLamports = fee + tipLamports;
  if (side === "buy") {
    return { inAmount: -swapLamports, outAmount: tokenDelta, feeLamports, slot: resp.slot };
  }
  return { inAmount: -tokenDelta, outAmount: swapLamports, feeLamports, slot: resp.slot };
}

/**
 * Fetch the confirmed transaction (up to RECONCILE_ATTEMPTS tries, STATUS_CHECK_GAP_MS apart) and reconcile it.
 * Returns undefined when the transaction cannot be fetched or does not reconcile to positive amounts; the caller
 * then falls back to the quote and marks the fill.
 */
export async function fetchOnChainFill(
  rpc: Connection,
  sig: string,
  side: Side,
  wallet: string,
  mint: string,
  tipLamports: bigint,
  sleep: Sleep = realSleep,
): Promise<OnChainFill | undefined> {
  for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(STATUS_CHECK_GAP_MS);
    let resp: VersionedTransactionResponse | null;
    try {
      resp = await rpc.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    } catch (e) {
      logger.debug("getTransaction failed", { sig, attempt, err: (e as Error).message });
      continue;
    }
    if (!resp) continue; // not indexed yet
    const fill = reconcileFill(resp, side, wallet, mint, tipLamports);
    if (!fill) return undefined;
    if (fill.inAmount <= 0n || fill.outAmount <= 0n) {
      logger.warn("on-chain amounts did not reconcile, using quote", { sig, inAmount: fill.inAmount, outAmount: fill.outAmount });
      return undefined;
    }
    return fill;
  }
  return undefined;
}
