/**
 * Desk manager: the part of Tenfold that decides so the founder does not have to.
 *
 * Given the founder's mandate (profile, horizon, alert floor) and the market, it keeps the strategy in shape:
 *  - a ladder of trailing defense levels under the price, spaced in realized-volatility units, weighted to the
 *    deeper levels, re-placed lower after a cooldown when lost, let to breathe when holding them would burn the
 *    day's budget, rested after repeated losses, after a mark-to-market loss limit, or on a sharp 5-minute drop;
 *  - a distribution pace from the horizon, capped by a participation rate of the pool's REAL volume, modulated by
 *    the hour's flow, zeroed under the alert floor, after a team-wallet sell, or when Tenfold's own share of the
 *    pool's volume gets too high;
 *  - clip sizes derived from pool depth so one clip never moves the price more than the profile allows;
 *  - a hard stop when the pool's liquidity vanishes (confirmed on several samples, not one quote).
 *
 * Every change comes with one plain sentence of why, written to the ledger as a `desk_decision` so the agent can
 * relay it in one line. Only the irreversible or unbounded is escalated to the founder.
 *
 * Pure: no I/O, no clock, no randomness. The runner feeds it and applies what it returns. The founder's hard
 * limits in `rules` are never touched here; the risk engine still checks every order the new strategy produces.
 * Calibration and sources: research/mm-best-practices.md.
 */
import {
  PROFILES,
  basePacePct,
  defenseBudgetRemainingLamports,
  defenseDayRemainingLamports,
  horizonExceedsCap,
  lamportsToSol,
  mandateTargets,
} from "@tenfold/core";
import type { DefenseLevel, Mandate, Order, ProjectConfig, RollingState, Snapshot, StrategyConfig } from "@tenfold/core";
import { FEE_RESERVE_LAMPORTS, levelInPlay, levelLost, levelSpentLamports, isLevelOrder } from "@tenfold/strategies";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The desk re-evaluates at least this often; detectors can force an earlier run, never closer than DESK_FORCE_MIN_MS. */
export const DESK_INTERVAL_MS = 15 * MINUTE;
export const DESK_FORCE_MIN_MS = MINUTE;
/** Smallest budget worth placing a level with, SOL. Under this the desk rests the defense instead. */
export const MIN_LEVEL_BUDGET_SOL = 0.5;
/** Two levels closer than this (fraction) are the same level; the desk does not stack them. */
export const SAME_LEVEL_TOLERANCE = 0.01;
/** A trailing move must shift a level by at least this fraction of the base distance (refresh tolerance). */
export const TRAIL_TOLERANCE = 0.25;
/** Pace changes under this relative size are noise and not applied. */
export const PACE_CHANGE_MIN_REL = 0.15;
/** Sell flow over the hour must exceed buy flow by this factor for the desk to halve the pace. */
export const HOUR_PRESSURE_RATIO = 1.5;
/** Buy flow over the hour must exceed sell flow by this factor for the desk to lift the pace. */
export const HOUR_STRENGTH_RATIO = 1.5;
/** Sell/buy flow over the last 15 minutes above this, with price on a level, is adverse flow: breathe, do not hold. */
export const FAST_PRESSURE_RATIO = 2;
/** Liquidity now under this fraction of an hour ago is a pull: everything stops. Needs several samples on both ends. */
export const LIQUIDITY_PULL_FRACTION = 0.5;
export const LIQUIDITY_SAMPLES_MIN = 2;
/** Liquidity under this fraction of an hour ago pauses distribution only. */
export const LIQUIDITY_SOFT_FRACTION = 0.7;
/** Lose this many levels within 24h and the desk stops re-placing them: it does not buy into a trend. */
export const LOST_LEVELS_BEFORE_REST = 2;
/** The pace is re-set at most this often, unless it drops to zero. */
export const PACE_CHANGE_MIN_INTERVAL_MS = HOUR;
/** Level distance is capped at this fraction under the anchor. */
export const MAX_LEVEL_DISTANCE = 0.3;
/** Vol regime: 1h vol above this multiple of 24h vol widens levels and halves their budgets. */
export const VOL_SPIKE_RATIO = 2;
/** A 5-minute drop beyond this pauses distribution and rests new levels (tier-1 breaker); the risk engine's breaker is the hard tier. */
export const TIER1_DROP = 0.1;
/** Tenfold's own share of the pool's 24h volume: soft alert, then distribution stops. */
export const OWN_SHARE_ALERT = 0.2;
export const OWN_SHARE_STOP = 0.25;
/** In the last tenth of the horizon the catch-up factor is capped at 1 so a mandate never ends in a dump. */
export const HORIZON_TAIL = 0.1;
/** Clip sizing bounds (SOL). */
export const CLIP_MIN_SOL = 0.05;
export const CLIP_MAX_SOL = 10;

export type DeskChange =
  | { kind: "place_level"; price: number; budgetSol: number; levels?: { price: number; budgetSol: number }[] }
  | { kind: "move_level"; from: number; to: number; budgetSol: number; moves?: { from: number; to: number }[] }
  | { kind: "remove_level"; price: number; cause: "lost" | "spent" | "breathe" | "no_budget" | "rest" | "loss_limit" }
  | { kind: "set_pace"; from: number; to: number }
  | { kind: "set_boost"; from: number | undefined; to: number }
  | { kind: "set_clip"; from: number; to: number }
  | { kind: "distribution_done" }
  | { kind: "mandate_started"; startTokens: string }
  | { kind: "pause" };

export interface DeskDecision {
  change: DeskChange;
  /** One sentence for the founder. */
  why: string;
}

export type EscalationTopic =
  | "budget_top_up"
  | "horizon_unreachable"
  | "liquidity_pull"
  | "insider_sell"
  | "under_alert_floor"
  | "target_reached"
  | "trend_down"
  | "loss_limit"
  | "own_share"
  | "unfunded" // the project wallet holds neither tokens nor SOL: nothing can start
  | "no_sol"; // tokens are there but no SOL: distribution can run, defense cannot

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
  /** Snapshots over the last `trailUpHours` (at least one hour), oldest first, strictly before `now`. */
  history: Snapshot[];
  /** Snapshots over the last 24h, downsampled (one per few minutes), oldest first. Optional. */
  history24h?: Snapshot[];
  /** Orders of the last 24h, newest first (for per-level spend and activity). */
  recentOrders: Order[];
  /** Token base units sold by Tenfold (any reason) since the mandate started. */
  distributedSinceStart: bigint;
  /** Defense fills of the last 24h: SOL spent and tokens bought, for the mark-to-market loss limit. */
  defense24h?: { spentLamports: bigint; tokensBought: bigint };
  /** SOL volume of Tenfold's own fills over the last 24h (both sides). */
  ownVolume24hSol?: number;
  /** True when a declared team wallet sold in the last 24h. */
  insiderSellRecent: boolean;
  /** Last time a level was placed or moved by the desk (ms). */
  lastLevelChangeAt?: number;
  /** Last time the desk removed a level (lost, spent or breathe), for the replacement cooldown. */
  lastLevelRemovedAt?: number;
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

/**
 * Realized volatility of a price series over its own span, scaled to one hour (fraction): std of log returns
 * between consecutive points times sqrt(points per hour). Zero for fewer than three points or a flat series.
 */
export function realizedHourVol(series: { ts: number; price: number }[]): number {
  const pts = series.filter((s) => s.price > 0);
  if (pts.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < pts.length; i++) rets.push(Math.log(pts[i]!.price / pts[i - 1]!.price));
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - m) ** 2, 0) / Math.max(1, rets.length - 1);
  const span = pts[pts.length - 1]!.ts - pts[0]!.ts;
  if (!(span > 0)) return 0;
  const stepsPerHour = rets.length * (HOUR / span);
  return Math.sqrt(variance) * Math.sqrt(stepsPerHour);
}

function mean(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
/** Six significant digits, so tiny token prices keep their precision. */
function sig(x: number): number {
  return Number(x.toPrecision(6));
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
function restMsFor(p: (typeof PROFILES)["balanced"], lost: number): number {
  const idx = Math.min(p.restHours.length - 1, Math.max(0, lost - LOST_LEVELS_BEFORE_REST));
  return p.restHours[idx]! * HOUR;
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
  // A paused project is a decision to stand still: nothing to decide, nothing to say.
  if (cfg.paused) return out;

  const p = PROFILES[mandate.profile];
  const lastHour = history.filter((s) => s.ts >= now - HOUR && s.ts < now);
  const last15 = lastHour.filter((s) => s.ts >= now - 15 * MINUTE);
  const prices = lastHour.map((s) => s.price).filter((x) => x > 0);
  prices.push(snapshot.price);
  const ref = median(prices) ?? snapshot.price;
  const low1h = Math.min(...prices);
  // Levels are placed under the lower of the 1h reference and the current price: after a drop the median lags,
  // and a level above the market would make the defense buy into the fall at once.
  const anchor = Math.min(ref, snapshot.price);
  const anchorName = lastHour.length >= 3 && anchor === ref ? "the 1h reference" : "the current price";

  // Distance in realized-volatility units with the profile's floor; widened in a volatility spike.
  const vol1h = realizedHourVol([...lastHour.map((x) => ({ ts: x.ts, price: x.price })), { ts: now, price: snapshot.price }]);
  const vol24h = input.history24h && input.history24h.length >= 12 ? realizedHourVol(input.history24h.map((x) => ({ ts: x.ts, price: x.price }))) : undefined;
  const spike = vol24h !== undefined && vol24h > 0 && vol1h > VOL_SPIKE_RATIO * vol24h;
  const baseDist = Math.min(MAX_LEVEL_DISTANCE, Math.max(p.floorPct / 100, p.sigmaMult * vol1h) * (spike ? 1.5 : 1));
  const distPct = baseDist * 100;

  // Hour flows: the ratio is meaningful whatever the sampling; the rate (SOL/h) is the mean 5-minute excess x 12.
  const buy1h = mean(lastHour.map((s) => s.buyFlow5mSol)) ?? snapshot.buyFlow5mSol;
  const sell1h = mean(lastHour.map((s) => s.sellFlow5mSol)) ?? snapshot.sellFlow5mSol;
  const burnPerHour = Math.max(0, lastHour.length >= 3 ? sell1h - buy1h : snapshot.sellFlow5mSol - snapshot.buyFlow5mSol) * 12;
  const fastSell = mean(last15.map((s) => s.sellFlow5mSol)) ?? snapshot.sellFlow5mSol;
  const fastBuy = mean(last15.map((s) => s.buyFlow5mSol)) ?? snapshot.buyFlow5mSol;
  const fastPressure = last15.length >= 2 && fastSell > 0 && fastSell > fastBuy * FAST_PRESSURE_RATIO;
  const drop5m = rolling.price5mAgo && rolling.price5mAgo > 0 ? (rolling.price5mAgo - snapshot.price) / rolling.price5mAgo : 0;
  const tier1 = drop5m >= TIER1_DROP;

  const vaultSol = Math.max(0, lamportsToSol(snapshot.vaultLamports - FEE_RESERVE_LAMPORTS));
  const vaultTokens = Number(snapshot.vaultTokens) / 10 ** cfg.decimals;
  const vaultValueSol = vaultSol + vaultTokens * snapshot.price;

  // ---- mandate start: record the base the horizon is measured against ----
  if (!out.mandate.startTokens && snapshot.vaultTokens > 0n) {
    out.mandate.startTokens = snapshot.vaultTokens.toString();
    out.decisions.push({ change: { kind: "mandate_started", startTokens: out.mandate.startTokens }, why: "First look at a funded vault: the horizon is measured from here." });
  }

  // ---- 0. funding: an empty wallet has nothing to decide about; say so once a day and stop here ----
  if (snapshot.vaultTokens === 0n && vaultSol < MIN_LEVEL_BUDGET_SOL) {
    out.escalations.push({
      topic: "unfunded",
      why: `The project wallet ${cfg.walletPubkey} holds no tokens and no SOL yet. Send the tokens to distribute and the SOL to defend with, and the desk starts within a minute.`,
      options: ["fund the wallet", "stay in paper mode for now"],
      throttleMs: DAY,
    });
    return out;
  }

  // ---- A. liquidity: a confirmed pull stops everything; a softer drop pauses distribution ----
  const liqNowSamples = [...last15.filter((s) => s.ts >= now - 5 * MINUTE && s.liquiditySol !== undefined).map((s) => s.liquiditySol!), ...(snapshot.liquiditySol !== undefined ? [snapshot.liquiditySol] : [])];
  const liqOldSamples = lastHour.filter((s) => s.ts <= now - 45 * MINUTE && s.liquiditySol !== undefined).map((s) => s.liquiditySol!);
  const liqNow = median(liqNowSamples);
  const liqThen = median(liqOldSamples);
  const liqKnown = liqNow !== undefined && liqThen !== undefined && liqThen > 0 && liqNowSamples.length >= LIQUIDITY_SAMPLES_MIN && liqOldSamples.length >= LIQUIDITY_SAMPLES_MIN;
  if (liqKnown && liqNow! < liqThen! * LIQUIDITY_PULL_FRACTION) {
    const why = `Pool liquidity dropped from about ${fmtSol(liqThen!)} to ${fmtSol(liqNow!)} SOL within the hour, confirmed on several readings. Everything is stopped: trading into a drained pool only loses.`;
    out.pause = { why };
    out.decisions.push({ change: { kind: "pause" }, why });
    out.escalations.push({ topic: "liquidity_pull", why, options: ["resume once liquidity is back", "stay paused", "withdraw"], throttleMs: 6 * HOUR });
    return out;
  }
  const liqSoft = liqKnown && liqNow! < liqThen! * LIQUIDITY_SOFT_FRACTION;

  // ---- B. defense: a ladder of trailing levels under the anchor ----
  const defense = strategy.defense;
  const defenseWanted = p.levels > 0 && cfg.rules.defenseBudgetSol > 0;
  if (defenseWanted) {
    defense.enabled = true;
    const maxBelow = defense.maxDistanceBelowPct ?? p.maxDistanceBelowPct;
    const lifeLeft = lamportsToSol(defenseBudgetRemainingLamports(cfg, rolling));
    const dayLeft = lamportsToSol(defenseDayRemainingLamports(cfg, rolling));
    const budgetable = Math.min(lifeLeft, vaultSol);
    const managed = defense.levels.filter((l) => !l.pinned);
    const keep: DefenseLevel[] = defense.levels.filter((l) => l.pinned);
    let stepDown = 0;
    let changedLevels = false;
    let removedNow = false;

    // Mark-to-market loss limit on what the defense bought in the last 24h, as a share of vault value.
    const def24 = input.defense24h;
    const mtmLoss = def24 && def24.spentLamports > 0n ? lamportsToSol(def24.spentLamports) - (Number(def24.tokensBought) / 10 ** cfg.decimals) * snapshot.price : 0;
    const lossBreached = vaultValueSol > 0 && mtmLoss > (p.lossLimitPct / 100) * vaultValueSol;

    const lost = input.lostLevelsLast24h ?? 0;
    let lostNow = 0;
    const resting = lost >= LOST_LEVELS_BEFORE_REST && input.lastLostAt !== undefined && now - input.lastLostAt < restMsFor(p, lost);

    for (const level of managed.slice().sort((a, b) => b.price - a.price)) {
      const ownLeft = Math.max(0, level.budgetSol - lamportsToSol(levelSpentLamports(recentOrders, level)));
      if (levelLost(level, snapshot.price, maxBelow)) {
        const pct = ((level.price - snapshot.price) / level.price) * 100;
        lostNow++;
        const total = lost + lostNow;
        const willRest = total >= LOST_LEVELS_BEFORE_REST;
        out.decisions.push({
          change: { kind: "remove_level", price: level.price, cause: "lost" },
          why: `Level ${fmtPrice(level.price)} is lost: price is ${pct.toFixed(0)}% under it. Not chasing it down${willRest ? `; that is ${total} levels lost in 24h, so the defense rests ${Math.round(restMsFor(p, total) / HOUR)} h instead of buying into the trend` : `; re-placing lower after a ${p.cooldownMin} min cooldown`}.`,
        });
        changedLevels = true;
        removedNow = true;
        continue;
      }
      if (ownLeft < MIN_LEVEL_BUDGET_SOL * 0.2 && lifeLeft >= MIN_LEVEL_BUDGET_SOL && dayLeft >= MIN_LEVEL_BUDGET_SOL) {
        out.decisions.push({ change: { kind: "remove_level", price: level.price, cause: "spent" }, why: `Level ${fmtPrice(level.price)} has spent its ${fmtSol(level.budgetSol)} SOL. Re-placing with fresh budget after a ${p.cooldownMin} min cooldown.` });
        changedLevels = true;
        removedNow = true;
        continue;
      }
      // Breathe: holding this level would burn today's budget too fast, or the last 15 minutes are one-sided selling
      // (adverse flow: holding against it is paying informed sellers). Only while there is a day budget to speak of.
      if (levelInPlay(level, snapshot.price) && dayLeft >= MIN_LEVEL_BUDGET_SOL) {
        const hours = burnPerHour > 0 ? Math.min(dayLeft, ownLeft) / burnPerHour : Infinity;
        if ((burnPerHour > 0 && hours < p.breatheUnderHours) || fastPressure) {
          out.decisions.push({
            change: { kind: "remove_level", price: level.price, cause: "breathe" },
            why: fastPressure
              ? `Sellers are ${(fastSell / Math.max(fastBuy, 1e-9)).toFixed(1)}x buyers over the last 15 minutes with price on ${fmtPrice(level.price)}. Letting it breathe: stepping the level down rather than absorbing one-sided flow.`
              : `Holding ${fmtPrice(level.price)} costs about ${fmtSol(burnPerHour)} SOL/hour at this flow and the budget would last ${hours.toFixed(1)} h. Letting it breathe: stepping the level down.`,
          });
          stepDown = Math.max(stepDown, 1);
          changedLevels = true;
          removedNow = true;
          continue;
        }
      }
      keep.push(level);
    }

    const totalLost = lost + lostNow;
    const restNow = resting || (lostNow > 0 && totalLost >= LOST_LEVELS_BEFORE_REST) || lossBreached || tier1;
    if (restNow) {
      // Trend, loss or breaker protection: no managed level stays live while resting.
      for (const l of keep.filter((x) => !x.pinned)) {
        out.decisions.push({
          change: { kind: "remove_level", price: l.price, cause: lossBreached ? "loss_limit" : "rest" },
          why: lossBreached ? "Defense is resting: the daily loss limit on defended inventory is reached." : tier1 ? `Defense is resting: price fell ${(drop5m * 100).toFixed(0)}% in 5 minutes.` : "Defense is resting after repeated lost levels.",
        });
        changedLevels = true;
      }
      for (let i = keep.length - 1; i >= 0; i--) if (!keep[i]!.pinned) keep.splice(i, 1);
      if (lossBreached) {
        out.escalations.push({
          topic: "loss_limit",
          why: `Defense bought ${fmtSol(lamportsToSol(def24!.spentLamports))} SOL of tokens in the last 24h that are now worth ${fmtSol(lamportsToSol(def24!.spentLamports) - mtmLoss)} SOL: a ${fmtSol(mtmLoss)} SOL mark-to-market loss, over the ${p.lossLimitPct}% daily limit. The defense rests until tomorrow; distribution follows its own rules.`,
          options: ["keep resting", "switch to the distribute profile", "defend anyway (set a level yourself)"],
          throttleMs: DAY,
        });
      } else if (totalLost >= LOST_LEVELS_BEFORE_REST) {
        out.escalations.push({
          topic: "trend_down",
          why: `${totalLost} defense levels lost within 24h. The desk is resting the defense for ${Math.round(restMsFor(p, totalLost) / HOUR)} h rather than buying into a falling market; distribution follows its own rules.`,
          options: ["keep resting", "defend lower anyway (set a level yourself)", "switch to the distribute profile"],
          throttleMs: DAY,
        });
      }
    } else if (budgetable < MIN_LEVEL_BUDGET_SOL) {
      const noSol = vaultSol < MIN_LEVEL_BUDGET_SOL && lifeLeft >= MIN_LEVEL_BUDGET_SOL;
      if (keep.some((x) => !x.pinned)) {
        for (const l of keep.filter((x) => !x.pinned)) out.decisions.push({ change: { kind: "remove_level", price: l.price, cause: "no_budget" }, why: noSol ? "No SOL left in the project wallet; no level can be funded." : "Defense budget is used up; no level can be funded." });
        for (let i = keep.length - 1; i >= 0; i--) if (!keep[i]!.pinned) keep.splice(i, 1);
        changedLevels = true;
      }
      if (noSol) {
        out.escalations.push({
          topic: "no_sol",
          why: `The project wallet holds ${fmtSol(vaultSol)} SOL: the defense has nothing to buy with (${fmtSol(lifeLeft)} SOL of budget is unused). Distribution continues; send SOL to ${cfg.walletPubkey} to defend.`,
          options: ["send SOL to the project wallet", "run without defense"],
          throttleMs: DAY,
        });
      } else {
        out.escalations.push({
          topic: "budget_top_up",
          why: `The defense budget is used up (${fmtSol(lifeLeft)} SOL left of ${fmtSol(cfg.rules.defenseBudgetSol)}, ${fmtSol(vaultSol)} SOL in the wallet). Levels are resting; distribution continues.`,
          options: ["top up the defense budget", "send more SOL to the project wallet", "leave the defense resting"],
          throttleMs: 7 * DAY,
        });
      }
    } else {
      // Trail up: price has run well above the top level and the level has not been needed for a while.
      const managedKept = keep.filter((l) => !l.pinned).sort((a, b) => b.price - a.price);
      const top = managedKept[0];
      const trailWindow = history.filter((s) => s.ts >= now - p.trailUpHours * HOUR && s.ts < now);
      // At most one trail-up per trailUpHours: a ladder that follows every swing leaks intent and spams the founder.
      const trailThrottleOk = input.lastLevelChangeAt === undefined || now - input.lastLevelChangeAt >= p.trailUpHours * HOUR;
      if (top && trailThrottleOk) {
        const trailAt = top.price * (1 + p.trailUpSteps * baseDist);
        const quiet = !recentOrders.some((o) => o.side === "buy" && isLevelOrder(o, top) && o.createdAt > now - p.trailUpHours * HOUR);
        const heldAbove = trailWindow.length >= 3 && trailWindow[0]!.ts <= now - p.trailUpHours * HOUR * 0.9 && trailWindow.every((s) => s.price > top.price * (1 + (p.trailUpSteps - 1) * baseDist));
        if (ref > trailAt && low1h > trailAt * (1 - baseDist / 2) && quiet && heldAbove) {
          // Move the ladder up by rank so two levels never land on the same price; one line for the whole ladder.
          const moves: { from: number; to: number }[] = [];
          managedKept.forEach((level, rank) => {
            const to = sig(anchor * (1 - baseDist * p.ladder[rank]!));
            if (to > level.price && Math.abs(to - level.price) > baseDist * TRAIL_TOLERANCE * level.price && !keep.some((l) => l !== level && sameLevel(l.price, to))) {
              const idx = keep.indexOf(level);
              keep[idx] = { price: to, budgetSol: level.budgetSol, placedAt: now };
              moves.push({ from: level.price, to });
              changedLevels = true;
            }
          });
          if (moves.length > 0) {
            out.decisions.push({
              change: { kind: "move_level", from: moves[0]!.from, to: moves[0]!.to, budgetSol: top.budgetSol, moves },
              why: `Price has held more than ${(p.trailUpSteps * distPct).toFixed(0)}% above ${fmtPrice(top.price)} for ${p.trailUpHours} h. Trailing the ladder up: ${moves.map((m) => `${fmtPrice(m.from)} → ${fmtPrice(m.to)}`).join(", ")}.`,
            });
          }
        }
      }

      // Place the missing rungs of the ladder, after the cooldown that follows a consumed level.
      const cooldownOk = input.lastLevelRemovedAt === undefined || now - input.lastLevelRemovedAt >= p.cooldownMin * MINUTE;
      const refreshOk = input.lastLevelChangeAt === undefined || now - input.lastLevelChangeAt >= DESK_INTERVAL_MS || changedLevels;
      const live = keep.filter((l) => !l.pinned).length;
      if (live < p.levels && cooldownOk && refreshOk && !removedNow && dayLeft >= MIN_LEVEL_BUDGET_SOL) {
        // Budget for the ladder: what can be funded today, split by the profile's weights; a vol spike halves it.
        const ladderBudget = Math.min(budgetable, dayLeft) * (spike ? 0.5 : 1);
        const placed: { price: number; budgetSol: number; steps: number }[] = [];
        for (let rank = live; rank < p.levels; rank++) {
          const steps = p.ladder[rank]! + stepDown;
          const price = sig(anchor * (1 - baseDist * steps));
          if (!(price > 0) || keep.some((l) => sameLevel(l.price, price))) continue;
          const budget = round(ladderBudget * p.split[rank]!, 2);
          if (budget < MIN_LEVEL_BUDGET_SOL) continue;
          keep.push({ price, budgetSol: budget, placedAt: now });
          placed.push({ price, budgetSol: budget, steps });
          changedLevels = true;
        }
        if (placed.length > 0) {
          const first = placed[0]!;
          out.decisions.push({
            change: { kind: "place_level", price: first.price, budgetSol: round(placed.reduce((a, l) => a + l.budgetSol, 0), 2), levels: placed.map((l) => ({ price: l.price, budgetSol: l.budgetSol })) },
            why:
              `Placed ${placed.length === 1 ? "a defense level" : `${placed.length} defense levels`} at ${placed.map((l) => `${fmtPrice(l.price)} (${fmtSol(l.budgetSol)} SOL)`).join(", ")}: ` +
              `${(distPct * first.steps).toFixed(0)}% to ${(distPct * placed[placed.length - 1]!.steps).toFixed(0)}% under ${anchorName} ${fmtPrice(anchor)}` +
              `${vol1h * p.sigmaMult > p.floorPct / 100 ? `, sized for a ${(vol1h * 100).toFixed(0)}%/h market` : ""}${spike ? ", volatility spike: half budget" : ""}.`,
          });
        }
      }
    }
    if (changedLevels) defense.levels = keep.sort((a, b) => b.price - a.price);
  }

  // ---- C. clip size from pool depth: one clip never moves the price more than the profile allows ----
  if (snapshot.liquiditySol !== undefined && snapshot.liquiditySol > 0) {
    const target = round(Math.min(CLIP_MAX_SOL, Math.max(CLIP_MIN_SOL, snapshot.liquiditySol * (p.clipReservePct / 100))), 3);
    const current = strategy.clip.maxSol;
    if (Math.abs(target - current) / Math.max(current, 0.01) > 0.25) {
      strategy.clip.maxSol = target;
      if (strategy.clip.minSol > target) strategy.clip.minSol = round(Math.max(0.01, target / 2), 3);
      out.decisions.push({ change: { kind: "set_clip", from: current, to: target }, why: `Clip size ${fmtSol(current)} → ${fmtSol(target)} SOL: about ${p.clipReservePct}% of the pool's ${fmtSol(snapshot.liquiditySol)} SOL, so one clip moves the price under ${(p.clipReservePct * 2).toFixed(1)}%.` });
    }
  }

  // ---- D. distribution: pace from the horizon, capped by participation, modulated by the hour's flow ----
  const d = strategy.distribution;
  const base = basePacePct(mandate, cfg.rules.dailySellCapPct);
  const { horizonDays, distributePct } = mandateTargets(mandate);
  if (base > 0) {
    if (d.strengthBoost !== p.strengthBoost || d.mode !== "strength") {
      out.decisions.push({ change: { kind: "set_boost", from: d.strengthBoost, to: p.strengthBoost }, why: `Selling leans ${p.strengthBoost}x into strong real buying, as the ${mandate.profile} profile does.` });
      d.strengthBoost = p.strengthBoost;
      d.mode = "strength";
    }
    const startTokens = out.mandate.startTokens ? BigInt(out.mandate.startTokens) : 0n;
    const targetTokens = startTokens > 0n ? (startTokens * BigInt(Math.round(distributePct * 100))) / 10_000n : 0n;
    const elapsed = Math.min(1, Math.max(0, (now - mandate.startedAt) / (horizonDays * DAY)));
    const actual = targetTokens > 0n ? Number(input.distributedSinceStart) / Number(targetTokens) : 0;
    const done = targetTokens > 0n && actual >= 1;

    if (done) {
      if (d.enabled) {
        d.enabled = false;
        out.decisions.push({ change: { kind: "distribution_done" }, why: `${distributePct}% of the vault has been distributed: the mandate's target is reached. Distribution is off until you set a new one.` });
        out.escalations.push({ topic: "target_reached", why: "Distribution target reached.", options: ["set a new mandate", "keep only defending", "withdraw"], throttleMs: 7 * DAY });
      }
    } else {
      let factor = 1;
      const notes: string[] = [];
      if (targetTokens > 0n) {
        let catchUp = Math.min(2, Math.max(0.5, 1 + (elapsed - actual) * 2));
        if (elapsed > 1 - HORIZON_TAIL) catchUp = Math.min(1, catchUp); // never end a mandate in a dump
        if (catchUp > 1.1) notes.push(`behind the horizon (${(actual * 100).toFixed(0)}% done at ${(elapsed * 100).toFixed(0)}% of the time)`);
        if (catchUp < 0.9) notes.push(`ahead of the horizon (${(actual * 100).toFixed(0)}% done at ${(elapsed * 100).toFixed(0)}% of the time)`);
        factor *= catchUp;
      }
      if (sell1h > 0 && sell1h > buy1h * HOUR_PRESSURE_RATIO) {
        factor *= 0.5;
        notes.push("sellers dominate this hour, not adding supply to that");
      } else if (buy1h > 0 && buy1h > sell1h * HOUR_STRENGTH_RATIO) {
        factor *= 1.25;
        notes.push("buyers dominate this hour");
      }
      if (liqSoft) {
        factor = 0;
        notes.push(`pool liquidity is down to ${fmtSol(liqNow!)} SOL from ${fmtSol(liqThen!)} an hour ago`);
      }
      if (tier1) {
        factor = 0;
        notes.push(`price fell ${(drop5m * 100).toFixed(0)}% in 5 minutes`);
      }
      if (input.insiderSellRecent) {
        factor = 0;
        notes.push("a team wallet sold in the last 24h; not adding supply to that");
      }
      if (mandate.alertFloor !== undefined && snapshot.price < mandate.alertFloor) {
        factor = 0;
        notes.push(`price is under your alert line ${fmtPrice(mandate.alertFloor)}; only buying down here`);
        out.escalations.push({
          topic: "under_alert_floor",
          why: `Price ${fmtPrice(snapshot.price)} is under the ${fmtPrice(mandate.alertFloor)} you asked to be told about. Distribution is off until price is back above it; the defense keeps working.`,
          options: ["lower the alert line", "keep going like this"],
          throttleMs: 12 * HOUR,
        });
      }
      // Own share of the pool's volume: a market maker that is most of the market is the market.
      const externalVol24h = input.history24h && input.history24h.length >= 12 ? (mean(input.history24h.map((s) => s.buyFlow5mSol + s.sellFlow5mSol)) ?? 0) * 288 : undefined;
      const own = input.ownVolume24hSol ?? 0;
      const ownShare = externalVol24h !== undefined && externalVol24h + own > 0 ? own / (externalVol24h + own) : 0;
      if (ownShare >= OWN_SHARE_STOP) {
        factor = 0;
        notes.push(`Tenfold was ${(ownShare * 100).toFixed(0)}% of the pool's volume over 24h, too much of the market`);
        out.escalations.push({
          topic: "own_share",
          why: `Tenfold's own trades were ${(ownShare * 100).toFixed(0)}% of this pool's volume over the last 24h. Above ${(OWN_SHARE_STOP * 100).toFixed(0)}% the desk stops distributing: a desk that is most of the market is painting it. It resumes when real volume comes back.`,
          options: ["wait for real volume", "lower the mandate's share"],
          throttleMs: DAY,
        });
      } else if (ownShare >= OWN_SHARE_ALERT) {
        factor *= 0.5;
        notes.push(`Tenfold is ${(ownShare * 100).toFixed(0)}% of the pool's volume, halving to stay a minority`);
      }
      // Participation ceiling: sells per hour at most p x the pool's external volume per hour.
      let pace = round(Math.min(cfg.rules.dailySellCapPct, base * factor), 4);
      const extVolHourSol = (buy1h + sell1h) * 12;
      if (pace > 0 && extVolHourSol > 0 && vaultTokens > 0) {
        const maxTokensPerDay = (p.participation * extVolHourSol * 24) / snapshot.price;
        const participationPct = round((maxTokensPerDay / vaultTokens) * 100, 4);
        if (participationPct < pace) {
          pace = participationPct;
          notes.push(`capped at ${Math.round(p.participation * 100)}% of the pool's real volume`);
        }
      }
      const current = d.enabled ? d.pctOfVaultPerDay : 0;
      const rel = Math.abs(pace - current) / Math.max(current, 0.01);
      const paceCooldownOk = input.lastPaceChangeAt === undefined || now - input.lastPaceChangeAt >= PACE_CHANGE_MIN_INTERVAL_MS || pace === 0;
      if (rel > PACE_CHANGE_MIN_REL && paceCooldownOk) {
        d.pctOfVaultPerDay = pace;
        d.enabled = pace > 0;
        const why = pace === 0 ? `Distribution paused: ${notes.join("; ")}.` : `Distribution pace ${current.toFixed(2)}% → ${pace.toFixed(2)}% of the vault per day${notes.length ? ": " + notes.join("; ") : ""}.`;
        out.decisions.push({ change: { kind: "set_pace", from: current, to: pace }, why });
      }
      if (horizonExceedsCap(mandate, cfg.rules.dailySellCapPct) && !mandate.acceptedSlowPace) {
        const daysAtCap = Math.ceil(distributePct / cfg.rules.dailySellCapPct);
        out.escalations.push({
          topic: "horizon_unreachable",
          why: `At the ${cfg.rules.dailySellCapPct}% daily cap, ${distributePct}% of the vault takes about ${daysAtCap} days, not ${horizonDays}.`,
          options: ["raise the daily cap (takes 48 h)", "extend the horizon", "accept the slower pace"],
          throttleMs: 3 * DAY,
        });
      }
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
