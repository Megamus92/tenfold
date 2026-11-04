import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, DEFAULT_STRATEGY, Ledger, PROFILES, parseProjectConfig, seededRng, solToLamports, strategyFromMandate, tokensToBase } from "@tenfold/core";
import type { Mandate, Order, ProjectConfig, RollingState, Snapshot } from "@tenfold/core";
import { CLIP_MIN_SOL, DESK_FORCE_MIN_MS, DESK_INTERVAL_MS, MAX_LADDER_DEPTH, decide, median, minuteGrid, realizedHourVol } from "./desk.js";
import type { DeskInput } from "./desk.js";
import { ProjectRunner, downsample } from "./runner.js";
import type { Executor, PriceFeed } from "./runner.js";

const MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const DEC = 6;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = new Date(2026, 10, 4, 12, 0, 0).getTime();
const P = 0.0002;

function mandate(over: Partial<Mandate> = {}): Mandate {
  return { profile: "balanced", autonomy: "auto", startedAt: T0 - DAY, ...over };
}

function cfg(m: Mandate | null = mandate(), over: { rules?: Partial<ProjectConfig["rules"]>; strategy?: Partial<ProjectConfig["strategy"]>; paused?: boolean } = {}): ProjectConfig {
  const rules = { ...DEFAULT_RULES, defenseBudgetSol: 20, maxDefenseSpendPerDaySol: 5, ...over.rules };
  const base = parseProjectConfig({
    id: "d1",
    name: "D1",
    mint: MINT,
    decimals: DEC,
    walletPubkey: WALLET,
    mode: "paper",
    rules,
    strategy: { ...DEFAULT_STRATEGY, ...over.strategy },
    mandate: m ?? undefined,
    createdAt: 0,
    paused: over.paused ?? false,
  });
  if (m && !over.strategy) base.strategy = strategyFromMandate(m, base);
  return base;
}

/** A funded project with the horizon already measured, so the pace logic runs. */
function started(m: Mandate | null = mandate(), over: Parameters<typeof cfg>[1] = {}): ProjectConfig {
  const c = cfg(m, over);
  if (c.mandate) c.mandate.startTokens = tokensToBase(1_000_000, DEC).toString();
  return c;
}

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return { projectId: "d1", ts: T0, price: P, buyFlow5mSol: 1, sellFlow5mSol: 1, vaultTokens: tokensToBase(1_000_000, DEC), vaultLamports: solToLamports(40), liquiditySol: 200, ...over };
}

function rolling(over: Partial<RollingState> = {}): RollingState {
  return { soldLast24h: 0n, defenseSpentLast24hLamports: 0n, defenseSpentTotalLamports: 0n, ordersLastHour: 0, price5mAgo: P, ...over };
}

/** A flat history at `price`, one snapshot per `stepMin` minutes (5 by default), ending just before T0. */
function history(price: number, opts: { hours?: number; liquiditySol?: number; buy?: number; sell?: number; stepMin?: number } = {}): Snapshot[] {
  const out: Snapshot[] = [];
  const hours = opts.hours ?? 1;
  for (let t = T0 - hours * HOUR; t < T0; t += (opts.stepMin ?? 5) * MINUTE) {
    out.push(snap({ ts: t, price, liquiditySol: opts.liquiditySol ?? 200, buyFlow5mSol: opts.buy ?? 1, sellFlow5mSol: opts.sell ?? 1 }));
  }
  return out;
}

function input(over: Partial<DeskInput> = {}): DeskInput {
  return { cfg: started(), snapshot: snap(), rolling: rolling(), now: T0, history: history(P), recentOrders: [], distributedSinceStart: 0n, insiderSellRecent: false, lastLevelChangeAt: T0, ...over };
}

/** Input for a placement run: no level placed recently. */
function fresh(over: Partial<DeskInput> = {}): DeskInput {
  return input({ lastLevelChangeAt: undefined, ...over });
}

function kinds(out: ReturnType<typeof decide>): string[] {
  return out.decisions.map((d) => d.change.kind);
}
function level(price: number, budgetSol = 2, extra: Partial<{ pinned: boolean; placedAt: number }> = {}) {
  return { price, budgetSol, ...extra };
}
/** Six significant digits, as the desk writes prices. */
function sigp(x: number): number {
  return Number(x.toPrecision(6));
}

const bal = PROFILES.balanced;
const d1 = bal.floorPct / 100; // flat market: the floor distance binds

describe("desk manager: helpers", () => {
  it("median handles odd, even and empty lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeUndefined();
  });
  it("realized vol is zero on a flat or tiny series and positive on a moving one", () => {
    expect(realizedHourVol(history(P).map((s) => ({ ts: s.ts, price: s.price })))).toBe(0);
    expect(realizedHourVol([{ ts: 0, price: 1 }, { ts: 1, price: 2 }])).toBe(0);
    const wobble = history(P).map((s, i) => ({ ts: s.ts, price: P * (1 + (i % 2 ? 0.05 : -0.05)) }));
    expect(realizedHourVol(wobble)).toBeGreaterThan(0.1);
  });
  it("downsample keeps the ends and at most max items", () => {
    const xs = Array.from({ length: 1000 }, (_, i) => i);
    const ds = downsample(xs, 100);
    expect(ds.length).toBeLessThanOrEqual(101);
    expect(ds[0]).toBe(0);
    expect(ds[ds.length - 1]).toBe(999);
    expect(downsample([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });
});

describe("desk manager: decide", () => {
  it("does nothing without a mandate, and nothing while paused", () => {
    expect(decide(fresh({ cfg: cfg(null) })).decisions).toEqual([]);
    const paused = decide(fresh({ cfg: started(mandate(), { paused: true }) }));
    expect(paused.decisions).toEqual([]);
    expect(paused.escalations).toEqual([]);
  });

  it("on a fresh balanced mandate it records the start, places a three-level ladder under the reference and sets the pace", () => {
    const out = decide(fresh({ cfg: cfg() }));
    expect(kinds(out)).toContain("mandate_started");
    expect(out.mandate.startTokens).toBe(tokensToBase(1_000_000, DEC).toString());
    const placed = out.decisions.filter((d) => d.change.kind === "place_level");
    expect(placed).toHaveLength(1); // one line for the whole ladder
    expect(placed[0]!.why).toMatch(/Placed 3 defense levels at/);
    const prices = out.strategy.defense.levels.map((l) => l.price);
    expect(prices[0]).toBeCloseTo(P * (1 - d1 * bal.ladder[0]!), 9);
    expect(prices[1]).toBeCloseTo(P * (1 - d1 * bal.ladder[1]!), 9);
    expect(prices[2]).toBeCloseTo(P * (1 - d1 * bal.ladder[2]!), 9);
    // the day's 5 SOL split 25/35/40 across the ladder
    expect(out.strategy.defense.levels.map((l) => l.budgetSol)).toEqual([1.25, 1.75, 2]);
    expect(out.strategy.defense.levels.every((l) => l.placedAt === T0)).toBe(true);
    expect(out.strategy.distribution.enabled).toBe(true);
    expect(out.strategy.distribution.pctOfVaultPerDay).toBeGreaterThan(0);
    expect(out.strategy.distribution.pctOfVaultPerDay).toBeLessThanOrEqual(DEFAULT_RULES.dailySellCapPct);
    for (const d of out.decisions) expect(d.why.length).toBeGreaterThan(10);
  });

  it("widens the ladder in a volatile market and halves budgets on a volatility spike", () => {
    const wild = history(P).map((s, i) => ({ ...s, price: P * (1 + (i % 2 ? 0.04 : -0.04)) }));
    const calm = decide(fresh({ cfg: cfg() })).strategy.defense.levels[0]!.price;
    const out = decide(fresh({ cfg: cfg(), history: wild }));
    expect(out.strategy.defense.levels[0]!.price).toBeLessThan(calm);
    expect(out.decisions.find((d) => d.change.kind === "place_level")?.why).toMatch(/sized for a \d+%\/h market/);
    const quiet24 = history(P, { hours: 24 }).map((s, i) => ({ ...s, price: P * (1 + (i % 2 ? 0.003 : -0.003)) }));
    const spike = decide(fresh({ cfg: cfg(), history: wild, history24h: quiet24 }));
    expect(spike.decisions.find((d) => d.change.kind === "place_level")?.why).toMatch(/volatility spike: half budget/);
    expect(spike.strategy.defense.levels[0]!.budgetSol).toBeLessThan(out.strategy.defense.levels[0]!.budgetSol);
  });

  it("removes a lost level at once but re-places only after the cooldown, and rests after two losses", () => {
    const c = started();
    c.strategy.defense.levels = [level(P, 2, { placedAt: T0 - HOUR })];
    const out = decide(input({ cfg: c, snapshot: snap({ price: P * 0.8 }), history: history(P * 0.8) }));
    expect(kinds(out)).toContain("remove_level");
    expect(kinds(out)).not.toContain("place_level");
    expect(out.decisions.find((d) => d.change.kind === "remove_level")!.why).toMatch(/lost.*cooldown/);
    expect(out.strategy.defense.levels).toEqual([]);
    // after the cooldown, with no recent removal, the ladder comes back under the current price
    const later = decide(fresh({ cfg: { ...c, strategy: out.strategy }, snapshot: snap({ price: P * 0.8 }), rolling: rolling({ price5mAgo: P * 0.8 }), history: history(P * 0.8), lastLevelRemovedAt: T0 - bal.cooldownMin * MINUTE - 1 }));
    expect(later.strategy.defense.levels.length).toBe(3);
    expect(later.strategy.defense.levels.every((l) => l.price < P * 0.8)).toBe(true);
    // a second loss within 24h: no re-placement, trend_down escalation, no live managed level
    const c2 = started();
    c2.strategy.defense.levels = [level(P, 2, { placedAt: T0 - HOUR }), level(P * 0.97, 2, { placedAt: T0 - HOUR })];
    const rest = decide(input({ cfg: c2, snapshot: snap({ price: P * 0.8 }), rolling: rolling({ price5mAgo: P * 0.8 }), history: history(P * 0.8), lostLevelsLast24h: 1, lastLostAt: T0 - 2 * HOUR }));
    expect(rest.strategy.defense.levels.filter((l) => !l.pinned)).toEqual([]);
    expect(rest.escalations.map((e) => e.topic)).toContain("trend_down");
    expect(rest.escalations.find((e) => e.topic === "trend_down")!.why).toMatch(/3 defense levels lost.*resting the defense for 12 h/);
  });

  it("while resting after losses it places nothing and removes any live managed level", () => {
    const c = started();
    c.strategy.defense.levels = [level(P * 0.95, 2, { placedAt: T0 - HOUR })];
    const out = decide(fresh({ cfg: c, lostLevelsLast24h: 2, lastLostAt: T0 - HOUR }));
    expect(out.strategy.defense.levels).toEqual([]);
    expect(kinds(out)).toContain("remove_level");
    expect(kinds(out)).not.toContain("place_level");
  });

  it("a spent level is re-placed with a fresh placedAt so its old spend does not count", () => {
    const c = started();
    const old = T0 - 2 * HOUR;
    const price = P * (1 - d1);
    c.strategy.defense.levels = [level(price, 2, { placedAt: old })];
    const spent: Order = { id: "o1", projectId: "d1", side: "buy", reason: "DEF", inputMint: "x", outputMint: "y", amountIn: solToLamports(2), maxSlippageBps: 100, refPrice: P, status: "filled", createdAt: old + MINUTE, updatedAt: old + MINUTE, note: `level:${price} under` };
    const out = decide(input({ cfg: c, recentOrders: [spent] }));
    expect(out.decisions[0]!.change).toMatchObject({ kind: "remove_level", cause: "spent" });
    expect(out.strategy.defense.levels).toEqual([]);
    const later = decide(fresh({ cfg: { ...c, strategy: out.strategy }, recentOrders: [spent], lastLevelRemovedAt: T0 - HOUR }));
    const re = later.strategy.defense.levels.find((l) => Math.abs(l.price - price) < 1e-12);
    expect(re).toBeDefined();
    expect(re!.placedAt).toBe(T0);
    expect(re!.placedAt!).toBeGreaterThan(spent.createdAt);
  });

  it("lets a level breathe on sustained one-sided selling, stepping the ladder down", () => {
    const c = started();
    c.strategy.defense.levels = [level(P, 2, { placedAt: T0 - HOUR })];
    const s = snap({ price: P, sellFlow5mSol: 1, buyFlow5mSol: 0.1 });
    const out = decide(input({ cfg: c, snapshot: s, history: history(P, { sell: 1, buy: 0.1 }) }));
    const removed = out.decisions.find((d) => d.change.kind === "remove_level");
    expect(removed?.change).toMatchObject({ cause: "breathe" });
    expect(removed?.why).toMatch(/breathe/);
    expect(out.strategy.defense.levels).toEqual([]);
    const later = decide(fresh({ cfg: { ...c, strategy: out.strategy }, snapshot: snap(), history: history(P), lastLevelRemovedAt: T0 - HOUR }));
    expect(later.strategy.defense.levels[0]!.price).toBeCloseTo(P * (1 - d1 * bal.ladder[0]!), 9);
    // while the breathe is recent the whole ladder sits one notch lower
    const lower = decide(fresh({ cfg: { ...c, strategy: out.strategy }, snapshot: snap(), history: history(P), lastLevelRemovedAt: T0 - HOUR, lastBreatheAt: T0 - HOUR }));
    expect(lower.strategy.defense.levels[0]!.price).toBeCloseTo(P * (1 - d1 * (bal.ladder[0]! + 1)), 9);
    expect(lower.decisions.find((d) => d.change.kind === "place_level")?.why).toMatch(/one notch lower/);
  });

  it("re-places a consumed TOP rung at the top, not at the bottom: rungs are positions, not a count", () => {
    const c = started();
    const old = T0 - 2 * HOUR;
    const ladder = bal.ladder.map((m) => sigp(P * (1 - d1 * m)));
    c.strategy.defense.levels = [level(ladder[0]!, 1.25, { placedAt: old }), level(ladder[1]!, 1.75, { placedAt: old }), level(ladder[2]!, 2, { placedAt: old })];
    const spent: Order = { id: "o1", projectId: "d1", side: "buy", reason: "DEF", inputMint: "x", outputMint: "y", amountIn: solToLamports(1.25), maxSlippageBps: 100, refPrice: P, status: "filled", createdAt: old + MINUTE, updatedAt: old + MINUTE, note: `level:${ladder[0]} under` };
    const out = decide(input({ cfg: c, recentOrders: [spent] }));
    expect(out.decisions.find((d) => d.change.kind === "remove_level")?.change).toMatchObject({ cause: "spent", price: ladder[0] });
    expect(out.strategy.defense.levels.map((l) => l.price)).toEqual([ladder[1], ladder[2]]);
    const later = decide(fresh({ cfg: { ...c, strategy: out.strategy }, recentOrders: [spent], lastLevelRemovedAt: T0 - HOUR }));
    const prices = later.strategy.defense.levels.map((l) => l.price);
    expect(prices).toHaveLength(3);
    expect(prices[0]).toBeCloseTo(ladder[0]!, 12); // back at the top rung
    expect(prices[1]).toBe(ladder[1]);
    expect(prices[2]).toBe(ladder[2]);
    expect(Math.min(...prices)).toBeGreaterThanOrEqual(P * (1 - d1 * bal.ladder[2]! * 1.001));
    const placed = later.decisions.find((d) => d.change.kind === "place_level");
    expect(placed?.why).toMatch(/^Placed a defense level at .* 5% under/);
    // a breathed top rung comes back one notch under where it was, not at the deepest rung
    const breathed = decide(fresh({ cfg: { ...c, strategy: out.strategy }, recentOrders: [spent], lastLevelRemovedAt: T0 - HOUR, lastBreatheAt: T0 - 10 * MINUTE }));
    const bp = breathed.strategy.defense.levels.map((l) => l.price);
    expect(bp).toHaveLength(3);
    expect(bp[0]).toBe(ladder[1]); // the survivors claim the two upper rungs of the lowered ladder
    expect(bp[2]).toBeCloseTo(P * (1 - d1 * (bal.ladder[2]! + 1)), 12);
  });

  it("caps the deepest rung at the ladder depth and still places three rungs in a wild market", () => {
    const wild = history(P).map((s, i) => ({ ...s, price: P * (1 + (i % 2 ? 0.1 : -0.1)) }));
    const out = decide(fresh({ cfg: cfg(), history: wild }));
    const prices = out.strategy.defense.levels.map((l) => l.price);
    expect(prices).toHaveLength(3);
    const anchor = Math.min(P, median(wild.map((x) => x.price).concat([P]))!);
    expect(Math.min(...prices)).toBeCloseTo(anchor * (1 - MAX_LADDER_DEPTH), 12);
    expect(Math.max(...prices)).toBeGreaterThan(anchor * (1 - MAX_LADDER_DEPTH / bal.ladder[2]! * 1.01));
  });

  it("never trails the ladder up in a run that removed a level, into adverse flow, or on a down hour", () => {
    const c = started();
    // one level lost high up, one deep: the deep one is not lifted in the same run
    c.strategy.defense.levels = [level(P * 1.3, 2, { placedAt: T0 - DAY }), level(P * 0.5, 2, { placedAt: T0 - DAY })];
    const out = decide(input({ cfg: c, snapshot: snap({ price: P }), history: history(P, { hours: 4 }), lastLevelChangeAt: T0 - DAY }));
    expect(kinds(out)).toContain("remove_level");
    expect(kinds(out)).not.toContain("move_level");
    // the price has held above for hours but this hour's return is negative
    const c2 = started();
    c2.strategy.defense.levels = [level(P * 0.5, 2, { placedAt: T0 - DAY }), level(P * 0.45, 2, { placedAt: T0 - DAY })];
    const downHour = history(P, { hours: 4 }).map((s) => (s.ts >= T0 - HOUR ? { ...s, price: P * 1.02 } : s));
    const down = decide(input({ cfg: c2, snapshot: snap({ price: P }), history: downHour, lastLevelChangeAt: T0 - DAY }));
    expect(kinds(down)).not.toContain("move_level");
    // one-sided selling of real size right now
    const adverse = decide(input({ cfg: c2, snapshot: snap({ price: P, sellFlow5mSol: 3, buyFlow5mSol: 0.5 }), history: history(P, { hours: 4 }).map((s) => (s.ts >= T0 - 15 * MINUTE ? { ...s, sellFlow5mSol: 3, buyFlow5mSol: 0.5 } : s)), lastLevelChangeAt: T0 - DAY }));
    expect(kinds(adverse)).not.toContain("move_level");
  });

  it("breathes on the DAY's budget, not the rung's, and ignores tiny one-sided flow", () => {
    const c = started();
    c.strategy.defense.levels = [level(P, 1.25, { placedAt: T0 - HOUR })];
    // 0.7 SOL/h of excess selling against 5 SOL of day budget: 7 h, no breathe (the rung alone would last 1.8 h)
    const mild = decide(input({ cfg: c, snapshot: snap({ sellFlow5mSol: 0.3, buyFlow5mSol: 0.2417 }), history: history(P, { sell: 0.3, buy: 0.2417 }) }));
    expect(kinds(mild)).not.toContain("remove_level");
    // three sells against one buy, 0.05 SOL in all: not adverse flow
    const tiny = decide(input({ cfg: c, snapshot: snap({ sellFlow5mSol: 0.0375, buyFlow5mSol: 0.0125 }), history: history(P, { sell: 0.0375, buy: 0.0125 }) }));
    expect(kinds(tiny)).not.toContain("remove_level");
    // the same ratio with size breathes
    const big = decide(input({ cfg: c, snapshot: snap({ sellFlow5mSol: 3, buyFlow5mSol: 1 }), history: history(P, { sell: 3, buy: 1 }) }));
    expect(big.decisions.find((d) => d.change.kind === "remove_level")?.change).toMatchObject({ cause: "breathe" });
  });

  it("counts its own share against the pool's total volume, which already contains it", () => {
    const quiet = history(P, { hours: 24, buy: 0.05, sell: 0.05 }); // 28.8 SOL a day in all
    // 30% of the total is over the stop (own over total plus own would read 23%)
    const out = decide(input({ history24h: quiet, ownVolume24hSol: 28.8 * 0.3 }));
    expect(out.strategy.distribution.enabled).toBe(false);
    expect(out.escalations.map((e) => e.topic)).toContain("own_share");
    // the participation cap is on EXTERNAL volume: own fills in the hour do not raise it
    const c = started();
    const withOwn = decide(input({ cfg: c, history: history(P, { buy: 0.3, sell: 0.3 }), snapshot: snap({ buyFlow5mSol: 0.3, sellFlow5mSol: 0.3 }), ownVolume1hSol: 7.2 }));
    const without = decide(input({ cfg: c, history: history(P, { buy: 0.3, sell: 0.3 }), snapshot: snap({ buyFlow5mSol: 0.3, sellFlow5mSol: 0.3 }), ownVolume1hSol: 0 }));
    expect(withOwn.strategy.distribution.pctOfVaultPerDay).toBeLessThanOrEqual(without.strategy.distribution.pctOfVaultPerDay);
    expect(withOwn.strategy.distribution.enabled).toBe(false); // all of the hour's volume was Tenfold's: nothing real to sell into
  });

  it("rests the defense on the inventory stop, and keeps resting for a day", () => {
    const c = started();
    c.strategy.defense.levels = [level(P * 0.95, 2, { placedAt: T0 - HOUR })];
    // bought 5 SOL of tokens now worth 2.5 SOL: 1% of a 240 SOL vault (under the 2% limit) but half of what it cost
    const out = decide(input({ cfg: c, defense24h: { spentLamports: solToLamports(5), tokensBought: tokensToBase(12_500, DEC) } }));
    expect(out.strategy.defense.levels).toEqual([]);
    expect(out.escalations.find((e) => e.topic === "loss_limit")?.why).toMatch(/50% of what it cost/);
    // two hours later the price is back a little: still resting, nothing placed, no new escalation
    const later = decide(fresh({ cfg: { ...c, strategy: out.strategy }, lastLossLimitAt: T0 - 2 * HOUR, lastLevelRemovedAt: T0 - 2 * HOUR }));
    expect(kinds(later)).not.toContain("place_level");
    expect(later.escalations.map((e) => e.topic)).not.toContain("loss_limit");
    const dayAfter = decide(fresh({ cfg: { ...c, strategy: out.strategy }, lastLossLimitAt: T0 - DAY - 1, lastLevelRemovedAt: T0 - 2 * HOUR }));
    expect(kinds(dayAfter)).toContain("place_level");
  });

  it("measures volatility on a one-minute grid: bid-ask bounce in 10-second quotes is not volatility", () => {
    const bounce: Snapshot[] = [];
    let i = 0;
    for (let t = T0 - HOUR; t < T0; t += 10_000) bounce.push(snap({ ts: t, price: P * (1 + (i++ % 2 ? 0.005 : -0.005)) }));
    expect(minuteGrid(bounce)).toHaveLength(60);
    const quiet24 = history(P, { hours: 24 }).map((s, j) => ({ ...s, price: P * (1 + (j % 2 ? 0.002 : -0.002)) }));
    const out = decide(fresh({ cfg: cfg(), history: bounce, history24h: quiet24 }));
    const placed = out.decisions.find((d) => d.change.kind === "place_level");
    expect(placed).toBeDefined();
    expect(placed!.why).not.toMatch(/sized for|volatility spike/);
    expect(out.strategy.defense.levels[0]!.price).toBeCloseTo(Math.min(P, P * 1.005) * (1 - d1 * bal.ladder[0]!), 9);
    // and no ladder at all before ten minutes of prices are in
    const young = decide(fresh({ cfg: cfg(), history: bounce.slice(-30) }));
    expect(kinds(young)).not.toContain("place_level");
  });

  it("a dead pool gets no pace and one plain line, not 0.00% → 0.00% every hour", () => {
    const dead = decide(input({ history: history(P, { buy: 0.0001, sell: 0.0001 }), snapshot: snap({ buyFlow5mSol: 0.0001, sellFlow5mSol: 0.0001 }) }));
    expect(dead.strategy.distribution.enabled).toBe(false);
    const line = dead.decisions.find((d) => d.change.kind === "set_pace");
    expect(line?.why).toMatch(/no real volume/);
    expect(line?.why).not.toMatch(/0\.00% → 0\.00%/);
    const again = decide(input({ cfg: { ...started(), strategy: dead.strategy }, history: history(P, { buy: 0.0001, sell: 0.0001 }), snapshot: snap({ buyFlow5mSol: 0.0001, sellFlow5mSol: 0.0001 }), lastPaceChangeAt: T0 - HOUR }));
    expect(kinds(again)).not.toContain("set_pace");
  });

  it("with the defense budget set to 0 the desk's levels are withdrawn and the founder's stay", () => {
    const c = started(mandate(), { rules: { defenseBudgetSol: 0 } });
    c.strategy.defense.levels = [level(P * 0.95, 2, { placedAt: T0 - HOUR }), level(0.0001, 3, { pinned: true })];
    const out = decide(input({ cfg: c }));
    expect(out.strategy.defense.levels).toEqual([level(0.0001, 3, { pinned: true })]);
    expect(out.decisions.find((d) => d.change.kind === "remove_level")?.change).toMatchObject({ cause: "no_budget" });
  });

  it("rests the defense and escalates once the budget is used up, with a weekly reminder at most", () => {
    const c = started();
    c.strategy.defense.levels = [level(P * 0.95, 2, { placedAt: T0 - HOUR })];
    const out = decide(input({ cfg: c, rolling: rolling({ defenseSpentTotalLamports: solToLamports(19.8) }) }));
    expect(out.strategy.defense.levels).toEqual([]);
    const e = out.escalations.find((x) => x.topic === "budget_top_up");
    expect(e).toBeDefined();
    expect(e!.throttleMs).toBe(7 * DAY);
    expect(kinds(out)).not.toContain("place_level");
  });

  it("an empty wallet gets one 'fund it' escalation and nothing else", () => {
    const out = decide(fresh({ cfg: cfg(), snapshot: snap({ vaultTokens: 0n, vaultLamports: 0n }) }));
    expect(out.decisions).toEqual([]);
    expect(out.escalations.map((e) => e.topic)).toEqual(["unfunded"]);
    expect(out.escalations[0]!.why).toContain(WALLET);
  });

  it("tokens without SOL: distribution runs, defense asks for SOL instead of claiming the budget is spent", () => {
    const out = decide(fresh({ snapshot: snap({ vaultLamports: 0n }) }));
    expect(out.escalations.map((e) => e.topic)).toContain("no_sol");
    expect(out.escalations.map((e) => e.topic)).not.toContain("budget_top_up");
    expect(out.strategy.distribution.enabled).toBe(true);
  });

  it("never touches a pinned level, and keeps defense on even when the founder's level is the only one", () => {
    const c = started();
    c.strategy.defense.levels = [level(0.0001, 3, { pinned: true })];
    const out = decide(fresh({ cfg: c, snapshot: snap({ price: 0.00005 }), history: history(0.00005) }));
    expect(out.strategy.defense.levels.find((l) => l.pinned)?.price).toBe(0.0001);
    expect(out.decisions.filter((d) => d.change.kind === "remove_level")).toEqual([]);
    expect(out.strategy.defense.enabled).toBe(true);
  });

  it("trails the ladder up by rank, never two levels onto the same price", () => {
    const c = started();
    c.strategy.defense.levels = [level(P * 0.5, 2, { placedAt: T0 - DAY }), level(P * 0.45, 2, { placedAt: T0 - DAY })];
    const out = decide(input({ cfg: c, snapshot: snap({ price: P }), history: history(P, { hours: 4 }), lastLevelChangeAt: T0 - DAY }));
    const moves = out.decisions.filter((d) => d.change.kind === "move_level");
    expect(moves).toHaveLength(1);
    expect(moves[0]!.why).toMatch(/Trailing the ladder up: .*→.*, .*→/);
    // a ladder moved less than trailUpHours ago is left alone
    const recent = decide(input({ cfg: c, snapshot: snap({ price: P }), history: history(P, { hours: 4 }), lastLevelChangeAt: T0 - HOUR }));
    expect(recent.decisions.filter((d) => d.change.kind === "move_level")).toEqual([]);
    const prices = out.strategy.defense.levels.map((l) => l.price);
    expect(new Set(prices.map((x) => x.toPrecision(6))).size).toBe(prices.length);
    expect(prices[0]).toBeCloseTo(P * (1 - d1 * bal.ladder[0]!), 9);
    expect(prices[1]).toBeCloseTo(P * (1 - d1 * bal.ladder[1]!), 9);
  });

  it("halves the pace when sellers dominate the hour and lifts it when buyers do", () => {
    const c = started();
    const base = c.strategy.distribution.pctOfVaultPerDay;
    const down = decide(input({ cfg: c, history: history(P, { sell: 2, buy: 0.5 }), snapshot: snap({ sellFlow5mSol: 2, buyFlow5mSol: 0.5 }) }));
    expect(down.strategy.distribution.pctOfVaultPerDay).toBeLessThan(base);
    expect(down.decisions.find((d) => d.change.kind === "set_pace")?.why).toMatch(/sellers dominate/);
    const c2 = started(mandate({ distributePct: 5, horizonDays: 40 }));
    const up = decide(input({ cfg: c2, history: history(P, { sell: 0.5, buy: 2 }), snapshot: snap({ sellFlow5mSol: 0.5, buyFlow5mSol: 2 }) }));
    expect(up.strategy.distribution.pctOfVaultPerDay).toBeGreaterThan(c2.strategy.distribution.pctOfVaultPerDay);
  });

  it("caps the pace at the profile's participation in the pool's real volume", () => {
    // thin pool (0.1 SOL per 5 min each side = 2.4 SOL/h) and a big vault, so 10% participation binds
    const c = started();
    c.mandate!.startTokens = tokensToBase(100_000_000, DEC).toString();
    const thin = history(P, { buy: 0.1, sell: 0.1 });
    const out = decide(input({ cfg: c, history: thin, snapshot: snap({ buyFlow5mSol: 0.1, sellFlow5mSol: 0.1, vaultTokens: tokensToBase(100_000_000, DEC) }) }));
    expect(out.decisions.find((d) => d.change.kind === "set_pace")?.why).toMatch(/capped at 10% of the pool's real volume/);
    expect(out.strategy.distribution.pctOfVaultPerDay).toBeLessThan(0.1);
  });

  it("stops adding supply after a team wallet sold, and says so", () => {
    const out = decide(input({ insiderSellRecent: true }));
    expect(out.strategy.distribution.enabled).toBe(false);
    expect(out.escalations.map((e) => e.topic)).toContain("insider_sell");
  });

  it("turns distribution off once the share is distributed, and stays off on the next run", () => {
    const c = started(mandate({ distributePct: 10, horizonDays: 10 }));
    const out = decide(input({ cfg: c, distributedSinceStart: tokensToBase(100_000, DEC) }));
    expect(kinds(out)).toContain("distribution_done");
    expect(out.strategy.distribution.enabled).toBe(false);
    expect(out.escalations.map((e) => e.topic)).toContain("target_reached");
    const again = decide(input({ cfg: { ...c, strategy: out.strategy }, distributedSinceStart: tokensToBase(100_000, DEC), now: T0 + 2 * HOUR }));
    expect(again.strategy.distribution.enabled).toBe(false);
    expect(kinds(again)).not.toContain("set_pace");
    expect(kinds(again)).not.toContain("distribution_done");
    expect(again.escalations.map((e) => e.topic)).not.toContain("horizon_unreachable");
  });

  it("caps the catch-up at 1 in the last tenth of the horizon", () => {
    const c = started(mandate({ distributePct: 10, horizonDays: 10, startedAt: T0 - 9.5 * DAY }));
    const out = decide(input({ cfg: c, distributedSinceStart: tokensToBase(10_000, DEC) }));
    expect(out.strategy.distribution.pctOfVaultPerDay).toBeLessThanOrEqual(0.5);
    expect(out.decisions.find((d) => d.change.kind === "set_pace")?.why ?? "").not.toMatch(/behind/);
  });

  it("escalates a horizon the daily cap cannot reach, unless the founder accepted the slower pace", () => {
    const c = started(mandate({ distributePct: 100, horizonDays: 10 }));
    const out = decide(input({ cfg: c }));
    expect(out.escalations.find((x) => x.topic === "horizon_unreachable")?.why).toMatch(/takes about 200 days, not 10/);
    const ok = decide(input({ cfg: started(mandate({ distributePct: 100, horizonDays: 10, acceptedSlowPace: true })) }));
    expect(ok.escalations.map((e) => e.topic)).not.toContain("horizon_unreachable");
  });

  it("pauses everything on a liquidity pull only when a quarter hour of pool readings agrees, and asks the founder", () => {
    const one = decide(input({ snapshot: snap({ liquiditySol: 60 }), history: history(P, { liquiditySol: 200, stepMin: 1 }) }));
    expect(one.pause).toBeUndefined();
    // three low readings over five minutes are not enough either
    const few = history(P, { liquiditySol: 200, stepMin: 1 }).map((s) => (s.ts >= T0 - 3 * MINUTE ? { ...s, liquiditySol: 60 } : s));
    expect(decide(input({ snapshot: snap({ liquiditySol: 60 }), history: few })).pause).toBeUndefined();
    const recentLow = history(P, { liquiditySol: 200, stepMin: 1 }).map((s) => (s.ts >= T0 - 15 * MINUTE ? { ...s, liquiditySol: 60 } : s));
    const confirmed = decide(input({ snapshot: snap({ liquiditySol: 60, liquiditySource: "dex" }), history: recentLow }));
    expect(confirmed.pause?.why).toMatch(/liquidity/i);
    expect(kinds(confirmed)).toContain("pause");
    expect(confirmed.escalations.map((e) => e.topic)).toContain("liquidity_pull");
    // the quote-impact estimate flips with routing: it never hard-stops, it only pauses distribution
    const estimate = decide(input({ snapshot: snap({ liquiditySol: 60, liquiditySource: "impact" }), history: recentLow }));
    expect(estimate.pause).toBeUndefined();
    expect(estimate.strategy.distribution.enabled).toBe(false);
    const softer = history(P, { liquiditySol: 200, stepMin: 1 }).map((s) => (s.ts >= T0 - 15 * MINUTE ? { ...s, liquiditySol: 130 } : s));
    const soft = decide(input({ snapshot: snap({ liquiditySol: 130 }), history: softer }));
    expect(soft.pause).toBeUndefined();
    expect(soft.strategy.distribution.enabled).toBe(false);
    expect(soft.decisions.find((d) => d.change.kind === "set_pace")?.why).toMatch(/liquidity is down/);
  });

  it("under the alert line distribution is off and the founder is told at most twice a day", () => {
    const out = decide(input({ cfg: started(mandate({ alertFloor: 0.0003 })) }));
    const e = out.escalations.find((x) => x.topic === "under_alert_floor");
    expect(e).toBeDefined();
    expect(e!.throttleMs).toBe(12 * HOUR);
    expect(out.strategy.distribution.enabled).toBe(false);
    expect(out.decisions.find((d) => d.change.kind === "set_pace")?.why).toMatch(/alert line/);
  });

  it("rests the defense on a daily mark-to-market loss beyond the profile's limit", () => {
    const c = started();
    c.strategy.defense.levels = [level(P * 0.95, 2, { placedAt: T0 - HOUR })];
    // bought 10 SOL of tokens now worth 5 SOL: a 5 SOL loss on a 240 SOL vault (2.1% > 2%)
    const out = decide(input({ cfg: c, defense24h: { spentLamports: solToLamports(10), tokensBought: tokensToBase(25_000, DEC) } }));
    expect(out.strategy.defense.levels).toEqual([]);
    expect(out.escalations.map((e) => e.topic)).toContain("loss_limit");
    expect(out.decisions.find((d) => d.change.kind === "remove_level")?.change).toMatchObject({ cause: "loss_limit" });
  });

  it("a 10% drop in five minutes pauses distribution and rests the ladder", () => {
    const c = started();
    c.strategy.defense.levels = [level(P * 0.95, 2, { placedAt: T0 - HOUR })];
    const out = decide(input({ cfg: c, snapshot: snap({ price: P * 0.88 }), rolling: rolling({ price5mAgo: P }) }));
    expect(out.strategy.distribution.enabled).toBe(false);
    expect(out.strategy.defense.levels).toEqual([]);
    expect(out.decisions.find((d) => d.change.kind === "set_pace")?.why).toMatch(/fell 12% in 5 minutes/);
  });

  it("stops distributing when Tenfold is most of the pool's volume", () => {
    const quiet = history(P, { hours: 24, buy: 0.05, sell: 0.05 });
    const out = decide(input({ history24h: quiet, ownVolume24hSol: 100 }));
    expect(out.strategy.distribution.enabled).toBe(false);
    expect(out.escalations.map((e) => e.topic)).toContain("own_share");
  });

  it("sizes the clip from the hour's median pool depth, at most once an hour, and does not flap on a noisy estimate", () => {
    const out = decide(input({ snapshot: snap({ liquiditySol: 2000 }), history: history(P, { liquiditySol: 2000 }) }));
    expect(out.decisions.find((d) => d.change.kind === "set_clip")).toBeDefined();
    expect(out.strategy.clip.maxSol).toBe(10); // 0.5% of 2000
    const small = decide(input({ snapshot: snap({ liquiditySol: 40 }), history: history(P, { liquiditySol: 40 }) }));
    expect(small.strategy.clip.maxSol).toBe(0.2);
    expect(small.strategy.clip.minSol).toBeLessThanOrEqual(0.2);
    // a change under 25% is noise and left alone
    const near = decide(input({ snapshot: snap({ liquiditySol: 80 }), history: history(P, { liquiditySol: 80 }) }));
    expect(near.strategy.clip.maxSol).toBe(0.5);
    // one reading of 2000 against an hour at 100 is not the pool's depth (100 x 0.5% is the 0.5 SOL already set)
    const spike = decide(input({ snapshot: snap({ liquiditySol: 2000 }), history: history(P, { liquiditySol: 100 }) }));
    expect(spike.decisions.find((d) => d.change.kind === "set_clip")).toBeUndefined();
    // an estimate alternating 35 / 70 between runs: one clip from the median, then nothing for an hour
    const flap = history(P, { liquiditySol: 35, stepMin: 1 }).map((s, i) => (i % 2 ? { ...s, liquiditySol: 70 } : s));
    const first = decide(input({ snapshot: snap({ liquiditySol: 70 }), history: flap }));
    expect(first.decisions.filter((d) => d.change.kind === "set_clip")).toHaveLength(1);
    const c = started();
    c.strategy.clip.maxSol = first.strategy.clip.maxSol;
    const second = decide(input({ cfg: c, snapshot: snap({ liquiditySol: 35 }), history: flap, lastClipChangeAt: T0 - 20 * MINUTE }));
    expect(second.decisions.filter((d) => d.change.kind === "set_clip")).toHaveLength(0);
    expect(second.decisions.filter((d) => d.change.kind === "set_pace")).toHaveLength(0);
    expect(second.pause).toBeUndefined();
    // a pool with a few SOL gets the smallest clip, and the line says so
    const tiny = decide(input({ snapshot: snap({ liquiditySol: 5 }), history: history(P, { liquiditySol: 5 }) }));
    expect(tiny.strategy.clip.maxSol).toBe(CLIP_MIN_SOL);
    expect(tiny.decisions.find((d) => d.change.kind === "set_clip")?.why).toMatch(/smallest clip/);
  });
});

// ---------- runner integration ----------

class Feed implements PriceFeed {
  price = P;
  liquidity = 200;
  sell = 1;
  buy = 1;
  async snapshot(): Promise<Omit<Snapshot, "projectId" | "ts">> {
    return { price: this.price, liquiditySol: this.liquidity, buyFlow5mSol: this.buy, sellFlow5mSol: this.sell, vaultTokens: tokensToBase(1_000_000, DEC), vaultLamports: solToLamports(40) };
  }
}
class NoExec implements Executor {
  async execute(order: Order): Promise<never> {
    throw new Error(`no execution in this test (${order.reason})`);
  }
}

function harness(c: ProjectConfig, opts: { reload?: (id: string) => ProjectConfig } = {}) {
  const ledger = new Ledger(":memory:");
  ledger.upsertProject(c);
  let now = T0;
  const feed = new Feed();
  const saved: ProjectConfig[] = [];
  const runner = new ProjectRunner({ ledger, feed, executor: new NoExec(), rng: seededRng(1), cfg: c, now: () => now, persistConfig: (x) => saved.push(x), reloadConfig: opts.reload });
  return { ledger, feed, runner, saved, advance: (ms: number) => (now += ms), now: () => now };
}

/** Tick for the volatility warm-up (one snapshot a minute for a quarter hour) so the desk has a readable market. */
async function warm(h: ReturnType<typeof harness>): Promise<void> {
  for (let i = 0; i < 15; i++) {
    await h.runner.tick();
    h.advance(MINUTE);
  }
  await h.runner.tick();
}

describe("desk manager in the runner", () => {
  it("auto: places nothing before the market is readable, then applies decisions, persists them and writes desk_decision events; re-runs only after the interval", async () => {
    const h = harness(cfg());
    await h.runner.tick();
    expect(h.ledger.listEvents("d1", { types: ["desk_decision"], limit: 50 }).map((e) => e.data.kind)).not.toContain("place_level");
    await warm(h);
    const events = h.ledger.listEvents("d1", { types: ["desk_decision"], limit: 50 });
    expect(events.map((e) => e.data.kind)).toContain("place_level");
    expect(h.runner.cfg.strategy.defense.levels).toHaveLength(3);
    expect(h.runner.cfg.mandate?.startTokens).toBeDefined();
    expect(h.saved.length).toBeGreaterThan(0);
    expect(h.ledger.getProject("d1")?.strategy.defense.levels).toHaveLength(3);
    h.advance(MINUTE);
    await h.runner.tick();
    expect(h.ledger.listEvents("d1", { types: ["desk_decision"], limit: 50 }).length).toBe(events.length);
    h.advance(DESK_INTERVAL_MS);
    await h.runner.tick();
    expect(h.ledger.listEvents("d1", { types: ["desk_decision"], limit: 50 }).length).toBe(events.length);
  });

  it("ask: proposes what adds exposure once per six hours even on a drifting price, applies what reduces it, and keeps the bookkeeping", async () => {
    const h = harness(cfg(mandate({ autonomy: "ask" })));
    await warm(h);
    const first = h.ledger.listEvents("d1", { types: ["desk_proposal"], limit: 50 });
    expect(first.map((e) => e.data.kind)).toContain("place_level");
    expect(h.ledger.listEvents("d1", { types: ["desk_decision"], limit: 50 }).filter((e) => e.data.kind !== "mandate_started")).toEqual([]);
    expect(h.runner.cfg.strategy.defense.levels).toEqual([]);
    expect(h.runner.cfg.mandate?.startTokens).toBeDefined();
    // the price drifts a little every run: the proposal's prices change, the batch is still not repeated within 6h
    for (let i = 0; i < 12; i++) {
      h.feed.price *= 0.998;
      h.advance(DESK_INTERVAL_MS);
      await h.runner.tick();
    }
    expect(h.ledger.listEvents("d1", { types: ["desk_proposal"], limit: 50 }).length).toBe(first.length);
    h.advance(6 * HOUR);
    await h.runner.tick();
    expect(h.ledger.listEvents("d1", { types: ["desk_proposal"], limit: 50 }).length).toBeGreaterThan(first.length);
    // a safety stop is applied, not proposed: a team wallet sells, distribution goes off
    h.ledger.recordInsiderSell({ projectId: "d1", wallet: "TeamWallet111111111111111111111111111111111", ts: h.now(), txSig: "sig1", amount: 1000n });
    h.advance(DESK_INTERVAL_MS);
    await h.runner.tick();
    expect(h.runner.cfg.strategy.distribution.enabled).toBe(false);
    expect(h.ledger.listEvents("d1", { types: ["desk_decision"], limit: 50 }).map((e) => e.data.kind)).toContain("set_pace");
  });

  it("a founder change saved between the desk's read and its write is kept, and the desk re-decides on it", async () => {
    let fileVersion: ProjectConfig | undefined;
    const h = harness(cfg(), { reload: (id) => fileVersion ?? h.ledger.getProject(id)! });
    await warm(h);
    fileVersion = {
      ...h.runner.cfg,
      rules: { ...h.runner.cfg.rules, dailySellCapPct: 0.2 },
      strategy: { ...h.runner.cfg.strategy, defense: { ...h.runner.cfg.strategy.defense, levels: [...h.runner.cfg.strategy.defense.levels, level(0.0001, 1, { pinned: true })] } },
      mandate: { ...h.runner.cfg.mandate!, profile: "protect" },
    };
    h.feed.price = P * 0.7; // a lost level forces a desk run
    h.advance(DESK_FORCE_MIN_MS + 1);
    await h.runner.tick();
    expect(h.runner.cfg.mandate?.profile).toBe("protect");
    expect(h.runner.cfg.strategy.defense.levels.some((l) => l.pinned && l.price === 0.0001)).toBe(true);
    h.advance(DESK_FORCE_MIN_MS + 1);
    await h.runner.tick();
    expect(h.runner.cfg.strategy.defense.levels.some((l) => l.pinned && l.price === 0.0001)).toBe(true);
    expect(h.runner.cfg.mandate?.profile).toBe("protect");
    expect(h.runner.cfg.rules.dailySellCapPct).toBe(0.2);
    expect(h.runner.cfg.strategy.distribution.pctOfVaultPerDay).toBeLessThanOrEqual(0.2);
    expect(h.saved[h.saved.length - 1]!.strategy.defense.levels.some((l) => l.pinned)).toBe(true);
  });

  it("a lost level forces a desk run (not closer than a minute), and a confirmed liquidity pull pauses the project", async () => {
    const h = harness(cfg());
    await warm(h);
    h.advance(DESK_INTERVAL_MS);
    await h.runner.tick(); // a desk run just happened
    const top = h.runner.cfg.strategy.defense.levels[0]!.price;
    h.advance(10_000);
    h.feed.price = top * 0.8;
    await h.runner.tick();
    expect(h.runner.cfg.strategy.defense.levels.some((l) => l.price === top)).toBe(true);
    h.advance(DESK_FORCE_MIN_MS);
    await h.runner.tick();
    expect(h.runner.cfg.strategy.defense.levels.some((l) => l.price === top)).toBe(false);
    for (let i = 0; i < 60; i++) {
      h.advance(MINUTE);
      await h.runner.tick();
    }
    h.feed.liquidity = 40;
    for (let i = 0; i < 16; i++) {
      h.advance(MINUTE);
      await h.runner.tick();
    }
    expect(h.runner.cfg.paused).toBe(true);
    expect(h.ledger.listEvents("d1", { types: ["desk_escalation"], limit: 50 }).map((e) => e.data.topic)).toContain("liquidity_pull");
    expect(h.ledger.listEvents("d1", { types: ["paused"], limit: 5 })[0]?.data.by).toBe("desk");
    const before = h.ledger.listEvents("d1", { types: ["desk_decision"], limit: 100 }).length;
    h.advance(DESK_INTERVAL_MS);
    await h.runner.tick();
    expect(h.ledger.listEvents("d1", { types: ["desk_decision"], limit: 100 }).length).toBe(before);
  });

  it("budget low forces one desk run, not one per tick", async () => {
    const h = harness(cfg(mandate(), { rules: { defenseBudgetSol: 1, maxDefenseSpendPerDaySol: 1 } }));
    await warm(h);
    const runs = () => h.ledger.listEvents("d1", { types: ["desk_decision", "desk_escalation"], limit: 500 }).length;
    const after1 = runs();
    for (let i = 0; i < 30; i++) {
      h.advance(10_000);
      await h.runner.tick();
    }
    expect(runs()).toBe(after1);
  });

  it("a reload that fails is retried instead of marked failed", async () => {
    let calls = 0;
    const h = harness(cfg(), {
      reload: (id) => {
        calls++;
        if (calls === 1) throw new Error("half-written file");
        return h.ledger.getProject(id)!;
      },
    });
    h.ledger.enqueueCommand("d1", "reload");
    await h.runner.tick();
    expect(h.ledger.pendingCommands().some((c) => c.type === "reload")).toBe(true);
    h.advance(10_000);
    await h.runner.tick();
    expect(h.ledger.pendingCommands().some((c) => c.type === "reload")).toBe(false);
  });
});

describe("ledger queries the desk relies on", () => {
  it("listEvents filters by type before the limit, and snapshotsSince keeps the newest rows", () => {
    const ledger = new Ledger(":memory:");
    ledger.upsertProject(cfg());
    ledger.insertEvent({ type: "daily_report", projectId: "d1", ts: T0 - HOUR, data: {} });
    for (let i = 0; i < 100; i++) ledger.insertEvent({ type: "order_filled", projectId: "d1", ts: T0 - HOUR + i * 1000, data: {} });
    expect(ledger.listEvents("d1", { types: ["daily_report"], limit: 1 })).toHaveLength(1);
    for (let i = 0; i < 50; i++) ledger.insertSnapshot(snap({ ts: T0 - 50 * MINUTE + i * MINUTE }));
    const some = ledger.snapshotsSince("d1", T0 - DAY, 10);
    expect(some).toHaveLength(10);
    expect(some[some.length - 1]!.ts).toBe(T0 - MINUTE);
    expect(some[0]!.ts).toBeLessThan(some[9]!.ts);
    const until = ledger.snapshotsSince("d1", T0 - DAY, 1000, T0 - 30 * MINUTE);
    expect(until.every((s) => s.ts <= T0 - 30 * MINUTE)).toBe(true);
  });
});
