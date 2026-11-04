/**
 * Risk engine: the last gate before any order reaches the executor.
 *
 * It is deliberately boring. Every rule is a number from the project's config, every rejection carries
 * a code and a sentence the agent can relay, and nothing here has an opinion about the market.
 * The on-chain vault program enforces the cap, the budget and the allowlist a second time once it is live.
 */
import type { Order, ProjectConfig, RiskVerdict, RollingState, Snapshot } from "./types.js";
import { LAMPORTS_PER_SOL } from "./types.js";

export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9));
}

export function lamportsToSol(l: bigint): number {
  return Number(l) / 1e9;
}

export function tokensToBase(tokens: number, decimals: number): bigint {
  return BigInt(Math.round(tokens * 10 ** decimals));
}

export function baseToTokens(base: bigint, decimals: number): number {
  return Number(base) / 10 ** decimals;
}

/**
 * Cap base = tokens the vault held before today's sells started: current balance + sold in the last 24h.
 * Sells still in flight are not added back: their tokens are still in the balance, so counting them would inflate the cap.
 */
export function dailyCapBase(snapshot: Snapshot, rolling: RollingState): bigint {
  return snapshot.vaultTokens + rolling.soldLast24h - (rolling.pendingSoldLast24h ?? 0n);
}

export function dailyCapAmount(cfg: ProjectConfig, snapshot: Snapshot, rolling: RollingState): bigint {
  const base = dailyCapBase(snapshot, rolling);
  // integer math on bps to avoid float drift: pct * 100 = bps
  const bps = BigInt(Math.round(cfg.rules.dailySellCapPct * 100));
  return (base * bps) / 10_000n;
}

export function dailyCapRemaining(cfg: ProjectConfig, snapshot: Snapshot, rolling: RollingState): bigint {
  const cap = dailyCapAmount(cfg, snapshot, rolling);
  const rem = cap - rolling.soldLast24h;
  return rem > 0n ? rem : 0n;
}

export function defenseBudgetRemainingLamports(cfg: ProjectConfig, rolling: RollingState): bigint {
  const total = solToLamports(cfg.rules.defenseBudgetSol);
  const rem = total - rolling.defenseSpentTotalLamports;
  return rem > 0n ? rem : 0n;
}

export function defenseDayRemainingLamports(cfg: ProjectConfig, rolling: RollingState): bigint {
  const day = solToLamports(cfg.rules.maxDefenseSpendPerDaySol);
  const rem = day - rolling.defenseSpentLast24hLamports;
  return rem > 0n ? rem : 0n;
}

export interface RiskContext {
  cfg: ProjectConfig;
  snapshot: Snapshot;
  rolling: RollingState;
  now?: number;
}

/**
 * Assess an order. Returns ok, or a rejection with a code and a sentence. For sells that only partly fit
 * under the cap, returns ok=false with `allowedAmountIn` so the caller can resize and retry.
 */
export function assess(order: Pick<Order, "side" | "reason" | "amountIn" | "maxSlippageBps" | "refPrice">, ctx: RiskContext): RiskVerdict {
  const { cfg, snapshot, rolling } = ctx;

  if (cfg.paused) {
    return { ok: false, code: "paused", reason: "The project is paused. Resume it first." };
  }

  if (order.amountIn <= 0n) {
    return { ok: false, code: "size", reason: "Order size is zero." };
  }

  if (order.maxSlippageBps > cfg.rules.maxSlippageBps) {
    return {
      ok: false,
      code: "slippage",
      reason: `Slippage ${order.maxSlippageBps} bps is above the project limit of ${cfg.rules.maxSlippageBps} bps.`,
    };
  }

  if (rolling.ordersLastHour >= cfg.rules.maxOrdersPerHour) {
    return {
      ok: false,
      code: "pace",
      reason: `Pace limit: ${rolling.ordersLastHour} orders in the last hour, limit is ${cfg.rules.maxOrdersPerHour}.`,
    };
  }

  if (rolling.price5mAgo && rolling.price5mAgo > 0) {
    const move = Math.abs(snapshot.price - rolling.price5mAgo) / rolling.price5mAgo;
    if (move * 100 >= cfg.rules.circuitBreakerMovePct) {
      return {
        ok: false,
        code: "circuit",
        reason: `Circuit breaker: price moved ${(move * 100).toFixed(1)}% in 5 minutes (limit ${cfg.rules.circuitBreakerMovePct}%).`,
      };
    }
  }

  if (order.side === "sell") {
    if (order.amountIn > snapshot.vaultTokens) {
      return { ok: false, code: "inventory", reason: "Not enough tokens in the vault for this sell." };
    }
    const minPrice = cfg.strategy.distribution.minPrice;
    if (minPrice && order.reason === "DIST" && snapshot.price < minPrice) {
      return {
        ok: false,
        code: "min_price",
        reason: `Price ${snapshot.price.toPrecision(4)} is below the distribution floor ${minPrice.toPrecision(4)}.`,
      };
    }
    const remaining = dailyCapRemaining(cfg, snapshot, rolling);
    if (order.amountIn > remaining) {
      return {
        ok: false,
        code: "cap",
        reason:
          remaining === 0n
            ? `Daily sell cap of ${cfg.rules.dailySellCapPct}% is used up for the next 24h.`
            : `Only ${remaining.toString()} base units remain under today's ${cfg.rules.dailySellCapPct}% cap.`,
        allowedAmountIn: remaining,
      };
    }
    return { ok: true };
  }

  // buy
  const lamports = order.amountIn;
  if (lamports > snapshot.vaultLamports) {
    return { ok: false, code: "inventory", reason: "Not enough SOL in the vault for this buy." };
  }
  if (order.reason === "DEF") {
    const budgetRem = defenseBudgetRemainingLamports(cfg, rolling);
    if (lamports > budgetRem) {
      return {
        ok: false,
        code: "budget",
        reason: `Defense budget left is ${lamportsToSol(budgetRem).toFixed(3)} SOL, this buy needs ${lamportsToSol(lamports).toFixed(3)} SOL.`,
        allowedAmountIn: budgetRem,
      };
    }
    const dayRem = defenseDayRemainingLamports(cfg, rolling);
    if (lamports > dayRem) {
      return {
        ok: false,
        code: "budget_day",
        reason: `Daily defense limit: ${lamportsToSol(dayRem).toFixed(3)} SOL left today out of ${cfg.rules.maxDefenseSpendPerDaySol} SOL.`,
        allowedAmountIn: dayRem,
      };
    }
  }
  return { ok: true };
}

/** Cost of holding a level at the current sell pressure, in SOL per hour. */
export function defenseCostPerHourSol(snapshot: Snapshot): number {
  // sell flow over 5 minutes, extrapolated; the defender absorbs the excess of sells over buys
  const excess = Math.max(0, snapshot.sellFlow5mSol - snapshot.buyFlow5mSol);
  return excess * 12;
}

export { LAMPORTS_PER_SOL };
