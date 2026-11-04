/**
 * DEF: level defense. When the price sits at or under a founder-set level (or within 0.5% above it),
 * buy real tokens with real SOL, in jittered clips, until that level's budget, the project's defense budget,
 * the daily defense limit or the vault's SOL runs out. Nothing here sells, nothing here emits events.
 */
import { clipSize, jitter, solToLamports } from "@tenfold/core";
import type { DefenseLevel } from "@tenfold/core";
import type { Proposal, Strategy, StrategyInput } from "./types.js";
import {
  LEVEL_ZONE,
  MIN_ORDER_LAMPORTS,
  buyProposal,
  isLevelOrder,
  levelRemainingLamports,
  levelTag,
  minBig,
  msSinceLast,
} from "./util.js";

/** Base gap between two DEF orders on the same level, before jitter. */
export const DEF_MIN_GAP_MS = 20_000;
/** DEF never buys within this long of an own sell, so a sell and a buy never form a round trip. */
export const DEF_OPPOSITE_SIDE_COOLDOWN_MS = 5 * 60_000;

/** Default: stop defending a level once price is more than this far under it; a lost level is not chased down. */
export const DEFAULT_MAX_DISTANCE_BELOW_PCT = 15;

/** True when the price is at, under or within LEVEL_ZONE above the level: the zone where the level is being tested. */
export function levelInPlay(level: DefenseLevel, price: number): boolean {
  return level.price >= price * (1 - LEVEL_ZONE);
}

/** True when price has fallen more than `maxDistanceBelowPct` under the level: the level is lost, defense stops. */
export function levelLost(level: DefenseLevel, price: number, maxDistanceBelowPct = DEFAULT_MAX_DISTANCE_BELOW_PCT): boolean {
  return price < level.price * (1 - maxDistanceBelowPct / 100);
}

/** DEF proposals for this tick: one buy per level in play that still has budget, nearest level first. */
export function proposeDefense(input: StrategyInput): Proposal[] {
  const { cfg, snapshot, rolling, now, rng, lastOrders } = input;
  if (!cfg.strategy.defense.enabled || cfg.paused) return [];
  if (!(snapshot.price > 0)) return [];

  // Never buy right after we sold: that would be trading with ourselves.
  const sinceOwnSell = msSinceLast(lastOrders, now, (o) => o.side === "sell" && (o.status === "filled" || o.status === "approved" || o.status === "sent"));
  if (sinceOwnSell < DEF_OPPOSITE_SIDE_COOLDOWN_MS) return [];

  const maxBelow = cfg.strategy.defense.maxDistanceBelowPct ?? DEFAULT_MAX_DISTANCE_BELOW_PCT;
  const levels = cfg.strategy.defense.levels
    .filter((l) => levelInPlay(l, snapshot.price) && !levelLost(l, snapshot.price, maxBelow))
    .sort((a, b) => Math.abs(a.price - snapshot.price) - Math.abs(b.price - snapshot.price));

  const out: Proposal[] = [];
  for (const level of levels) {
    // Above the level with nobody selling: there is nothing to defend yet.
    if (snapshot.sellFlow5mSol <= 0 && snapshot.price > level.price) continue;

    const gap = jitter(DEF_MIN_GAP_MS, cfg.strategy.clip.jitterPct, rng);
    if (msSinceLast(lastOrders, now, (o) => isLevelOrder(o, level)) < gap) continue;

    const remaining = levelRemainingLamports(cfg, rolling, snapshot, level, lastOrders);
    if (remaining < MIN_ORDER_LAMPORTS) continue;

    const clipSol = clipSize(cfg.strategy.clip.minSol, cfg.strategy.clip.maxSol, cfg.strategy.clip.jitterPct, rng);
    const lamports = minBig(solToLamports(clipSol), remaining);
    if (lamports < MIN_ORDER_LAMPORTS) continue;

    const where = snapshot.price <= level.price ? "under" : "at";
    out.push(buyProposal(cfg, snapshot, "DEF", lamports, `${levelTag(level)} ${where} sell5m=${snapshot.sellFlow5mSol.toFixed(3)}`));
  }
  return out;
}

export const defenseStrategy: Strategy = { name: "DEF", propose: proposeDefense };
