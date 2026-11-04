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
/** Adverse flow needs size: mean 5-minute sells of at least this many SOL (or two clips) before the desk reacts to it. */
export const FAST_PRESSURE_MIN_SOL = 0.5;
/** Liquidity now under this fraction of an hour ago is a pull: everything stops. Needs several samples on both ends,
 *  over a 15-minute window, and a pool reading (never the quote-impact estimate) for the hard stop. */
export const LIQUIDITY_PULL_FRACTION = 0.5;
export const LIQUIDITY_SAMPLES_MIN = 5;
export const LIQUIDITY_WINDOW_MS = 15 * MINUTE;
/** Liquidity under this fraction of an hour ago pauses distribution only. */
export const LIQUIDITY_SOFT_FRACTION = 0.7;
/** Lose this many levels within 24h and the desk stops re-placing them: it does not buy into a trend. */
export const LOST_LEVELS_BEFORE_REST = 2;
/** The pace is re-set at most this often, unless it drops to zero. */
export const PACE_CHANGE_MIN_INTERVAL_MS = HOUR;
/** The deepest rung of the ladder is never more than this fraction under the anchor; the base distance scales down to fit. */
export const MAX_LADDER_DEPTH = 0.4;
/** The first ladder waits for this many one-minute price points unless a 24h volatility is known (an hour of history at least). */
export const VOL_WARMUP_POINTS = 10;
export const VOL24_MIN_SPAN_MS = HOUR;
/** A single placement run deploys at most this share of the day's remaining defense budget; the rest is kept for re-placements. */
export const LADDER_DAY_SHARE = 0.6;
/** A tier-1 drop (10% in 5 minutes) holds the defense and distribution for this long after it. */
export const TIER1_HOLD_MS = HOUR;
/** Clip size is re-derived at most this often, from the hour's median liquidity. */
export const CLIP_CHANGE_MIN_INTERVAL_MS = HOUR;
/** A distribution pace under this (% of the vault per day) is no pace: the pool has no real volume to sell into. */
export const PACE_FLOOR_PCT = 0.01;
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
  /** SOL volume of Tenfold's own fills over the last 24h and the last hour (both sides). The pool's flows include them. */
  ownVolume24hSol?: number;
  ownVolume1hSol?: number;
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
  /** Last time the desk re-derived the clip size (ms). */
  lastClipChangeAt?: number;
  /** Last time the desk let a level breathe: the ladder keeps one extra step of distance for `trailUpHours` after it. */
  lastBreatheAt?: number;
  /** Last time the loss limit or the inventory stop rested the defense: it stays resting for a day after it. */
  lastLossLimitAt?: number;
  /** Last time the runner saw a tier-1 drop (10% in 5 minutes): defense and distribution hold for TIER1_HOLD_MS after it. */
  lastTier1At?: number;
}

export interface DeskOutput {
  strategy: StrategyConfig;
  mandate: Mandate;
  decisions: DeskDecision[];
  escalations: DeskEscalation[];
  /** Set when the desk wants the whole project paused (liquidity pull). */
  pause?: { why: string };
  /** Set when the loss limit or the inventory stop is reached this run, whether or not a level was live to remove. */
  lossRest?: { why: string };
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

/** One point per minute (the last sample of each minute), so realized vol is measured on the same grid live and in backtests. */
export function minuteGrid<T extends { ts: number }>(series: T[]): T[] {
  const byMinute = new Map<number, T>();
  for (const s of series) byMinute.set(Math.floor(s.ts / MINUTE), s);
  return [...byMinute.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
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
function fmtPct(x: number): string {
  return `${x >= 0.1 || x === 0 ? x.toFixed(2) : x.toPrecision(2)}%`;
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
  const asks = mandate.autonomy === "ask";
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

  // Distance in realized-volatility units with the profile's floor; widened in a volatility spike. Both vols are
  // measured on a one-minute grid: raw 10-second quote mids carry bid-ask bounce that is not volatility.
  const minutePts = minuteGrid([...lastHour.map((x) => ({ ts: x.ts, price: x.price })), { ts: now, price: snapshot.price }]);
  const h24 = input.history24h ?? [];
  const span24 = h24.length >= 12 ? h24[h24.length - 1]!.ts - h24[0]!.ts : 0;
  const vol24h = span24 >= VOL24_MIN_SPAN_MS ? realizedHourVol(minuteGrid(h24.map((x) => ({ ts: x.ts, price: x.price })))) : undefined;
  const volReady = minutePts.length >= VOL_WARMUP_POINTS || vol24h !== undefined;
  const vol1h = minutePts.length >= VOL_WARMUP_POINTS ? realizedHourVol(minutePts) : (vol24h ?? 0);
  // A spike is only a spike when the hour's volatility actually exceeds the profile's floor distance: two tiny
  // numbers in a 1:3 ratio on a quiet drift are not a regime change.
  const spike = vol24h !== undefined && vol24h > 0 && vol1h > VOL_SPIKE_RATIO * vol24h && p.sigmaMult * vol1h > p.floorPct / 100;
  const deepestMult = p.ladder[p.ladder.length - 1] ?? 1;
  const baseDist = Math.min(MAX_LADDER_DEPTH / deepestMult, Math.max(p.floorPct / 100, p.sigmaMult * vol1h) * (spike ? 1.5 : 1));
  const distPct = baseDist * 100;

  // Hour flows: the ratio is meaningful whatever the sampling.
  const buy1h = mean(lastHour.map((s) => s.buyFlow5mSol)) ?? snapshot.buyFlow5mSol;
  const sell1h = mean(lastHour.map((s) => s.sellFlow5mSol)) ?? snapshot.sellFlow5mSol;
  const fastSell = mean(last15.map((s) => s.sellFlow5mSol)) ?? snapshot.sellFlow5mSol;
  const fastBuy = mean(last15.map((s) => s.buyFlow5mSol)) ?? snapshot.buyFlow5mSol;
  const fastPressure = last15.length >= 2 && fastSell >= Math.max(FAST_PRESSURE_MIN_SOL, 2 * strategy.clip.maxSol) && fastSell > fastBuy * FAST_PRESSURE_RATIO;
  const drop5m = rolling.price5mAgo && rolling.price5mAgo > 0 ? (rolling.price5mAgo - snapshot.price) / rolling.price5mAgo : 0;
  const tier1Hold = input.lastTier1At !== undefined && now - input.lastTier1At < TIER1_HOLD_MS;
  const tier1 = drop5m >= TIER1_DROP || tier1Hold;

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
  // Only readings of the same kind as the live one are compared: a pool reading and a quote-impact estimate are
  // different quantities, and a source flip (DexScreener down for an hour) is not a liquidity change.
  const sameSource = (s: Snapshot) => s.liquiditySol !== undefined && s.liquiditySource === snapshot.liquiditySource;
  const liqNowSamples = [...lastHour.filter((s) => s.ts >= now - LIQUIDITY_WINDOW_MS && sameSource(s)).map((s) => s.liquiditySol!), ...(snapshot.liquiditySol !== undefined ? [snapshot.liquiditySol] : [])];
  const liqOldSamples = lastHour.filter((s) => s.ts <= now - HOUR + LIQUIDITY_WINDOW_MS && sameSource(s)).map((s) => s.liquiditySol!);
  const liqNow = median(liqNowSamples);
  const liqThen = median(liqOldSamples);
  const liqKnown = liqNow !== undefined && liqThen !== undefined && liqThen > 0 && liqNowSamples.length >= LIQUIDITY_SAMPLES_MIN && liqOldSamples.length >= LIQUIDITY_SAMPLES_MIN;
  // The hard stop needs a pool reading; the quote-impact estimate flips with routing and only ever pauses distribution.
  if (liqKnown && snapshot.liquiditySource !== "impact" && liqNow! < liqThen! * LIQUIDITY_PULL_FRACTION) {
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
  if (!defenseWanted) {
    // No defense budget: the desk's own levels come out; the founder's pinned ones stay.
    const managedLeft = defense.levels.filter((l) => !l.pinned);
    if (managedLeft.length > 0) {
      for (const l of managedLeft) out.decisions.push({ change: { kind: "remove_level", price: l.price, cause: "no_budget" }, why: "The defense budget is 0: the desk's levels are withdrawn." });
      defense.levels = defense.levels.filter((l) => l.pinned);
    }
  } else {
    defense.enabled = true;
    const maxBelow = defense.maxDistanceBelowPct ?? p.maxDistanceBelowPct;
    const lifeLeft = lamportsToSol(defenseBudgetRemainingLamports(cfg, rolling));
    const dayLeft = lamportsToSol(defenseDayRemainingLamports(cfg, rolling));
    const budgetable = Math.min(lifeLeft, vaultSol);
    const managed = defense.levels.filter((l) => !l.pinned);
    const keep: DefenseLevel[] = defense.levels.filter((l) => l.pinned);
    // After a breathe the top rung stays out for a while: the ladder's next level is the one holding the price.
    const breathedRecently = input.lastBreatheAt !== undefined && now - input.lastBreatheAt < p.trailUpHours * HOUR;
    let changedLevels = false;
    let removedNow = false;

    // Loss controls on what the defense bought in the last 24h: a mark-to-market loss as a share of vault value,
    // or an inventory stop when the bought tokens are worth a profile's fraction less than they cost. Either one
    // rests the defense for a day (hysteresis: the price wobbling around the threshold does not restart it).
    const def24 = input.defense24h;
    const spent24 = def24 && def24.spentLamports > 0n ? lamportsToSol(def24.spentLamports) : 0;
    const mtmLoss = spent24 > 0 ? spent24 - (Number(def24!.tokensBought) / 10 ** cfg.decimals) * snapshot.price : 0;
    const lossResting = input.lastLossLimitAt !== undefined && now - input.lastLossLimitAt < DAY;
    const lossNow = !lossResting && spent24 > 0 && ((vaultValueSol > 0 && mtmLoss > (p.lossLimitPct / 100) * vaultValueSol) || mtmLoss / spent24 > p.inventoryStopPct);
    const lossBreached = lossNow || lossResting;
    if (lossNow) out.lossRest = { why: `Defended inventory of the last 24h is worth ${((mtmLoss / spent24) * 100).toFixed(0)}% less than it cost.` };

    // Lost levels are counted first so every line of this run tells the same story.
    const lost = input.lostLevelsLast24h ?? 0;
    const lostLevels = managed.filter((l) => levelLost(l, snapshot.price, maxBelow));
    const lostNow = lostLevels.length;
    const totalLost = lost + lostNow;
    const resting = lost >= LOST_LEVELS_BEFORE_REST && input.lastLostAt !== undefined && now - input.lastLostAt < restMsFor(p, lost);
    const willRest = totalLost >= LOST_LEVELS_BEFORE_REST;

    for (const level of managed.slice().sort((a, b) => b.price - a.price)) {
      const ownLeft = Math.max(0, level.budgetSol - lamportsToSol(levelSpentLamports(recentOrders, level)));
      if (lostLevels.includes(level)) {
        const pct = ((level.price - snapshot.price) / level.price) * 100;
        out.decisions.push({
          change: { kind: "remove_level", price: level.price, cause: "lost" },
          why: `Level ${fmtPrice(level.price)} is lost: price is ${pct.toFixed(0)}% under it. Not chasing it down${willRest ? `; that is ${totalLost} levels lost in 24h, so the defense rests ${Math.round(restMsFor(p, totalLost) / HOUR)} h instead of buying into the trend` : asks ? `; a lower ladder will be proposed after a ${p.cooldownMin} min cooldown` : `; re-placing lower after a ${p.cooldownMin} min cooldown`}.`,
        });
        changedLevels = true;
        removedNow = true;
        continue;
      }
      if (ownLeft < MIN_LEVEL_BUDGET_SOL * 0.2 && lifeLeft >= MIN_LEVEL_BUDGET_SOL && dayLeft >= MIN_LEVEL_BUDGET_SOL) {
        const refill = round(Math.min(budgetable, dayLeft * LADDER_DAY_SHARE) * p.split[level.rank ?? 0]!, 2);
        out.decisions.push({
          change: { kind: "remove_level", price: level.price, cause: "spent" },
          why: `Level ${fmtPrice(level.price)} has spent its ${fmtSol(level.budgetSol)} SOL. ${refill >= MIN_LEVEL_BUDGET_SOL ? (asks ? `A replacement will be proposed after a ${p.cooldownMin} min cooldown.` : `Re-placing it with fresh budget after a ${p.cooldownMin} min cooldown.`) : `Today's defense budget is nearly used (${fmtSol(dayLeft)} SOL left): it comes back when the budget allows.`}`,
        });
        changedLevels = true;
        removedNow = true;
        continue;
      }
      // Breathe: this level is absorbing selling at a rate that would burn the DAY's budget too fast (measured on the
      // desk's own fills on it over the last 15 minutes, not on the pool's flow), or the last 15 minutes are
      // one-sided selling of real size (adverse flow: holding against it is paying informed sellers). The level
      // steps aside for a few hours; the ladder's next level holds. Only while there is a day budget.
      if (levelInPlay(level, snapshot.price) && dayLeft >= MIN_LEVEL_BUDGET_SOL) {
        const ownBurnPerHour = lamportsToSol(levelSpentLamports(recentOrders.filter((o) => o.createdAt >= now - 15 * MINUTE), level)) * 4;
        const hours = ownBurnPerHour > 0 ? dayLeft / ownBurnPerHour : Infinity;
        if ((ownBurnPerHour > 0 && hours < p.breatheUnderHours) || fastPressure) {
          const next = managed.filter((l) => l !== level && l.price < level.price && !lostLevels.includes(l)).sort((a, b) => b.price - a.price)[0];
          const holds = next ? ` The ladder's next level at ${fmtPrice(next.price)} holds.` : "";
          out.decisions.push({
            change: { kind: "remove_level", price: level.price, cause: "breathe" },
            why: fastPressure
              ? `Sellers are ${(fastSell / Math.max(fastBuy, 1e-9)).toFixed(1)}x buyers over the last 15 minutes with price on ${fmtPrice(level.price)}. Letting it breathe: this level steps aside for ${p.trailUpHours} h rather than absorbing one-sided flow.${holds}`
              : `Level ${fmtPrice(level.price)} absorbed ${fmtSol(ownBurnPerHour / 4)} SOL in the last 15 minutes; at that rate today's budget lasts ${hours.toFixed(1)} h. Letting it breathe: this level steps aside for ${p.trailUpHours} h.${holds}`,
          });
          changedLevels = true;
          removedNow = true;
          continue;
        }
      }
      keep.push(level);
    }

    const restNow = resting || (lostNow > 0 && willRest) || lossBreached || tier1;
    if (restNow) {
      // Trend, loss or breaker protection: no managed level stays live while resting.
      for (const l of keep.filter((x) => !x.pinned)) {
        out.decisions.push({
          change: { kind: "remove_level", price: l.price, cause: lossBreached ? "loss_limit" : "rest" },
          why: lossBreached ? "Defense is resting for a day: the loss limit on defended inventory is reached." : tier1 ? `Defense is resting: price fell ${(drop5m * 100).toFixed(0)}% in 5 minutes.` : "Defense is resting after repeated lost levels.",
        });
        changedLevels = true;
      }
      for (let i = keep.length - 1; i >= 0; i--) if (!keep[i]!.pinned) keep.splice(i, 1);
      if (lossNow) {
        out.escalations.push({
          topic: "loss_limit",
          why: `Defense bought ${fmtSol(spent24)} SOL of tokens in the last 24h that are now worth ${fmtSol(spent24 - mtmLoss)} SOL: a ${fmtSol(mtmLoss)} SOL mark-to-market loss (${((mtmLoss / spent24) * 100).toFixed(0)}% of what it cost). The defense rests for a day rather than averaging down; distribution follows its own rules.`,
          options: ["keep resting", "switch to the distribute profile", "defend anyway (set a level yourself)"],
          throttleMs: DAY,
        });
      } else if (lostNow > 0 && willRest) {
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
      // Trail up: price has run well above the top level and held there, the level has not been needed for a
      // while, and nothing in this run says the market is turning (no level removed, no adverse flow, no drop,
      // hour's return not negative). A ladder is never lifted into a falling market.
      const managedKept = keep.filter((l) => !l.pinned).sort((a, b) => b.price - a.price);
      const top = managedKept[0];
      const trailWindow = history.filter((s) => s.ts >= now - p.trailUpHours * HOUR && s.ts < now);
      // At most one trail-up per trailUpHours: a ladder that follows every swing leaks intent and spams the founder.
      const trailThrottleOk = input.lastLevelChangeAt === undefined || now - input.lastLevelChangeAt >= p.trailUpHours * HOUR;
      // "Not turning": no level removed this run, no adverse flow, no 5-minute drop, the hour's second half not
      // under its first half (medians, not single samples), and the trail window's return not negative.
      const half = Math.floor(lastHour.length / 2);
      const firstHalf = median(lastHour.slice(0, half).map((x) => x.price));
      const secondHalf = median(lastHour.slice(half).map((x) => x.price).concat([snapshot.price]));
      const hourDown = firstHalf !== undefined && secondHalf !== undefined && secondHalf < firstHalf;
      const windowDown = trailWindow.length > 0 && snapshot.price < trailWindow[0]!.price;
      const dipNow = snapshot.price < ref * (1 - baseDist / 4);
      const marketTurning = removedNow || fastPressure || drop5m > 0 || hourDown || windowDown || dipNow;
      if (top && trailThrottleOk && !marketTurning) {
        const trailAt = top.price * (1 + p.trailUpSteps * baseDist);
        const quiet = !recentOrders.some((o) => o.side === "buy" && isLevelOrder(o, top) && o.createdAt > now - p.trailUpHours * HOUR);
        // Held above means the whole window stayed above the trail point, the distance the sentence claims.
        const heldAbove = trailWindow.length >= 3 && trailWindow[0]!.ts <= now - p.trailUpHours * HOUR * 0.9 && trailWindow.every((s) => s.price > trailAt);
        if (ref > trailAt && snapshot.price > trailAt && quiet && heldAbove) {
          // Move the ladder up by rank so two levels never land on the same price; one line for the whole ladder.
          const moves: { from: number; to: number }[] = [];
          managedKept.forEach((level, idx) => {
            const rank = Math.min(p.ladder.length - 1, level.rank ?? idx);
            const to = sig(anchor * (1 - Math.min(MAX_LADDER_DEPTH, baseDist * p.ladder[rank]!)));
            if (to > level.price && Math.abs(to - level.price) > baseDist * TRAIL_TOLERANCE * level.price && !keep.some((l) => l !== level && sameLevel(l.price, to))) {
              const at = keep.indexOf(level);
              keep[at] = { price: to, budgetSol: level.budgetSol, placedAt: now, rank };
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

      // Place the vacant rungs of the ladder, after the cooldown that follows a consumed level. Rungs are positions
      // under the anchor: a level keeps the rank it was placed on and a consumed rung is re-placed at that rank.
      // While a breathe is recent the top rung stays out: the next level is the one holding the price.
      const cooldownOk = input.lastLevelRemovedAt === undefined || now - input.lastLevelRemovedAt >= p.cooldownMin * MINUTE;
      const refreshOk = input.lastLevelChangeAt === undefined || now - input.lastLevelChangeAt >= DESK_INTERVAL_MS || changedLevels;
      const liveLevels = keep.filter((l) => !l.pinned);
      if (liveLevels.length < p.levels && cooldownOk && refreshOk && !removedNow && volReady && dayLeft >= MIN_LEVEL_BUDGET_SOL) {
        const rungs = p.ladder.map((mult, rank) => ({ rank, price: sig(anchor * (1 - Math.min(MAX_LADDER_DEPTH, baseDist * mult))) }));
        const claimed = new Set<number>();
        // Levels with a rank claim it; legacy levels without one claim the nearest free rung.
        for (const level of liveLevels) if (level.rank !== undefined && !claimed.has(level.rank)) claimed.add(level.rank);
        for (const level of liveLevels) {
          if (level.rank !== undefined && claimed.has(level.rank)) continue;
          let best: number | undefined;
          let bestGap = Infinity;
          for (const r of rungs) {
            if (claimed.has(r.rank)) continue;
            const gap = Math.abs(Math.log(level.price / r.price));
            if (gap < bestGap) { bestGap = gap; best = r.rank; }
          }
          if (best !== undefined) claimed.add(best);
        }
        if (breathedRecently) claimed.add(0);
        // Budget for this placement: a share of what the day still allows (the rest is kept for re-placements),
        // split by the profile's weights; a vol spike halves it.
        const ladderBudget = Math.min(budgetable, dayLeft * LADDER_DAY_SHARE) * (spike ? 0.5 : 1);
        const placed: { price: number; budgetSol: number }[] = [];
        for (const r of rungs) {
          if (claimed.has(r.rank) || liveLevels.length + placed.length >= p.levels) continue;
          if (!(r.price > 0) || keep.some((l) => sameLevel(l.price, r.price))) continue;
          const budget = round(ladderBudget * p.split[r.rank]!, 2);
          if (budget < MIN_LEVEL_BUDGET_SOL) continue;
          keep.push({ price: r.price, budgetSol: budget, placedAt: now, rank: r.rank });
          placed.push({ price: r.price, budgetSol: budget });
          changedLevels = true;
        }
        if (placed.length > 0) {
          const first = placed[0]!;
          const last = placed[placed.length - 1]!;
          const under = (l: { price: number }) => ((1 - l.price / anchor) * 100).toFixed(0);
          const range = placed.length === 1 ? `${under(first)}%` : `${under(first)}% to ${under(last)}%`;
          out.decisions.push({
            change: { kind: "place_level", price: first.price, budgetSol: round(placed.reduce((a, l) => a + l.budgetSol, 0), 2), levels: placed.map((l) => ({ price: l.price, budgetSol: l.budgetSol })) },
            why:
              `Placed ${placed.length === 1 ? "a defense level" : `${placed.length} defense levels`} at ${placed.map((l) => `${fmtPrice(l.price)} (${fmtSol(l.budgetSol)} SOL)`).join(", ")}: ` +
              `${range} under ${anchorName} ${fmtPrice(anchor)}` +
              `${vol1h * p.sigmaMult > p.floorPct / 100 ? `, sized for a ${(vol1h * 100).toFixed(0)}%/h market` : ""}${breathedRecently ? ", top rung resting after the breathe" : ""}${spike ? ", volatility spike: half budget" : ""}.`,
          });
        }
      }
    }
    if (changedLevels) defense.levels = keep.sort((a, b) => b.price - a.price);
  }

  // ---- C. clip size from pool depth: one clip never moves the price more than the profile allows ----
  // Derived from the hour's median liquidity (one reading flips with routing), at most once an hour.
  const clipSamples = [...lastHour.filter((x) => sameSource(x) && x.liquiditySol! > 0).map((x) => x.liquiditySol!), ...(snapshot.liquiditySol !== undefined && snapshot.liquiditySol > 0 ? [snapshot.liquiditySol] : [])];
  const liqForClip = clipSamples.length >= LIQUIDITY_SAMPLES_MIN ? median(clipSamples) : undefined;
  const clipCooldownOk = input.lastClipChangeAt === undefined || now - input.lastClipChangeAt >= CLIP_CHANGE_MIN_INTERVAL_MS;
  if (liqForClip !== undefined && liqForClip > 0 && clipCooldownOk) {
    const raw = liqForClip * (p.clipReservePct / 100);
    const target = round(Math.min(CLIP_MAX_SOL, Math.max(CLIP_MIN_SOL, raw)), 3);
    const current = strategy.clip.maxSol;
    if (Math.abs(target - current) / Math.max(current, 0.01) > 0.25) {
      strategy.clip.maxSol = target;
      if (strategy.clip.minSol > target) strategy.clip.minSol = round(Math.max(0.01, target / 2), 3);
      const impactPct = (target / liqForClip) * 2 * 100;
      out.decisions.push({
        change: { kind: "set_clip", from: current, to: target },
        why: raw < CLIP_MIN_SOL
          ? `Clip size ${fmtSol(current)} → ${fmtSol(target)} SOL, the smallest clip worth sending: the pool holds about ${fmtSol(liqForClip)} SOL, so even that moves the price about ${impactPct.toFixed(1)}%.`
          : `Clip size ${fmtSol(current)} → ${fmtSol(target)} SOL: about ${p.clipReservePct}% of the pool's ${fmtSol(liqForClip)} SOL, so one clip moves the price under ${(p.clipReservePct * 2).toFixed(1)}%.`,
      });
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
      // Own share of the pool's volume: a market maker that is most of the market is the market. The pool's flows
      // already include Tenfold's own fills, so the share is own over total, not own over total plus own.
      const totalVol24h = input.history24h && input.history24h.length >= 12 ? (mean(input.history24h.map((s) => s.buyFlow5mSol + s.sellFlow5mSol)) ?? 0) * 288 : undefined;
      const own = input.ownVolume24hSol ?? 0;
      const ownShare = totalVol24h !== undefined && totalVol24h > 0 ? Math.min(1, own / totalVol24h) : 0;
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
      // Participation ceiling: sells per hour at most p x the pool's EXTERNAL volume per hour (own fills taken out,
      // otherwise the ceiling would grow with Tenfold's own selling).
      let pace = round(Math.min(cfg.rules.dailySellCapPct, base * factor), 4);
      const extVolHourSol = Math.max(0, (buy1h + sell1h) * 12 - (input.ownVolume1hSol ?? 0));
      if (pace > 0 && vaultTokens > 0) {
        const maxTokensPerDay = (p.participation * extVolHourSol * 24) / snapshot.price;
        const participationPct = round((maxTokensPerDay / vaultTokens) * 100, 4);
        if (participationPct < pace) {
          pace = participationPct;
          notes.push(`capped at ${Math.round(p.participation * 100)}% of the pool's real volume`);
        }
        if (pace < PACE_FLOOR_PCT) {
          pace = 0;
          notes.push("there is no real volume to sell into; waiting for the pool to come alive");
        }
      }
      const current = d.enabled ? d.pctOfVaultPerDay : 0;
      const rel = Math.abs(pace - current) / Math.max(current, 0.01);
      const paceCooldownOk = input.lastPaceChangeAt === undefined || now - input.lastPaceChangeAt >= PACE_CHANGE_MIN_INTERVAL_MS || pace === 0;
      if (rel > PACE_CHANGE_MIN_REL && paceCooldownOk) {
        d.pctOfVaultPerDay = pace;
        d.enabled = pace > 0;
        const why = pace === 0 ? `Distribution paused: ${notes.join("; ")}.` : `Distribution pace ${fmtPct(current)} → ${fmtPct(pace)} of the vault per day${notes.length ? ": " + notes.join("; ") : ""}.`;
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
      why: "A declared team wallet sold in the last 24h. Distribution (and rebalance selling) is on hold for 24h so Tenfold does not add to that selling; it resumes by itself after that. The defense keeps working.",
      options: ["keep going like this", "pause everything", "withdraw the wallet from the team list if it is not the team's"],
      throttleMs: DAY,
    });
  }

  return out;
}

/** True when two strategies differ in anything the engine acts on. */
export function strategyChanged(a: StrategyConfig, b: StrategyConfig): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}
