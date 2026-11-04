/**
 * Mandate → strategy defaults. The founder answers three things (profile, horizon, alert floor) and the desk does
 * the rest. These numbers are the desk's starting point; the desk manager in the engine keeps adjusting levels,
 * budgets and pace from the market. The hard limits in `rules` are never touched here: they bound everything.
 */
import type { Mandate, MandateProfile, ProjectConfig, StrategyConfig } from "./types.js";

/** Per-profile knobs. Distances are in % under the 1h reference price. */
export interface ProfileParams {
  /** How many trailing defense levels the desk keeps (0 = defense only if the founder sets levels himself). */
  levels: number;
  /** Distance of the first level under the reference price, %. The second level sits one more step down. */
  levelDistancePct: number;
  /** A level is considered lost (and re-placed lower) once price is this far under it, %. */
  maxDistanceBelowPct: number;
  /** Trail a level up once price has run this many distance-steps above it for a while. */
  trailUpSteps: number;
  /** Hours the price must hold above before the desk trails a level up. */
  trailUpHours: number;
  /** Default share of the vault to distribute over the horizon, %, and the default horizon in days. */
  distributePct: number;
  horizonDays: number;
  /** Strength boost for distribution (1 = flat clips). */
  strengthBoost: number;
  /** Rebalance target SOL share and band. */
  targetSolShare: number;
  rebalanceBand: number;
  /** Share of the remaining lifetime defense budget the desk may commit to one level. */
  levelBudgetShare: number;
  /** Let a level breathe (step down) when holding it would exhaust today's defense budget in under this many hours. */
  breatheUnderHours: number;
}

export const PROFILES: Record<MandateProfile, ProfileParams> = {
  protect: {
    levels: 2,
    levelDistancePct: 4,
    maxDistanceBelowPct: 12,
    trailUpSteps: 2,
    trailUpHours: 2,
    distributePct: 20,
    horizonDays: 60,
    strengthBoost: 2,
    targetSolShare: 0.5,
    rebalanceBand: 0.12,
    levelBudgetShare: 0.5,
    breatheUnderHours: 2,
  },
  balanced: {
    levels: 1,
    levelDistancePct: 7,
    maxDistanceBelowPct: 15,
    trailUpSteps: 2,
    trailUpHours: 3,
    distributePct: 50,
    horizonDays: 45,
    strengthBoost: 3,
    targetSolShare: 0.3,
    rebalanceBand: 0.1,
    levelBudgetShare: 0.6,
    breatheUnderHours: 3,
  },
  distribute: {
    levels: 1,
    levelDistancePct: 12,
    maxDistanceBelowPct: 20,
    trailUpSteps: 3,
    trailUpHours: 6,
    distributePct: 100,
    horizonDays: 30,
    strengthBoost: 4,
    targetSolShare: 0.2,
    rebalanceBand: 0.1,
    levelBudgetShare: 0.7,
    breatheUnderHours: 4,
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

/**
 * Strategy block for a project that just received a mandate. Defense is enabled with no levels: the desk places
 * the first level once it has a market reference. The founder's hard limits (rules) are untouched.
 */
export function strategyFromMandate(m: Mandate, cfg: Pick<ProjectConfig, "rules" | "strategy">): StrategyConfig {
  const p = PROFILES[m.profile];
  const pace = basePacePct(m, cfg.rules.dailySellCapPct);
  return {
    ...cfg.strategy,
    defense: {
      enabled: p.levels > 0 && cfg.rules.defenseBudgetSol > 0,
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
  const { horizonDays, distributePct } = mandateTargets(m);
  const head =
    m.profile === "protect"
      ? "protect the price first, distribute slowly"
      : m.profile === "distribute"
        ? "distribute supply first, defend lightly"
        : "hold reasonable levels and distribute steadily";
  const dist = distributePct > 0 ? `, ${distributePct}% of the vault over ${horizonDays} days` : "";
  const floor = m.alertFloor !== undefined ? `, tell you under ${m.alertFloor}` : "";
  const mode = m.autonomy === "ask" ? " (asks before each change)" : " (decides and informs)";
  return `${head}${dist}${floor}${mode}`;
}
