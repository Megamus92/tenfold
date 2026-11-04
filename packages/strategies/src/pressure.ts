/**
 * Detectors: pure functions that read the market and the ledger state and say whether something worth telling
 * the founder is happening. They propose nothing; the engine turns their output into events.
 */
import { dailyCapAmount, dailyCapRemaining, defenseBudgetRemainingLamports, defenseCostPerHourSol, lamportsToSol, solToLamports } from "@tenfold/core";
import type { DefenseLevel, ProjectConfig, RollingState, Snapshot } from "@tenfold/core";
import { levelInPlay } from "./defense.js";

/** Sell flow must exceed buy flow by this factor over the window to count as pressure. */
export const PRESSURE_RATIO = 1.5;
/** Number of most-recent snapshots the pressure detector looks at. */
export const PRESSURE_WINDOW = 5;

export interface PressureReport {
  pressure: boolean;
  /** SOL per hour the defender would need to absorb the excess sells at the current pace. */
  costPerHourSol: number;
  /** Closest defended level under (or at) the current price, if any. */
  nearestLevel?: DefenseLevel;
  /** How far the price sits above that level, in percent. */
  pctAboveLevel?: number;
  /** Aggregate flows over the window, for the message. */
  sellFlowSol: number;
  buyFlowSol: number;
}

/** Sum sell and buy flow over the last PRESSURE_WINDOW snapshots and flag pressure when sells dominate 1.5:1. */
export function detectSellPressure(snapshots: Snapshot[], levels: DefenseLevel[]): PressureReport {
  const recent = snapshots.slice(-PRESSURE_WINDOW);
  let sell = 0;
  let buy = 0;
  for (const s of recent) {
    sell += s.sellFlow5mSol;
    buy += s.buyFlow5mSol;
  }
  const last = recent[recent.length - 1];
  const pressure = recent.length > 0 && sell > 0 && sell > buy * PRESSURE_RATIO;
  const costPerHourSol = last ? defenseCostPerHourSol(last) : 0;
  const report: PressureReport = { pressure, costPerHourSol, sellFlowSol: sell, buyFlowSol: buy };
  if (last && last.price > 0) {
    const under = levels.filter((l) => l.price <= last.price).sort((a, b) => b.price - a.price);
    const nearest = under[0] ?? levels.slice().sort((a, b) => Math.abs(a.price - last.price) - Math.abs(b.price - last.price))[0];
    if (nearest) {
      report.nearestLevel = nearest;
      report.pctAboveLevel = ((last.price - nearest.price) / nearest.price) * 100;
    }
  }
  return report;
}

/** Levels the current price is testing (at, under or within 0.5% above). */
export function detectLevelHit(snapshot: Snapshot, levels: DefenseLevel[]): DefenseLevel[] {
  if (!(snapshot.price > 0)) return [];
  return levels.filter((l) => levelInPlay(l, snapshot.price));
}

export interface BudgetReport {
  low: boolean;
  remainingSol: number;
  totalSol: number;
  remainingPct: number;
}

/** True when less than `thresholdPct` of the lifetime defense budget is left (only for projects with a budget). */
export function detectBudgetLow(cfg: ProjectConfig, rolling: RollingState, thresholdPct = 20): BudgetReport {
  const totalSol = cfg.rules.defenseBudgetSol;
  const remaining = defenseBudgetRemainingLamports(cfg, rolling);
  const remainingSol = lamportsToSol(remaining);
  const total = solToLamports(totalSol);
  const remainingPct = total > 0n ? (Number(remaining) / Number(total)) * 100 : 0;
  const low = cfg.strategy.defense.enabled && total > 0n && remainingPct < thresholdPct;
  return { low, remainingSol, totalSol, remainingPct };
}

export interface CapReport {
  reached: boolean;
  capBase: bigint;
  remaining: bigint;
  soldLast24h: bigint;
}

/** True when the rolling-24h sell cap is fully used (nothing may be sold until fills age out). */
export function detectCapReached(cfg: ProjectConfig, snapshot: Snapshot, rolling: RollingState): CapReport {
  const capBase = dailyCapAmount(cfg, snapshot, rolling);
  const remaining = dailyCapRemaining(cfg, snapshot, rolling);
  return { reached: capBase > 0n && remaining === 0n, capBase, remaining, soldLast24h: rolling.soldLast24h };
}
