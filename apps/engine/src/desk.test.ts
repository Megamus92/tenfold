import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, DEFAULT_STRATEGY, Ledger, PROFILES, parseProjectConfig, seededRng, solToLamports, strategyFromMandate, tokensToBase } from "@tenfold/core";
import type { Mandate, Order, ProjectConfig, RollingState, Snapshot } from "@tenfold/core";
import { DESK_INTERVAL_MS, decide, median } from "./desk.js";
import type { DeskInput } from "./desk.js";
import { ProjectRunner } from "./runner.js";
import type { Executor, PriceFeed } from "./runner.js";

const MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const DEC = 6;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date(2026, 10, 4, 12, 0, 0).getTime();

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

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return { projectId: "d1", ts: T0, price: 0.0002, buyFlow5mSol: 1, sellFlow5mSol: 1, vaultTokens: tokensToBase(1_000_000, DEC), vaultLamports: solToLamports(40), liquiditySol: 200, ...over };
}

function rolling(over: Partial<RollingState> = {}): RollingState {
  return { soldLast24h: 0n, defenseSpentLast24hLamports: 0n, defenseSpentTotalLamports: 0n, ordersLastHour: 0, price5mAgo: 0.0002, ...over };
}

/** A flat hour of history at `price`, one snapshot per 5 minutes, ending just before T0. */
function history(price: number, opts: { hours?: number; liquiditySol?: number; buy?: number; sell?: number } = {}): Snapshot[] {
  const out: Snapshot[] = [];
  const hours = opts.hours ?? 1;
  for (let t = T0 - hours * HOUR; t < T0; t += 5 * 60_000) {
    out.push(snap({ ts: t, price, liquiditySol: opts.liquiditySol ?? 200, buyFlow5mSol: opts.buy ?? 1, sellFlow5mSol: opts.sell ?? 1 }));
  }
  return out;
}

function input(over: Partial<DeskInput> = {}): DeskInput {
  return { cfg: cfg(), snapshot: snap(), rolling: rolling(), now: T0, history: history(0.0002), recentOrders: [], distributedSinceStart: 0n, insiderSellRecent: false, ...over };
}

function kinds(out: ReturnType<typeof decide>): string[] {
  return out.decisions.map((d) => d.change.kind);
}

describe("desk manager: decide", () => {
  it("does nothing without a mandate", () => {
    const out = decide(input({ cfg: cfg(null) }));
    expect(out.decisions).toEqual([]);
    expect(out.escalations).toEqual([]);
  });

  it("median handles odd, even and empty lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeUndefined();
  });

  it("on a fresh balanced mandate it records the start, places one level under the 1h reference and sets the pace", () => {
    const out = decide(input());
    expect(kinds(out)).toContain("mandate_started");
    expect(out.mandate.startTokens).toBe(tokensToBase(1_000_000, DEC).toString());
    const placed = out.decisions.find((d) => d.change.kind === "place_level");
    expect(placed).toBeDefined();
    if (placed?.change.kind !== "place_level") throw new Error("unreachable");
    expect(placed.change.price).toBeCloseTo(0.0002 * (1 - PROFILES.balanced.levelDistancePct / 100), 10);
    // budget: min(pool x share, max(dayLeft, 0.5)) = min(20 x 0.6, 5) = 5
    expect(placed.change.budgetSol).toBe(5);
    expect(out.strategy.defense.levels).toHaveLength(1);
    expect(out.strategy.distribution.enabled).toBe(true);
    expect(out.strategy.distribution.pctOfVaultPerDay).toBeGreaterThan(0);
    expect(out.strategy.distribution.pctOfVaultPerDay).toBeLessThanOrEqual(DEFAULT_RULES.dailySellCapPct);
    expect(out.strategy.distribution.strengthBoost).toBe(PROFILES.balanced.strengthBoost);
    for (const d of out.decisions) expect(d.why.length).toBeGreaterThan(10);
  });

  it("the protect profile keeps two levels, the second one a step lower", () => {
    const c = cfg(mandate({ profile: "protect" }));
    const out = decide(input({ cfg: c }));
    const prices = out.strategy.defense.levels.map((l) => l.price);
    expect(prices).toHaveLength(2);
    const dist = PROFILES.protect.levelDistancePct / 100;
    expect(prices[0]).toBeCloseTo(0.0002 * (1 - dist), 10);
    expect(prices[1]).toBeCloseTo(0.0002 * (1 - 2 * dist), 10);
  });

  it("removes a lost level and re-places it lower, immediately", () => {
    const c = cfg();
    c.strategy.defense.levels = [{ price: 0.0002, budgetSol: 5 }];
    c.mandate!.startTokens = "1";
    const out = decide(input({ cfg: c, snapshot: snap({ price: 0.00016 }), history: history(0.00016), lastLevelChangeAt: T0 - 60_000 }));
    expect(kinds(out)).toContain("remove_level");
    expect(kinds(out)).toContain("place_level");
    expect(out.strategy.defense.levels.every((l) => l.price < 0.00016)).toBe(true);
    expect(out.decisions.find((d) => d.change.kind === "remove_level")?.why).toMatch(/lost/);
  });

  it("lets a level breathe when holding it would burn today's budget in under the profile's hours", () => {
    const c = cfg();
    c.strategy.defense.levels = [{ price: 0.0002, budgetSol: 5 }];
    c.mandate!.startTokens = "1";
    // sell flow 1 SOL/5min over buys 0.1: burn = 0.9 x 12 = 10.8 SOL/h, day budget 5 SOL → under 1 h
    const s = snap({ price: 0.0002, sellFlow5mSol: 1, buyFlow5mSol: 0.1 });
    const out = decide(input({ cfg: c, snapshot: s, history: history(0.0002, { sell: 1, buy: 0.1 }) }));
    const removed = out.decisions.find((d) => d.change.kind === "remove_level");
    expect(removed?.why).toMatch(/breathe/);
    const placed = out.decisions.find((d) => d.change.kind === "place_level");
    if (placed?.change.kind !== "place_level") throw new Error("expected a lower level");
    // stepped down: two distance steps under the reference
    expect(placed.change.price).toBeCloseTo(0.0002 * (1 - 2 * PROFILES.balanced.levelDistancePct / 100), 10);
  });

  it("rests the defense and escalates once the budget is used up", () => {
    const c = cfg();
    c.strategy.defense.levels = [{ price: 0.00019, budgetSol: 5 }];
    c.mandate!.startTokens = "1";
    const out = decide(input({ cfg: c, rolling: rolling({ defenseSpentTotalLamports: solToLamports(19.8) }) }));
    expect(out.strategy.defense.levels).toEqual([]);
    expect(out.escalations.map((e) => e.topic)).toContain("budget_top_up");
    expect(kinds(out)).not.toContain("place_level");
  });

  it("never touches a pinned level", () => {
    const c = cfg();
    c.strategy.defense.levels = [{ price: 0.0001, budgetSol: 3, pinned: true }];
    c.mandate!.startTokens = "1";
    const out = decide(input({ cfg: c, snapshot: snap({ price: 0.00005 }), history: history(0.00005) }));
    expect(out.strategy.defense.levels.find((l) => l.pinned)?.price).toBe(0.0001);
    expect(out.decisions.filter((d) => d.change.kind === "remove_level")).toEqual([]);
  });

  it("trails a level up after the price has held well above it for the profile's hours", () => {
    const c = cfg();
    c.strategy.defense.levels = [{ price: 0.0001, budgetSol: 5 }];
    c.mandate!.startTokens = "1";
    const out = decide(input({ cfg: c, snapshot: snap({ price: 0.0002 }), history: history(0.0002, { hours: 4 }), lastLevelChangeAt: T0 - 60_000 }));
    const moved = out.decisions.find((d) => d.change.kind === "move_level");
    expect(moved).toBeDefined();
    if (moved?.change.kind !== "move_level") throw new Error("unreachable");
    expect(moved.change.to).toBeCloseTo(0.0002 * (1 - PROFILES.balanced.levelDistancePct / 100), 10);
    expect(out.strategy.defense.levels[0]!.price).toBeCloseTo(moved.change.to, 10);
  });

  it("halves the pace when sellers dominate the hour and lifts it when buyers do", () => {
    const c = cfg();
    c.mandate!.startTokens = tokensToBase(1_000_000, DEC).toString();
    const base = c.strategy.distribution.pctOfVaultPerDay;
    const down = decide(input({ cfg: c, history: history(0.0002, { sell: 2, buy: 0.5 }), snapshot: snap({ sellFlow5mSol: 2, buyFlow5mSol: 0.5 }), lastLevelChangeAt: T0 }));
    expect(down.strategy.distribution.pctOfVaultPerDay).toBeLessThan(base);
    expect(down.decisions.find((d) => d.change.kind === "set_pace")?.why).toMatch(/sellers dominate/);
    const c2 = cfg(mandate({ distributePct: 5, horizonDays: 40 }));
    c2.mandate!.startTokens = tokensToBase(1_000_000, DEC).toString();
    const up = decide(input({ cfg: c2, history: history(0.0002, { sell: 0.5, buy: 2 }), snapshot: snap({ sellFlow5mSol: 0.5, buyFlow5mSol: 2 }), lastLevelChangeAt: T0 }));
    expect(up.strategy.distribution.pctOfVaultPerDay).toBeGreaterThan(c2.strategy.distribution.pctOfVaultPerDay);
  });

  it("stops adding supply after a team wallet sold, and says so", () => {
    const c = cfg();
    c.mandate!.startTokens = "1000000000000";
    const out = decide(input({ cfg: c, insiderSellRecent: true, lastLevelChangeAt: T0 }));
    expect(out.strategy.distribution.enabled).toBe(false);
    expect(out.escalations.map((e) => e.topic)).toContain("insider_sell");
  });

  it("turns distribution off when the mandate's share is distributed", () => {
    const c = cfg(mandate({ distributePct: 10, horizonDays: 10 }));
    c.mandate!.startTokens = tokensToBase(1_000_000, DEC).toString();
    const out = decide(input({ cfg: c, distributedSinceStart: tokensToBase(100_000, DEC), lastLevelChangeAt: T0 }));
    expect(kinds(out)).toContain("distribution_done");
    expect(out.strategy.distribution.enabled).toBe(false);
    expect(out.escalations.map((e) => e.topic)).toContain("target_reached");
  });

  it("escalates a horizon the daily cap cannot reach", () => {
    const c = cfg(mandate({ distributePct: 100, horizonDays: 10 }));
    const out = decide(input({ cfg: c }));
    const e = out.escalations.find((x) => x.topic === "horizon_unreachable");
    expect(e?.why).toMatch(/takes about 200 days, not 10/);
    expect(out.strategy.distribution.pctOfVaultPerDay).toBeLessThanOrEqual(DEFAULT_RULES.dailySellCapPct);
  });

  it("pauses everything on a liquidity pull and asks the founder", () => {
    const out = decide(input({ snapshot: snap({ liquiditySol: 60 }), history: history(0.0002, { liquiditySol: 200 }) }));
    expect(out.pause?.why).toMatch(/liquidity/i);
    expect(kinds(out)).toContain("pause");
    expect(out.escalations.map((e) => e.topic)).toContain("liquidity_pull");
  });

  it("tells the founder once when price sits under the alert floor and halves the pace", () => {
    const c = cfg(mandate({ alertFloor: 0.0003 }));
    c.mandate!.startTokens = "1000000000000";
    const out = decide(input({ cfg: c, lastLevelChangeAt: T0 }));
    expect(out.escalations.map((e) => e.topic)).toContain("under_alert_floor");
    expect(out.decisions.find((d) => d.change.kind === "set_pace")?.why).toMatch(/alert floor/);
  });
});

// ---------- runner integration ----------

class Feed implements PriceFeed {
  price = 0.0002;
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

describe("desk manager in the runner", () => {
  it("auto: applies decisions, persists them and writes desk_decision events; re-runs only after the interval", async () => {
    const ledger = new Ledger(":memory:");
    const c = cfg();
    ledger.upsertProject(c);
    let now = T0;
    const saved: ProjectConfig[] = [];
    const runner = new ProjectRunner({ ledger, feed: new Feed(), executor: new NoExec(), rng: seededRng(1), cfg: c, now: () => now, persistConfig: (x) => saved.push(x) });
    await runner.tick();
    const events = ledger.listEvents("d1", { types: ["desk_decision"], limit: 50 });
    expect(events.map((e) => e.data.kind)).toContain("place_level");
    expect(runner.cfg.strategy.defense.levels).toHaveLength(1);
    expect(runner.cfg.mandate?.startTokens).toBeDefined();
    expect(saved.length).toBeGreaterThan(0);
    expect(ledger.getProject("d1")?.strategy.defense.levels).toHaveLength(1);
    // a second tick inside the interval changes nothing
    now += 60_000;
    await runner.tick();
    expect(ledger.listEvents("d1", { types: ["desk_decision"], limit: 50 }).length).toBe(events.length);
    // after the interval with a flat market, still nothing new to decide
    now += DESK_INTERVAL_MS;
    await runner.tick();
    expect(ledger.listEvents("d1", { types: ["desk_decision"], limit: 50 }).length).toBe(events.length);
  });

  it("ask: proposes only, nothing is applied", async () => {
    const ledger = new Ledger(":memory:");
    const c = cfg(mandate({ autonomy: "ask" }));
    ledger.upsertProject(c);
    const runner = new ProjectRunner({ ledger, feed: new Feed(), executor: new NoExec(), rng: seededRng(1), cfg: c, now: () => T0, persistConfig: () => undefined });
    await runner.tick();
    expect(ledger.listEvents("d1", { types: ["desk_proposal"], limit: 50 }).length).toBeGreaterThan(0);
    expect(ledger.listEvents("d1", { types: ["desk_decision"], limit: 50 })).toEqual([]);
    expect(runner.cfg.strategy.defense.levels).toEqual([]);
  });

  it("a lost level forces a desk run before the interval, and a liquidity pull pauses the project", async () => {
    const ledger = new Ledger(":memory:");
    const c = cfg();
    ledger.upsertProject(c);
    let now = T0;
    const feed = new Feed();
    const runner = new ProjectRunner({ ledger, feed, executor: new NoExec(), rng: seededRng(1), cfg: c, now: () => now, persistConfig: () => undefined });
    await runner.tick();
    const level = runner.cfg.strategy.defense.levels[0]!.price;
    now += 60_000;
    feed.price = level * 0.8; // 20% under: lost
    await runner.tick();
    expect(runner.cfg.strategy.defense.levels.every((l) => l.price < feed.price)).toBe(true);
    // liquidity vanishes over the next hour
    for (let i = 0; i < 13; i++) {
      now += 5 * 60_000;
      await runner.tick();
    }
    feed.liquidity = 40;
    now += DESK_INTERVAL_MS;
    await runner.tick();
    expect(runner.cfg.paused).toBe(true);
    const esc = ledger.listEvents("d1", { types: ["desk_escalation"], limit: 50 }).map((e) => e.data.topic);
    expect(esc).toContain("liquidity_pull");
    const paused = ledger.listEvents("d1", { types: ["paused"], limit: 5 })[0];
    expect(paused?.data.by).toBe("desk");
  });
});
