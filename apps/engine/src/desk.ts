/**
 * Desk manager: the part of Tenfold that decides so the founder does not have to.
 *
 * Given the founder's mandate (profile, horizon, alert floor) and the market, it keeps the strategy in shape:
 * trailing defense levels placed under the price and re-placed lower when lost or too expensive to hold,
 * distribution pace tracking the horizon and the real flow, a hard stop when the pool's liquidity vanishes.
 * Every change comes with one plain sentence of why, written to the ledger as a `desk_decision` so the agent
 * can relay it in one line. Only the irreversible or unbounded is escalated to the founder: a defense budget
 * that ran out, a horizon the cap cannot reach, a liquidity pull, a team wallet selling.
 *
 * Pure: no I/O, no clock, no randomness. The runner feeds it and applies what it returns. The founder's hard
 * limits in `rules` are never touched here; the risk engine still checks every order the new strategy produces.
 */
import { PROFILES, basePacePct, defenseBudgetRemainingLamports, defenseCostPerHourSol, defenseDayRemainingLamports, lamportsToSol, mandateTargets } from "@tenfold/core";
import type { DefenseLevel, Mandate, Order, ProjectConfig, RollingState, Snapshot, StrategyConfig } from "@tenfold/core";
import { FEE_RESERVE_LAMPORTS, levelInPlay, levelLost, levelSpentLamports, isLevelOrder } from "@tenfold/strategies";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The desk re-evaluates at least this often; detectors can force an earlier run. */
export const DESK_INTERVAL_MS = 15 * MINUTE;
/** Smallest budget worth placing a level with, SOL. Under this the desk rests the defense instead. */
export const MIN_LEVEL_BUDGET_SOL = 0.5;
/** Two levels closer than this (fraction) are the same level; the desk does not stack them. */
export const SAME_LEVEL_TOLERANCE = 0.01;
/** Pace changes under this relative size are noise and not applied. */
export const PACE_CHANGE_MIN_REL = 0.15;
/** Sell flow over the hour must exceed buy flow by this factor for the desk to halve the pace. */
export const HOUR_PRESSURE_RATIO = 1.5;
/** Buy flow over the hour must exceed sell flow by this factor for the desk to lift the pace. */
export const HOUR_STRENGTH_RATIO = 1.5;
/** Liquidity now under this fraction of an hour ago is a pull: everything stops. */
export const LIQUIDITY_PULL_FRACTION = 0.5;
/** Lose this many levels within 24h and the desk stops re-placing them for REST_AFTER_LOSSES_MS: it does not buy into a trend. */
export const LOST_LEVELS_BEFORE_REST = 2;
export const REST_AFTER_LOSSES_MS = 6 * HOUR;
/** The pace is re-set at most this often, unless it drops to zero. */
export const PACE_CHANGE_MIN_INTERVAL_MS = HOUR;
/** Level distance adapts to the market: at least this many realized 1h sigmas under the anchor, capped. */
export const VOL_DISTANCE_SIGMAS = 1.5;
export const MAX_LEVEL_DISTANCE = 0.3;

export type DeskChange =
  | { kind: "place_level"; price: number; budgetSol: number }
  | { kind: "move_level"; from: number; to: number; budgetSol: number }
  | { kind: "remove_level"; price: number; cause: "lost" | "spent" | "breathe" | "no_budget" }
  | { kind: "set_pace"; from: number; to: number }
  | { kind: "set_boost"; from: number | undefined; to: number }
  | { kind: "distribution_done" }
  | { kind: "mandate_started"; startTokens: string }
  | { kind: "pause" };

export interface DeskDecision {
  change: DeskChange;
  /** One sentence for the founder. */
  why: string;
}

export type EscalationTopic = "budget_top_up" | "horizon_unreachable" | "liquidity_pull" | "insider_sell" | "under_alert_floor" | "target_reached" | "trend_down";

export interface DeskEscalation {
  topic: EscalationTopic;
  why: string;
  /** What the founder can answer, in their words; the agent turns these into the reply. */
  options: string[];
  /** Same topic is not raised again within this long. */
  throttleMs: number;
}

export interface DeskInput {
  cfg: ProjectConfig;
  snapshot: Snapshot;
  rolling: RollingState;
  now: number;
  /** Snapshots over the last `trailUpHours` (at least one hour), oldest first. The last hour is the reference window. */
  history: Snapshot[];
  /** Orders of the last 24h, newest first (for per-level spend and activity). */
  recentOrders: Order[];
  /** Token base units sold by DIST since the mandate started. */
  distributedSinceStart: bigint;
  /** True when a declared team wallet sold in the last 24h. */
  insiderSellRecent: boolean;
  /** Last time a level was placed or moved by the desk (ms), to avoid re-placing on every run. */
  lastLevelChangeAt?: number;
  /** Levels the desk declared lost in the last 24h, and when the last one was lost. */
  lostLevelsLast24h?: number;
  lastLostAt?: number;
  /** Last time the desk changed the pace (ms). */
  lastPaceChangeAt?: number;
}

export interface DeskOutput {
  strategy: StrategyConfig;
  mandate: Mandate;
  decisions: DeskDecision[];
  escalations: DeskEscalation[];
  /** Set when the desk wants the whole project paused (liquidity pull). */
  pause?: { why: string };
}

/** Median of a list of numbers; undefined for an empty list. */
export function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function fmtPrice(p: number): string {
  if (!Number.isFinite(p)) return "?";
  return p >= 1 ? p.toFixed(4) : p.toPrecision(4);
}
function fmtSol(x: number): string {
  return x.toFixed(x >= 10 ? 1 : 2);
}
function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
function sameLevel(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(a, b) * SAME_LEVEL_TOLERANCE;
}

/**
 * Realized one-hour volatility of a price series (fraction): std of log returns between consecutive points, scaled
 * to the whole window. Zero for fewer than three points or a flat series.
 */
export function realizedHourVol(series: { ts: number; price: number }[]): number {
  const pts = series.filter((s) => s.price > 0);
  if (pts.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < pts.length; i++) rets.push(Math.log(pts[i]!.price / pts[i - 1]!.price));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const span = pts[pts.length - 1]!.ts - pts[0]!.ts;
  if (!(span > 0)) return 0;
  const stepsPerHour = rets.length * (HOUR / span);
  return Math.sqrt(variance) * Math.sqrt(stepsPerHour);
}

/** Oldest snapshot of the window, for hour-ago comparisons. */
function hourAgo(history: Snapshot[], now: number): Snapshot | undefined {
  const old = history.filter((s) => s.ts <= now - 45 * MINUTE);
  return old[0] ?? history[0];
}

/**
 * The desk's decision for this run. Returns the strategy to apply (equal to the input when nothing changes),
 * the decisions with their reasons, and the escalations the founder has to hear about.
 */
export function decide(input: DeskInput): DeskOutput {
  const { cfg, snapshot, rolling, now, history, recentOrders } = input;
  const mandate = cfg.mandate;
  const strategy: StrategyConfig = JSON.parse(JSON.stringify(cfg.strategy)) as StrategyConfig;
  const out: DeskOutput = { strategy, mandate: mandate ? { ...mandate } : (undefined as unknown as Mandate), decisions: [], escalations: [] };
  if (!mandate) return out;
  if (!(snapshot.price > 0)) return out;
  const p = PROFILES[mandate.profile];
  const lastHour = history.filter((s) => s.ts >= now - HOUR);
  const prices = lastHour.map((s) => s.price).filter((x) => x > 0);
  prices.push(snapshot.price);
  const ref = median(prices) ?? snapshot.price;
  const low1h = Math.min(...prices);
  // Levels are placed under the lower of the 1h reference and the current price: after a drop the median lags,
  // and a level above the market would make the defense buy into the fall at once.
  const anchor = Math.min(ref, snapshot.price);
  // Distance under the anchor: the profile's, widened in a wild market so levels are not hit by noise alone.
  const vol = realizedHourVol([...lastHour.map((x) => ({ ts: x.ts, price: x.price })), { ts: now, price: snapshot.price }]);
  const dist = Math.min(MAX_LEVEL_DISTANCE, Math.max(p.levelDistancePct / 100, VOL_DISTANCE_SIGMAS * vol));
  const distPct = dist * 100;

  // ---- mandate start: record the base the horizon is measured against ----
  if (!out.mandate.startTokens && snapshot.vaultTokens > 0n) {
    out.mandate.startTokens = snapshot.vaultTokens.toString();
    out.decisions.push({ change: { kind: "mandate_started", startTokens: out.mandate.startTokens }, why: "First look at a funded vault: the horizon is measured from here." });
  }

  // ---- A. liquidity pull: stop everything, ask the founder ----
  const before = hourAgo(lastHour.length ? lastHour : history, now);
  if (!cfg.paused && snapshot.liquiditySol !== undefined && before?.liquiditySol !== undefined && before.liquiditySol > 0) {
    if (snapshot.liquiditySol < before.liquiditySol * LIQUIDITY_PULL_FRACTION) {
      const why = `Pool liquidity dropped from ${fmtSol(before.liquiditySol)} to ${fmtSol(snapshot.liquiditySol)} SOL within the hour. Everything is stopped: trading into a drained pool only loses.`;
      out.pause = { why };
      out.decisions.push({ change: { kind: "pause" }, why });
      out.escalations.push({ topic: "liquidity_pull", why, options: ["resume once liquidity is back", "stay paused", "withdraw"], throttleMs: 6 * HOUR });
      return out;
    }
  }

  // ---- B. defense: trailing levels under the reference price ----
  const defense = strategy.defense;
  if (defense.enabled && p.levels > 0 && cfg.rules.defenseBudgetSol > 0) {
    const maxBelow = defense.maxDistanceBelowPct ?? p.maxDistanceBelowPct;
    const lifeLeft = lamportsToSol(defenseBudgetRemainingLamports(cfg, rolling));
    const dayLeft = lamportsToSol(defenseDayRemainingLamports(cfg, rolling));
    const vaultSol = Math.max(0, lamportsToSol(snapshot.vaultLamports - FEE_RESERVE_LAMPORTS));
    const budgetable = Math.min(lifeLeft, vaultSol);
    const managed = defense.levels.filter((l) => !l.pinned);
    const keep: DefenseLevel[] = defense.levels.filter((l) => l.pinned);
    let stepDown = 0;
    let changedLevels = false;

    const lost = input.lostLevelsLast24h ?? 0;
    // Each further lost level doubles the rest: 2 lost = 6h, 3 lost = 12h, 4 lost = 24h, within the rolling day.
    const restMs = REST_AFTER_LOSSES_MS * 2 ** Math.max(0, lost - LOST_LEVELS_BEFORE_REST);
    const resting = lost >= LOST_LEVELS_BEFORE_REST && input.lastLostAt !== undefined && now - input.lastLostAt < restMs;
    let lostNow = false;
    for (const level of managed.slice().sort((a, b) => b.price - a.price)) {
      // The level's own remaining budget (what it was given less what it spent), independent of today's limit.
      const ownLeft = Math.max(0, level.budgetSol - lamportsToSol(levelSpentLamports(recentOrders, level)));
      if (levelLost(level, snapshot.price, maxBelow)) {
        const pct = ((level.price - snapshot.price) / level.price) * 100;
        const willRest = lost + 1 >= LOST_LEVELS_BEFORE_REST;
        out.decisions.push({
          change: { kind: "remove_level", price: level.price, cause: "lost" },
          why: `Level ${fmtPrice(level.price)} is lost: price is ${pct.toFixed(0)}% under it. Not chasing it down${willRest ? `; that is ${lost + 1} levels lost in 24h, so the defense rests ${REST_AFTER_LOSSES_MS / HOUR} h instead of buying into the trend` : "; re-placing lower"}.`,
        });
        changedLevels = true;
        lostNow = true;
        continue;
      }
      if (ownLeft < MIN_LEVEL_BUDGET_SOL * 0.2 && lifeLeft >= MIN_LEVEL_BUDGET_SOL && dayLeft >= MIN_LEVEL_BUDGET_SOL) {
        out.decisions.push({ change: { kind: "remove_level", price: level.price, cause: "spent" }, why: `Level ${fmtPrice(level.price)} has spent its ${fmtSol(level.budgetSol)} SOL. Re-placing with fresh budget.` });
        changedLevels = true;
        continue;
      }
      // Breathe: holding this level would burn today's budget too fast. Only while there is a day budget to speak of;
      // once it is spent the risk engine already blocks buys and the level simply waits for tomorrow.
      if (levelInPlay(level, snapshot.price) && dayLeft >= MIN_LEVEL_BUDGET_SOL) {
        const burn = defenseCostPerHourSol(snapshot);
        const hours = burn > 0 ? Math.min(dayLeft, ownLeft) / burn : Infinity;
        if (burn > 0 && hours < p.breatheUnderHours) {
          out.decisions.push({
            change: { kind: "remove_level", price: level.price, cause: "breathe" },
            why: `Holding ${fmtPrice(level.price)} costs about ${fmtSol(burn)} SOL/hour at this flow and the budget would last ${hours.toFixed(1)} h. Letting it breathe: stepping the level down.`,
          });
          stepDown = Math.max(stepDown, 1);
          changedLevels = true;
          continue;
        }
      }
      // Trail up: price has run well above and the level has not been needed for a while.
      const trailAt = level.price * (1 + p.trailUpSteps * dist);
      const quietSince = recentOrders.find((o) => o.side === "buy" && isLevelOrder(o, level) && o.createdAt > now - p.trailUpHours * HOUR);
      const heldAbove = history.length > 0 && history.every((s) => s.price > level.price * (1 + (p.trailUpSteps - 1) * dist)) && history[0]!.ts <= now - p.trailUpHours * HOUR;
      if (ref > trailAt && low1h > trailAt * (1 - dist / 2) && !quietSince && heldAbove) {
        const to = round(ref * (1 - dist), 10);
        if (!sameLevel(to, level.price) && to > level.price) {
          keep.push({ price: to, budgetSol: level.budgetSol });
          out.decisions.push({ change: { kind: "move_level", from: level.price, to, budgetSol: level.budgetSol }, why: `Price has held more than ${(p.trailUpSteps * distPct).toFixed(0)}% above ${fmtPrice(level.price)} for ${p.trailUpHours} h. Trailing the level up to ${fmtPrice(to)}.` });
          changedLevels = true;
          continue;
        }
      }
      keep.push(level);
    }

    const managedKept = keep.filter((l) => !l.pinned).length;
    const cooldownOk = input.lastLevelChangeAt === undefined || now - input.lastLevelChangeAt >= DESK_INTERVAL_MS || changedLevels;
    const restNow = resting || (lostNow && lost + 1 >= LOST_LEVELS_BEFORE_REST);
    if (restNow) {
      // Trend protection: no new level while resting. Escalate once so the founder knows the desk is deliberately out.
      out.escalations.push({
        topic: "trend_down",
        why: `${Math.max(lost + (lostNow ? 1 : 0), LOST_LEVELS_BEFORE_REST)} defense levels lost within 24h. The desk is resting the defense for ${Math.round((REST_AFTER_LOSSES_MS * 2 ** Math.max(0, lost + (lostNow ? 1 : 0) - LOST_LEVELS_BEFORE_REST)) / HOUR)} h rather than buying into a falling market; distribution follows its own rules.`,
        options: ["keep resting", "defend lower anyway (set a level yourself)", "switch to the distribute profile"],
        throttleMs: DAY,
      });
    } else if (budgetable < MIN_LEVEL_BUDGET_SOL) {
      if (managedKept > 0 || changedLevels) {
        for (const l of keep.filter((x) => !x.pinned)) out.decisions.push({ change: { kind: "remove_level", price: l.price, cause: "no_budget" }, why: "Defense budget is used up; no level can be funded." });
        for (let i = keep.length - 1; i >= 0; i--) if (!keep[i]!.pinned) keep.splice(i, 1);
        changedLevels = true;
      }
      out.escalations.push({
        topic: "budget_top_up",
        why: `The defense budget is used up (${fmtSol(lifeLeft)} SOL left of ${fmtSol(cfg.rules.defenseBudgetSol)}, ${fmtSol(vaultSol)} SOL in the wallet). Levels are resting; distribution continues.`,
        options: ["top up the defense budget", "send more SOL to the project wallet", "leave the defense resting"],
        throttleMs: DAY,
      });
    } else if (managedKept < p.levels && cooldownOk && dayLeft >= MIN_LEVEL_BUDGET_SOL) {
      let pool = budgetable;
      for (let k = managedKept; k < p.levels; k++) {
        const steps = k + 1 + stepDown;
        const price = round(anchor * (1 - dist * steps), 10);
        if (!(price > 0) || keep.some((l) => sameLevel(l.price, price))) continue;
        const budget = round(Math.min(pool * p.levelBudgetShare, Math.max(dayLeft, MIN_LEVEL_BUDGET_SOL)), 2);
        if (budget < MIN_LEVEL_BUDGET_SOL) break;
        pool -= budget;
        keep.push({ price, budgetSol: budget });
        out.decisions.push({
          change: { kind: "place_level", price, budgetSol: budget },
          why: `Placed a defense level at ${fmtPrice(price)} (${(distPct * steps).toFixed(0)}% under ${anchor === ref ? "the 1h reference" : "the current price"} ${fmtPrice(anchor)}${vol * VOL_DISTANCE_SIGMAS > p.levelDistancePct / 100 ? `, widened for a ${(vol * 100).toFixed(0)}%/h market` : ""}) with ${fmtSol(budget)} SOL.`,
        });
        changedLevels = true;
      }
    }
    if (changedLevels) defense.levels = keep.sort((a, b) => b.price - a.price);
  }

  // ---- C. distribution: pace from the horizon, modulated by the hour's flow ----
  const d = strategy.distribution;
  const base = basePacePct(mandate, cfg.rules.dailySellCapPct);
  const { horizonDays, distributePct } = mandateTargets(mandate);
  if (base > 0) {
    if (d.strengthBoost !== p.strengthBoost) {
      out.decisions.push({ change: { kind: "set_boost", from: d.strengthBoost, to: p.strengthBoost }, why: `Selling leans ${p.strengthBoost}x into strong real buying, as the ${mandate.profile} profile does.` });
      d.strengthBoost = p.strengthBoost;
      d.mode = "strength";
    }
    const startTokens = out.mandate.startTokens ? BigInt(out.mandate.startTokens) : 0n;
    const targetTokens = startTokens > 0n ? (startTokens * BigInt(Math.round(distributePct * 100))) / 10_000n : 0n;
    const elapsed = Math.min(1, Math.max(0, (now - mandate.startedAt) / (horizonDays * DAY)));
    const actual = targetTokens > 0n ? Number(input.distributedSinceStart) / Number(targetTokens) : 0;

    if (targetTokens > 0n && actual >= 1 && d.enabled) {
      d.enabled = false;
      out.decisions.push({ change: { kind: "distribution_done" }, why: `${distributePct}% of the vault has been distributed: the mandate's target is reached. Distribution is off until you set a new one.` });
      out.escalations.push({ topic: "target_reached", why: "Distribution target reached.", options: ["set a new mandate", "keep only defending", "withdraw"], throttleMs: 7 * DAY });
    } else {
      let factor = 1;
      const notes: string[] = [];
      if (targetTokens > 0n) {
        const catchUp = Math.min(2, Math.max(0.5, 1 + (elapsed - actual) * 2));
        if (catchUp > 1.1) notes.push(`behind the horizon (${(actual * 100).toFixed(0)}% done at ${(elapsed * 100).toFixed(0)}% of the time)`);
        if (catchUp < 0.9) notes.push(`ahead of the horizon (${(actual * 100).toFixed(0)}% done at ${(elapsed * 100).toFixed(0)}% of the time)`);
        factor *= catchUp;
      }
      let buy1h = 0;
      let sell1h = 0;
      for (const s of lastHour) {
        buy1h += s.buyFlow5mSol;
        sell1h += s.sellFlow5mSol;
      }
      if (sell1h > 0 && sell1h > buy1h * HOUR_PRESSURE_RATIO) {
        factor *= 0.5;
        notes.push("sellers dominate this hour, not adding supply to that");
      } else if (buy1h > 0 && buy1h > sell1h * HOUR_STRENGTH_RATIO) {
        factor *= 1.25;
        notes.push("buyers dominate this hour");
      }
      if (input.insiderSellRecent) {
        factor = 0;
        notes.push("a team wallet sold in the last 24h; not adding supply to that");
      }
      if (mandate.alertFloor !== undefined && snapshot.price < mandate.alertFloor) {
        factor *= 0.5;
        notes.push(`price is under your alert floor ${fmtPrice(mandate.alertFloor)}`);
        out.escalations.push({
          topic: "under_alert_floor",
          why: `Price ${fmtPrice(snapshot.price)} is under the ${fmtPrice(mandate.alertFloor)} you asked to be told about. Distribution is halved meanwhile.`,
          options: ["lower the alert floor", "pause distribution until it recovers", "keep going"],
          throttleMs: 6 * HOUR,
        });
      }
      const pace = round(Math.min(cfg.rules.dailySellCapPct, base * factor), 4);
      const current = d.enabled ? d.pctOfVaultPerDay : 0;
      const rel = Math.abs(pace - current) / Math.max(current, 0.01);
      const paceCooldownOk = input.lastPaceChangeAt === undefined || now - input.lastPaceChangeAt >= PACE_CHANGE_MIN_INTERVAL_MS || pace === 0;
      if (rel > PACE_CHANGE_MIN_REL && paceCooldownOk) {
        d.pctOfVaultPerDay = pace;
        d.enabled = pace > 0;
        const why = pace === 0 ? `Distribution paused: ${notes.join("; ")}.` : `Distribution pace ${current.toFixed(2)}% → ${pace.toFixed(2)}% of the vault per day${notes.length ? ": " + notes.join("; ") : ""}.`;
        out.decisions.push({ change: { kind: "set_pace", from: current, to: pace }, why });
      }
    }
    if (distributePct / horizonDays > cfg.rules.dailySellCapPct * 1.05) {
      const daysAtCap = Math.ceil(distributePct / cfg.rules.dailySellCapPct);
      out.escalations.push({
        topic: "horizon_unreachable",
        why: `At the ${cfg.rules.dailySellCapPct}% daily cap, ${distributePct}% of the vault takes about ${daysAtCap} days, not ${horizonDays}.`,
        options: ["raise the daily cap (takes 48 h)", "extend the horizon", "accept the slower pace"],
        throttleMs: DAY,
      });
    }
  }

  if (input.insiderSellRecent) {
    out.escalations.push({
      topic: "insider_sell",
      why: "A declared team wallet sold in the last 24h. Distribution is on hold so Tenfold does not add to that selling.",
      options: ["it was planned, resume distribution", "keep distribution on hold for 24h"],
      throttleMs: DAY,
    });
  }

  return out;
}

/** True when two strategies differ in anything the engine acts on. */
export function strategyChanged(a: StrategyConfig, b: StrategyConfig): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}
