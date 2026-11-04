/**
 * Shared helpers for the strategies: order bookkeeping over the last 24h, defense-level accounting,
 * inventory maths and proposal builders. Everything here is pure.
 */
import {
  WSOL_MINT,
  baseToTokens,
  defenseBudgetRemainingLamports,
  defenseDayRemainingLamports,
  lamportsToSol,
  solToLamports,
  tokensToBase,
} from "@tenfold/core";
import type { DefenseLevel, Order, OrderStatus, ProjectConfig, ReasonCode, RollingState, Snapshot } from "@tenfold/core";
import type { Proposal } from "./types.js";

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** Orders worth less than this (lamports of value) are dust and never proposed. */
export const MIN_ORDER_LAMPORTS = 1_000_000n; // 0.001 SOL
/** SOL kept back in the vault for transaction fees, never spent on a buy. */
export const FEE_RESERVE_LAMPORTS = 10_000_000n; // 0.01 SOL
/** A level counts as hit when the price is at, under, or within this fraction above it. */
export const LEVEL_ZONE = 0.005;
/** No strategy ever sells while the price is within this fraction above an active defense level. */
export const NO_SELL_ZONE = 0.01;

/** Order statuses that have consumed or will consume budget. */
const COMMITTED: readonly OrderStatus[] = ["filled", "approved", "sent"];

/** Smallest of the given bigints. */
export function minBig(first: bigint, ...rest: bigint[]): bigint {
  let m = first;
  for (const x of rest) if (x < m) m = x;
  return m;
}

/** x * f for a non-negative fraction f, rounded down, with 1e-6 resolution. */
export function scaleBig(x: bigint, f: number): bigint {
  const clamped = Math.max(0, f);
  return (x * BigInt(Math.round(clamped * 1_000_000))) / 1_000_000n;
}

/** Newest order matching `pred` (orders are newest first). */
export function newestOrder(orders: Order[], pred: (o: Order) => boolean): Order | undefined {
  return orders.find(pred);
}

/** Milliseconds since the newest order matching `pred`, Infinity when there is none. */
export function msSinceLast(orders: Order[], now: number, pred: (o: Order) => boolean): number {
  const o = newestOrder(orders, pred);
  return o ? Math.max(0, now - o.createdAt) : Number.POSITIVE_INFINITY;
}

/** The note every DEF order on a level carries, so spend can be attributed per level. */
export function levelTag(level: DefenseLevel): string {
  return `level:${level.price}`;
}

/** True when the order is a defense buy on this level (note `level:<price>`, optionally followed by text). */
export function isLevelOrder(o: Order, level: DefenseLevel): boolean {
  if (o.reason !== "DEF" || !o.note) return false;
  const tag = levelTag(level);
  return o.note === tag || o.note.startsWith(tag + " ");
}

/** Lamports committed to this level in the given orders (filled, approved or sent). */
export function levelSpentLamports(orders: Order[], level: DefenseLevel): bigint {
  let sum = 0n;
  for (const o of orders) {
    if (o.side === "buy" && COMMITTED.includes(o.status) && isLevelOrder(o, level)) sum += o.amountIn;
  }
  return sum;
}

/** SOL (lamports) the defense may still spend overall: lifetime budget, daily limit and vault balance minus the fee reserve. */
export function defenseGlobalRemainingLamports(cfg: ProjectConfig, rolling: RollingState, snapshot: Snapshot): bigint {
  const vault = snapshot.vaultLamports - FEE_RESERVE_LAMPORTS;
  const rem = minBig(defenseBudgetRemainingLamports(cfg, rolling), defenseDayRemainingLamports(cfg, rolling), vault);
  return rem > 0n ? rem : 0n;
}

/** Lamports this level may still spend: its own budget less what the last-24h orders committed, bounded by the global remainder. */
export function levelRemainingLamports(cfg: ProjectConfig, rolling: RollingState, snapshot: Snapshot, level: DefenseLevel, orders: Order[]): bigint {
  const own = solToLamports(level.budgetSol) - levelSpentLamports(orders, level);
  const rem = minBig(own, defenseGlobalRemainingLamports(cfg, rolling, snapshot));
  return rem > 0n ? rem : 0n;
}

/** True when any committed DEF order on this level appears in the given (last-24h) orders. */
export function levelDefendedRecently(orders: Order[], level: DefenseLevel): boolean {
  return orders.some((o) => o.side === "buy" && COMMITTED.includes(o.status) && isLevelOrder(o, level));
}

/**
 * Enabled defense levels that are live for selling purposes: those that still have budget to buy with, plus those
 * defended in the last 24h even if their budget is spent, so no strategy ever sells back what the defense just bought.
 */
export function activeLevels(cfg: ProjectConfig, rolling: RollingState, snapshot: Snapshot, orders: Order[]): DefenseLevel[] {
  if (!cfg.strategy.defense.enabled) return [];
  return cfg.strategy.defense.levels.filter(
    (l) => levelRemainingLamports(cfg, rolling, snapshot, l, orders) >= MIN_ORDER_LAMPORTS || levelDefendedRecently(orders, l),
  );
}

/** The active level that forbids selling at this price (price at, under or within NO_SELL_ZONE above it), if any. */
export function inNoSellZone(price: number, levels: DefenseLevel[]): DefenseLevel | undefined {
  return levels.find((l) => price <= l.price * (1 + NO_SELL_ZONE));
}

/** Vault value held in SOL, 0..1; undefined when the vault is empty or the price is unknown. */
export function solShare(snapshot: Snapshot, decimals: number): number | undefined {
  if (!(snapshot.price > 0)) return undefined;
  const sol = lamportsToSol(snapshot.vaultLamports);
  const tok = baseToTokens(snapshot.vaultTokens, decimals) * snapshot.price;
  const total = sol + tok;
  if (!(total > 0)) return undefined;
  return sol / total;
}

/** Token base units worth `sol` SOL at `price`. */
export function tokensForSol(sol: number, price: number, decimals: number): bigint {
  if (!(price > 0) || !(sol > 0)) return 0n;
  return tokensToBase(sol / price, decimals);
}

/** Lamports worth of `base` token units at `price`. */
export function lamportsForTokens(base: bigint, price: number, decimals: number): bigint {
  if (!(price > 0) || base <= 0n) return 0n;
  return solToLamports(baseToTokens(base, decimals) * price);
}

/** Start of the local calendar day containing `now`, unix ms. */
export function localDayStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A SOL -> token buy proposal at the project's slippage limit. */
export function buyProposal(cfg: ProjectConfig, snapshot: Snapshot, reason: ReasonCode, lamports: bigint, note: string): Proposal {
  return {
    projectId: cfg.id,
    side: "buy",
    reason,
    inputMint: WSOL_MINT,
    outputMint: cfg.mint,
    amountIn: lamports,
    maxSlippageBps: cfg.rules.maxSlippageBps,
    refPrice: snapshot.price,
    note,
  };
}

/** A token -> SOL sell proposal at the project's slippage limit. */
export function sellProposal(cfg: ProjectConfig, snapshot: Snapshot, reason: ReasonCode, tokens: bigint, note: string): Proposal {
  return {
    projectId: cfg.id,
    side: "sell",
    reason,
    inputMint: cfg.mint,
    outputMint: WSOL_MINT,
    amountIn: tokens,
    maxSlippageBps: cfg.rules.maxSlippageBps,
    refPrice: snapshot.price,
    note,
  };
}
