/**
 * Mandate → strategy defaults. The founder answers three things (profile, horizon, alert floor) and the desk does
 * the rest. These numbers are the desk's starting point; the desk manager in the engine keeps adjusting levels,
 * budgets, pace and clip sizes from the market. The hard limits in `rules` are never touched here: they bound
 * everything the desk does.
 *
 * Calibration follows the practitioner literature summarised in research/mm-best-practices.md: level distances in
 * realized-volatility units (Avellaneda-Stoikov), a ladder of levels weighted to the deeper ones (Hummingbot
 * order levels), distribution as a participation rate of real pool volume (Virtu's 5/10/15-20% tiers), a cooldown
 * after a consumed level (filled_order_delay), a daily mark-to-market loss limit and an inventory stop on defense
 * (prop-desk practice), and clip sizes derived from pool depth (constant-product impact ≈ 2 × clip / reserve).
 */
import type { Mandate, MandateProfile, ProjectConfig, StrategyConfig } from "./types.js";

export interface ProfileParams {
  /** Number of trailing defense levels the desk keeps (a ladder). */
  levels: number;
  /** Distance of the first level under the anchor: max(sigmaMult x realized 1h vol, floorPct). */
  sigmaMult: number;
  floorPct: number;
  /** Ladder multipliers of the base distance for levels 1..n, and how the day's defense budget splits across them. */
  ladder: number[];
  split: number[];
  /** A level is lost (and re-placed lower) once price is this far under it, %. */
  maxDistanceBelowPct: number;
  /** Trail a level up once price has held this many base distances above it for `trailUpHours`. */
  trailUpSteps: number;
  trailUpHours: number;
  /** Wait this long after a level is consumed or lost before placing its replacement (minutes). */
  cooldownMin: number;
  /** Let a level breathe (step down) when holding it would exhaust the day's defense budget in under this many hours. */
  breatheUnderHours: number;
  /** Rest the defense this many hours after 2, 3, 4+ levels lost within 24h. */
  restHours: [number, number, number];
  /** Daily mark-to-market loss limit on defended inventory, % of vault value; breached = defense rests for a day. */
  lossLimitPct: number;
  /** Inventory stop: the defense rests for a day when what it bought in the last 24h is worth this fraction less than it cost. */
  inventoryStopPct: number;
  /** Default share of the vault to distribute and the default horizon (consistent with the default 0.5% daily cap). */
  distributePct: number;
  horizonDays: number;
  /** Distribution: participation rate of external pool volume (rolling hour) and the hard ceiling. */
  participation: number;
  participationCeiling: number;
  /** Strength boost for distribution (1 = flat clips). */
  strengthBoost: number;
  /** Rebalance target SOL share and band half-width. */
  targetSolShare: number;
  rebalanceBand: number;
  /** Clip size as a share of the pool's SOL reserve (≈ own impact of 2x that). */
  clipReservePct: number;
}

export const PROFILES: Record<MandateProfile, ProfileParams> = {
  protect: {
    levels: 3,
    sigmaMult: 1.5,
    floorPct: 3,
    ladder: [1, 2, 3.5],
    split: [0.35, 0.35, 0.3],
    maxDistanceBelowPct: 12,
    trailUpSteps: 2,
    trailUpHours: 2,
    cooldownMin: 5,
    breatheUnderHours: 2,
    restHours: [6, 12, 24],
    lossLimitPct: 3,
    inventoryStopPct: 0.1,
    distributePct: 20,
    horizonDays: 60,
    participation: 0.05,
    participationCeiling: 0.15,
    strengthBoost: 2,
    targetSolShare: 0.5,
    rebalanceBand: 0.15,
    clipReservePct: 0.25,
  },
  balanced: {
    levels: 3,
    sigmaMult: 2,
    floorPct: 5,
    ladder: [1, 2, 3.5],
    split: [0.25, 0.35, 0.4],
    maxDistanceBelowPct: 15,
    trailUpSteps: 2,
    trailUpHours: 3,
    cooldownMin: 15,
    breatheUnderHours: 4,
    restHours: [6, 12, 24],
    lossLimitPct: 2,
    inventoryStopPct: 0.15,
    distributePct: 30,
    horizonDays: 60,
    participation: 0.1,
    participationCeiling: 0.2,
    strengthBoost: 3,
    targetSolShare: 0.3,
    rebalanceBand: 0.15,
    clipReservePct: 0.5,
  },
  distribute: {
    levels: 3,
    sigmaMult: 3,
    floorPct: 8,
    ladder: [1, 2, 3.5],
    split: [0.2, 0.3, 0.5],
    maxDistanceBelowPct: 20,
    trailUpSteps: 3,
    trailUpHours: 6,
    cooldownMin: 30,
    breatheUnderHours: 6,
    restHours: [12, 24, 48],
    lossLimitPct: 1.5,
    inventoryStopPct: 0.2,
    distributePct: 50,
    horizonDays: 100,
    participation: 0.15,
    participationCeiling: 0.2,
    strengthBoost: 4,
    targetSolShare: 0.2,
    rebalanceBand: 0.15,
    clipReservePct: 0.75,
  },
};

/** The horizon and share actually in force: the founder's numbers, else the profile's. */
export function mandateTargets(m: Mandate): { horizonDays: number; distributePct: number } {
  const p = PROFILES[m.profile];
  return { horizonDays: m.horizonDays ?? p.horizonDays, distributePct: m.distributePct ?? p.distributePct };
}

/**
 * Daily distribution pace implied by the mandate, in % of the vault per day, before the desk's modulation and
 * always at or under the founder's daily sell cap. Zero when nothing is to be distributed.
 */
export function basePacePct(m: Mandate, dailySellCapPct: number): number {
  const { horizonDays, distributePct } = mandateTargets(m);
  if (distributePct <= 0 || horizonDays <= 0) return 0;
  return Math.min(dailySellCapPct, distributePct / horizonDays);
}

/** True when the founder's share and horizon need more than the daily cap allows. */
export function horizonExceedsCap(m: Mandate, dailySellCapPct: number): boolean {
  const { horizonDays, distributePct } = mandateTargets(m);
  return distributePct > 0 && distributePct / horizonDays > dailySellCapPct * 1.05;
}

/**
 * Strategy block for a project that just received a mandate. Defense is enabled with no levels: the desk places
 * the ladder once it has a market reference. The founder's hard limits (rules) and the distribution floor are
 * untouched; levels the founder pinned are kept by the caller.
 */
export function strategyFromMandate(m: Mandate, cfg: Pick<ProjectConfig, "rules" | "strategy">): StrategyConfig {
  const p = PROFILES[m.profile];
  const pace = basePacePct(m, cfg.rules.dailySellCapPct);
  return {
    ...cfg.strategy,
    defense: {
      enabled: cfg.rules.defenseBudgetSol > 0,
      levels: [],
      maxDistanceBelowPct: p.maxDistanceBelowPct,
    },
    distribution: {
      ...cfg.strategy.distribution,
      enabled: pace > 0,
      pctOfVaultPerDay: pace,
      mode: "strength",
      strengthBoost: p.strengthBoost,
    },
    rebalance: { enabled: true, targetSolShare: p.targetSolShare, band: p.rebalanceBand },
  };
}

/** One line a founder understands: what the mandate asks the desk to do. */
export function describeMandate(m: Mandate): string {
  const p = PROFILES[m.profile];
  const { horizonDays, distributePct } = mandateTargets(m);
  const head =
    m.profile === "protect"
      ? "protect the price first, distribute slowly"
      : m.profile === "distribute"
        ? "distribute supply first, defend lightly"
        : "hold reasonable levels and distribute steadily";
  const dist = distributePct > 0 ? `, ${distributePct}% of the vault over ${horizonDays} days` : ", sell nothing";
  const floor = m.alertFloor !== undefined ? `, tell you under ${m.alertFloor}` : "";
  const sol = `, keep about ${Math.round(p.targetSolShare * 100)}% of the vault in SOL`;
  const mode = m.autonomy === "ask" ? " (asks before each change)" : " (decides and informs)";
  return `${head}${dist}${floor}${sol}${mode}`;
}
