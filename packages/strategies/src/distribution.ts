/**
 * DIST: distribution. Sells a founder-chosen share of the vault's tokens per day, in jittered clips, never
 * above the daily cap and never into the project's own defense. Two schedules:
 *  - twap: even progress across the local day, each clip no larger than what the elapsed fraction allows;
 *  - strength: only when buy flow dominates (buys > 1.2 x sells) and the price is at or above its 15-minute
 *    mean, allowed to run up to a quarter-day ahead of the even schedule because strength is not evenly spread.
 */
import { clipSize, dailyCapBase, dailyCapRemaining, jitter } from "@tenfold/core";
import type { Order } from "@tenfold/core";
import type { Proposal, Strategy, StrategyInput } from "./types.js";
import {
  DAY,
  activeLevels,
  inNoSellZone,
  localDayStart,
  minBig,
  msSinceLast,
  scaleBig,
  sellProposal,
  tokensForSol,
} from "./util.js";

/** Base gap between two DIST orders, before jitter. */
export const DIST_MIN_GAP_MS = 45_000;
/** DIST never sells within this long of an own buy (DEF, REB or MANUAL), so a buy and a sell never form a round trip. */
export const DIST_OPPOSITE_SIDE_COOLDOWN_MS = 5 * 60_000;
/** Buy flow must exceed sell flow by this factor for a strength signal. */
export const STRENGTH_FLOW_RATIO = 1.2;
/** In strength mode, progress may run this fraction of the day (2.4 h) ahead of the even schedule, since strength comes in bursts. */
export const STRENGTH_SCHEDULE_LEAD = 0.1;
/** Flow dominance at which the strength intensity from flow saturates (buys this many times sells). */
export const STRENGTH_FLOW_SATURATION = 3;
/** Weight of the 5-minute up-move vs the flow ratio in the strength intensity (the green candle leads). */
export const STRENGTH_MOVE_WEIGHT = 0.6;
/** Smallest sell worth placing, in base units of the token: below this a clip is dust. */
export const MIN_SELL_BASE = 1n;
/** A clip must be worth at least this fraction of clip.minSol, unless it finishes the day's target. */
export const MIN_CLIP_FRACTION = 0.5;
/** ...or at least this fraction of the day's target, so a small target still spreads over at least ~20 clips. */
export const MIN_TARGET_FRACTION = 0.05;

const COMMITTED = new Set<Order["status"]>(["filled", "approved", "sent"]);

/** Today's distribution target in base units: pctOfVaultPerDay of the cap base (balance before today's sells). */
export function dailyDistributionTarget(input: Pick<StrategyInput, "cfg" | "snapshot" | "rolling">): bigint {
  const pct = input.cfg.strategy.distribution.pctOfVaultPerDay;
  const base = dailyCapBase(input.snapshot, input.rolling);
  return scaleBig(base, pct / 100);
}

/** Tokens (base units) committed to sells since the start of the local day, from the last-24h orders. */
export function soldToday(orders: Order[], now: number): bigint {
  const start = localDayStart(now);
  let sum = 0n;
  for (const o of orders) {
    if (o.side === "sell" && COMMITTED.has(o.status) && o.createdAt >= start) sum += o.amountIn;
  }
  return sum;
}

/** Fraction of the local day elapsed at `now`, 0..1. */
export function dayFraction(now: number): number {
  return Math.min(1, Math.max(0, (now - localDayStart(now)) / DAY));
}

/** Base units still allowed under today's schedule (target x progress fraction, less sold today). `lead` pulls the schedule forward. */
export function scheduleAllowance(target: bigint, sold: bigint, now: number, mode: "twap" | "strength", lead?: number): bigint {
  const effectiveLead = lead ?? (mode === "strength" ? STRENGTH_SCHEDULE_LEAD : 0);
  const frac = Math.min(1, dayFraction(now) + effectiveLead);
  const allowed = scaleBig(target, frac) - sold;
  return allowed > 0n ? allowed : 0n;
}

/**
 * How strong the current real up-move is, 0..1, from the 5-minute up-move and the buy/sell flow dominance.
 * Zero when there is no up-move, no buy dominance, or no 5-minute reference. This measures REAL buyer pressure;
 * it never makes the bot buy, only sell more of its own supply into buyers who are already there.
 */
export function strengthIntensity(input: Pick<StrategyInput, "cfg" | "snapshot" | "rolling">): number {
  const { snapshot, rolling, cfg } = input;
  const prev = rolling.price5mAgo;
  const moveUp = prev && prev > 0 ? Math.max(0, (snapshot.price - prev) / prev) : 0;
  const moveRef = cfg.rules.circuitBreakerMovePct / 100; // saturate just below the circuit breaker
  const moveComponent = moveRef > 0 ? Math.min(1, moveUp / moveRef) : 0;
  const ratio = snapshot.sellFlow5mSol > 0 ? snapshot.buyFlow5mSol / snapshot.sellFlow5mSol : snapshot.buyFlow5mSol > 0 ? STRENGTH_FLOW_SATURATION : 0;
  const flowComponent = Math.min(1, Math.max(0, (ratio - STRENGTH_FLOW_RATIO) / (STRENGTH_FLOW_SATURATION - STRENGTH_FLOW_RATIO)));
  const intensity = STRENGTH_MOVE_WEIGHT * moveComponent + (1 - STRENGTH_MOVE_WEIGHT) * flowComponent;
  return Math.min(1, Math.max(0, intensity));
}

/** Arithmetic mean of the recent prices, or undefined when there is no history. */
export function rollingMean(prices: number[] | undefined): number | undefined {
  if (!prices || prices.length === 0) return undefined;
  let s = 0;
  for (const p of prices) s += p;
  return s / prices.length;
}

/** True when buy flow dominates sell flow and the price is at or above its recent mean: a sell into strength. */
export function strengthSignal(input: Pick<StrategyInput, "snapshot" | "recentPrices">): boolean {
  const { snapshot, recentPrices } = input;
  if (!(snapshot.buyFlow5mSol > snapshot.sellFlow5mSol * STRENGTH_FLOW_RATIO)) return false;
  if (!(snapshot.buyFlow5mSol > 0)) return false;
  const mean = rollingMean(recentPrices);
  if (mean === undefined) return false;
  return snapshot.price >= mean;
}

/** DIST proposals for this tick: at most one sell, sized by clip, cap, schedule and inventory. */
export function proposeDistribution(input: StrategyInput): Proposal[] {
  const { cfg, snapshot, rolling, now, rng, lastOrders } = input;
  const dist = cfg.strategy.distribution;
  if (!dist.enabled || cfg.paused) return [];
  if (!(snapshot.price > 0) || snapshot.vaultTokens <= 0n) return [];
  if (dist.minPrice !== undefined && snapshot.price < dist.minPrice) return [];

  // Never sell right after we bought: that would be trading with ourselves.
  const sinceOwnBuy = msSinceLast(lastOrders, now, (o) => o.side === "buy" && COMMITTED.has(o.status));
  if (sinceOwnBuy < DIST_OPPOSITE_SIDE_COOLDOWN_MS) return [];

  // Never sell into our own defense: price at, under or within 1% above an active level.
  const guarded = inNoSellZone(snapshot.price, activeLevels(cfg, rolling, snapshot, lastOrders));
  if (guarded) return [];

  const gap = jitter(DIST_MIN_GAP_MS, cfg.strategy.clip.jitterPct, rng);
  if (msSinceLast(lastOrders, now, (o) => o.reason === "DIST") < gap) return [];

  if (dist.mode === "strength" && !strengthSignal(input)) return [];

  // Lean into real strength: the stronger the up-move, the bigger the clip and the further the schedule may run
  // ahead, so a green candle banks more treasury. Off by default (boost 1). The daily cap below is the hard ceiling.
  const boost = dist.mode === "strength" ? (dist.strengthBoost ?? 1) : 1;
  const intensity = boost > 1 ? strengthIntensity(input) : 0;
  const clipMultiplier = 1 + (boost - 1) * intensity;
  const lead = dist.mode === "strength" ? STRENGTH_SCHEDULE_LEAD + intensity * ((boost - 1) / 9) * (1 - STRENGTH_SCHEDULE_LEAD) : undefined;

  const target = dailyDistributionTarget(input);
  if (target <= 0n) return [];
  const capRemaining = dailyCapRemaining(cfg, snapshot, rolling);
  const sold = soldToday(lastOrders, now);
  const allowance = scheduleAllowance(target, sold, now, dist.mode, lead);
  if (capRemaining <= 0n || allowance <= 0n) return [];

  const clipSol = clipSize(cfg.strategy.clip.minSol, cfg.strategy.clip.maxSol, cfg.strategy.clip.jitterPct, rng) * clipMultiplier;
  const clipTokens = tokensForSol(clipSol, snapshot.price, cfg.decimals);
  const amount = minBig(clipTokens, capRemaining, allowance, snapshot.vaultTokens);
  if (amount < MIN_SELL_BASE) return [];
  // Below half a minimum clip (or 5% of the day's target, whichever is smaller) is dust: wait for the schedule to free
  // more, unless this order finishes the day's target, the cap or the inventory.
  const floorTokens = minBig(tokensForSol(cfg.strategy.clip.minSol * MIN_CLIP_FRACTION, snapshot.price, cfg.decimals), scaleBig(target, MIN_TARGET_FRACTION));
  const remainingTarget = target - sold;
  const finishes = amount >= capRemaining || amount >= remainingTarget || amount >= snapshot.vaultTokens;
  if (amount < floorTokens && !finishes) return [];

  const note =
    dist.mode === "strength"
      ? `strength buy5m=${snapshot.buyFlow5mSol.toFixed(3)} sell5m=${snapshot.sellFlow5mSol.toFixed(3)} mean15m=${(rollingMean(input.recentPrices) ?? 0).toPrecision(5)}${boost > 1 ? ` intensity=${intensity.toFixed(2)} x${clipMultiplier.toFixed(2)}` : ""}`
      : `twap day=${(dayFraction(now) * 100).toFixed(1)}%`;
  return [sellProposal(cfg, snapshot, "DIST", amount, note)];
}

export const distributionStrategy: Strategy = { name: "DIST", propose: proposeDistribution };
