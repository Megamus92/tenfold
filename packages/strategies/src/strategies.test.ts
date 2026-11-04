import { describe, it, expect } from "vitest";
import { assess, dailyCapAmount, seededRng, solToLamports, tokensToBase } from "@tenfold/core";
import type { Order, Snapshot } from "@tenfold/core";
import { proposeDistribution, scheduleAllowance, strengthSignal, strengthIntensity } from "./distribution.js";
import { proposeDefense, DEF_MIN_GAP_MS } from "./defense.js";
import { proposeRebalance } from "./rebalance.js";
import { detectBudgetLow, detectCapReached, detectLevelHit, detectSellPressure } from "./pressure.js";
import { allStrategies } from "./index.js";
import { localDayStart } from "./util.js";
import type { StrategyInput } from "./types.js";
import { DECIMALS, FakeExecutor, FakeFeed, priceSeries, testConfig, testRolling, testSnapshot, toOrder } from "./testutil.js";

const TICK_MS = 10_000;
const DAY_MS = 86_400_000;

function baseInput(over: Partial<StrategyInput> = {}): StrategyInput {
  return {
    cfg: testConfig(),
    snapshot: testSnapshot(),
    rolling: testRolling(),
    now: 1_000_000_000_000,
    rng: seededRng(1),
    lastOrders: [],
    ...over,
  };
}

describe("DIST strength mode over a simulated day", () => {
  it("sells only on up-moves with dominant buy flow and never exceeds the daily cap", () => {
    const cfg = testConfig({
      rules: { dailySellCapPct: 0.5 },
      strategy: { distribution: { enabled: true, pctOfVaultPerDay: 0.5, mode: "strength" } },
    });
    const rng = seededRng(42);
    const steps = DAY_MS / TICK_MS; // 8640 ticks of 10 s
    const prices = priceSeries(seededRng(7), 0.0002, steps, 0.00002, 0.004);
    const feed = new FakeFeed(tokensToBase(1_000_000, DECIMALS), solToLamports(50));
    const exec = new FakeExecutor();
    const start = localDayStart(1_700_000_000_000);
    const orders: Order[] = [];
    const initialTokens = feed.vaultTokens;
    const capAmount = dailyCapAmount(cfg, feed.snapshot(prices[0]!, 1, 1, start), testRolling());

    let violations = 0;
    for (let i = 0; i < steps; i++) {
      const now = start + i * TICK_MS;
      const price = prices[i]!;
      const ret = i > 0 ? price / prices[i - 1]! - 1 : 0;
      // flow leans with the last move: up-ticks show more buys than sells
      const tilt = Math.max(-0.9, Math.min(0.9, ret / 0.004 / 2));
      const total = 2 * (0.5 + rng.next());
      const buyFlow = total * (0.5 + tilt / 2);
      const sellFlow = total - buyFlow;
      const snapshot = feed.snapshot(price, buyFlow, sellFlow, now);
      const recentPrices = prices.slice(Math.max(0, i - 89), i + 1);
      const lastOrders = orders.filter((o) => o.createdAt > now - DAY_MS);
      const soldLast24h = exec.fills.filter((f) => f.side === "sell" && f.ts > now - DAY_MS).reduce((a, f) => a + f.inAmount, 0n);
      const rolling = testRolling({ soldLast24h });
      const input: StrategyInput = { cfg, snapshot, rolling, now, rng, lastOrders, recentPrices };

      const proposals = proposeDistribution(input);
      expect(proposals.length).toBeLessThanOrEqual(1);
      for (const p of proposals) {
        expect(p.side).toBe("sell");
        expect(p.reason).toBe("DIST");
        // strength conditions must hold at proposal time
        if (!(buyFlow > sellFlow * 1.2)) violations++;
        const mean = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
        if (price < mean) violations++;
        const verdict = assess(p, { cfg, snapshot, rolling, now });
        expect(verdict.ok).toBe(true);
        const order = toOrder(p, "approved", now);
        const fill = exec.execute(order, snapshot, now);
        feed.applyFill(fill);
        orders.unshift({ ...order, status: "filled" });
      }
    }

    const sold = exec.fills.reduce((a, f) => a + f.inAmount, 0n);
    expect(violations).toBe(0);
    expect(exec.fills.length).toBeGreaterThan(5);
    expect(sold).toBeLessThanOrEqual(capAmount);
    expect(sold).toBeLessThanOrEqual((initialTokens * 50n) / 10_000n);
    expect(feed.vaultTokens).toBe(initialTokens - sold);
    // every fill is a sell: DIST never buys
    expect(exec.fills.every((f) => f.side === "sell")).toBe(true);
    // consecutive DIST orders are spaced by at least the jittered minimum gap
    for (let i = 1; i < exec.fills.length; i++) {
      expect(exec.fills[i]!.ts - exec.fills[i - 1]!.ts).toBeGreaterThanOrEqual(45_000 * (1 - cfg.strategy.clip.jitterPct) - TICK_MS);
    }
  });

  it("leans into a strong real up-move: bigger clip, still bounded by the cap", () => {
    // A hard green candle (price well above 5m ago) with dominant buy flow and room under a wide cap.
    const now = localDayStart(1_700_000_000_000) + Math.floor(0.9 * DAY_MS);
    const base = {
      rules: { dailySellCapPct: 10, circuitBreakerMovePct: 40 },
      strategy: { distribution: { enabled: true, pctOfVaultPerDay: 10, mode: "strength" as const } },
    };
    const snapshot = testSnapshot({ price: 0.00026, buyFlow5mSol: 6, sellFlow5mSol: 1 });
    const rolling = testRolling({ price5mAgo: 0.0002 }); // +30% in 5 minutes
    const recentPrices = [0.0002, 0.00021, 0.00022, 0.00024, 0.00026];

    const flat = proposeDistribution({ cfg: testConfig(base), snapshot, rolling, now, rng: seededRng(5), lastOrders: [], recentPrices });
    const boostCfg = testConfig({ ...base, strategy: { distribution: { ...base.strategy.distribution, strengthBoost: 4 } } });
    const boosted = proposeDistribution({ cfg: boostCfg, snapshot, rolling, now, rng: seededRng(5), lastOrders: [], recentPrices });

    expect(flat).toHaveLength(1);
    expect(boosted).toHaveLength(1);
    // same seed, so the only difference is the strength multiplier: the boosted clip is materially larger
    expect(boosted[0]!.amountIn).toBeGreaterThan(flat[0]!.amountIn);
    // intensity is high on a near-breaker up-move with 6:1 buy flow
    expect(strengthIntensity({ cfg: boostCfg, snapshot, rolling })).toBeGreaterThan(0.7);
    // even boosted, it never exceeds the daily cap
    const cap = dailyCapAmount(boostCfg, snapshot, rolling);
    const verdict = assess(boosted[0]!, { cfg: boostCfg, snapshot, rolling, now });
    expect(verdict.ok).toBe(true);
    expect(boosted[0]!.amountIn).toBeLessThanOrEqual(cap);
  });

  it("does not boost when there is no up-move (no manufactured demand)", () => {
    const boostCfg = testConfig({
      strategy: { distribution: { enabled: true, pctOfVaultPerDay: 1, mode: "strength", strengthBoost: 4 } },
    });
    // flat price, only mild buy dominance: intensity near zero, so it behaves like boost 1
    const snapshot = testSnapshot({ price: 0.0002, buyFlow5mSol: 1.3, sellFlow5mSol: 1 });
    const rolling = testRolling({ price5mAgo: 0.0002 });
    expect(strengthIntensity({ cfg: boostCfg, snapshot, rolling })).toBeLessThan(0.15);
  });

  it("stays silent when the cap is used up, even with a strength signal", () => {
    const cfg = testConfig({ rules: { dailySellCapPct: 0.5 }, strategy: { distribution: { enabled: true, pctOfVaultPerDay: 0.5, mode: "strength" } } });
    const snapshot = testSnapshot({ buyFlow5mSol: 3, sellFlow5mSol: 1, vaultTokens: tokensToBase(995_000, DECIMALS) });
    const rolling = testRolling({ soldLast24h: tokensToBase(5_000, DECIMALS) });
    const input = baseInput({ cfg, snapshot, rolling, recentPrices: [0.00019, 0.000195, 0.0002] });
    expect(proposeDistribution(input)).toEqual([]);
  });

  it("does not sell into weakness or below the 15-minute mean", () => {
    const cfg = testConfig({ strategy: { distribution: { enabled: true, pctOfVaultPerDay: 0.5, mode: "strength" } } });
    const weak = baseInput({ cfg, snapshot: testSnapshot({ buyFlow5mSol: 1, sellFlow5mSol: 1 }), recentPrices: [0.00019, 0.0002] });
    expect(proposeDistribution(weak)).toEqual([]);
    const belowMean = baseInput({ cfg, snapshot: testSnapshot({ buyFlow5mSol: 3, sellFlow5mSol: 1, price: 0.00018 }), recentPrices: [0.0002, 0.00021] });
    expect(proposeDistribution(belowMean)).toEqual([]);
    expect(strengthSignal({ snapshot: testSnapshot({ buyFlow5mSol: 3, sellFlow5mSol: 1 }), recentPrices: undefined })).toBe(false);
  });

  it("never sells within 1% above an active defense level", () => {
    const cfg = testConfig({
      strategy: {
        defense: { enabled: true, levels: [{ price: 0.000199, budgetSol: 2 }] },
        distribution: { enabled: true, pctOfVaultPerDay: 0.5, mode: "strength" },
      },
    });
    const snapshot = testSnapshot({ price: 0.0002, buyFlow5mSol: 3, sellFlow5mSol: 1 });
    const input = baseInput({ cfg, snapshot, recentPrices: [0.00019, 0.0002] });
    expect(proposeDistribution(input)).toEqual([]);
    // well above the level it sells again
    const clear = baseInput({ cfg, snapshot: testSnapshot({ price: 0.00021, buyFlow5mSol: 3, sellFlow5mSol: 1 }), recentPrices: [0.0002, 0.00021] });
    expect(proposeDistribution(clear)).toHaveLength(1);
    // a level whose budget is spent but that was defended in the last 24h still blocks selling into it
    const now = clear.now;
    const spentDef = toOrder(
      { projectId: "test", side: "buy", reason: "DEF", inputMint: "So11111111111111111111111111111111111111112", outputMint: cfg.mint, amountIn: solToLamports(2), maxSlippageBps: 100, refPrice: 0.000199, note: "level:0.000199 under" },
      "filled",
      now - 3 * 3_600_000,
    );
    const stillGuarded = baseInput({ cfg, now, snapshot, recentPrices: [0.00019, 0.0002], lastOrders: [spentDef], rolling: testRolling({ defenseSpentTotalLamports: solToLamports(2) }) });
    expect(proposeDistribution(stillGuarded)).toEqual([]);
  });

  it("respects minPrice", () => {
    const cfg = testConfig({ strategy: { distribution: { enabled: true, pctOfVaultPerDay: 0.5, mode: "strength", minPrice: 0.0003 } } });
    const input = baseInput({ cfg, snapshot: testSnapshot({ buyFlow5mSol: 3, sellFlow5mSol: 1 }), recentPrices: [0.00019, 0.0002] });
    expect(proposeDistribution(input)).toEqual([]);
  });

  it("twap mode keeps progress on the day's schedule", () => {
    const cfg = testConfig({ rules: { dailySellCapPct: 1 }, strategy: { distribution: { enabled: true, pctOfVaultPerDay: 1, mode: "twap" }, clip: { minSol: 5, maxSol: 5, jitterPct: 0 } } });
    const dayStart = localDayStart(1_700_000_000_000);
    const quarter = dayStart + DAY_MS / 4;
    const snapshot = testSnapshot({ buyFlow5mSol: 0, sellFlow5mSol: 0 });
    const target = tokensToBase(10_000, DECIMALS); // 1% of 1,000,000
    const p = proposeDistribution(baseInput({ cfg, snapshot, now: quarter }));
    expect(p).toHaveLength(1);
    // a 5 SOL clip would be 25,000 tokens, but at a quarter of the day only 2,500 are allowed
    expect(p[0]!.amountIn).toBe(target / 4n);
    // once a quarter of the target is sold today, nothing more until time passes
    const sold = toOrder(p[0]!, "filled", quarter - 60_000);
    const afterSell = testSnapshot({ buyFlow5mSol: 0, sellFlow5mSol: 0, vaultTokens: snapshot.vaultTokens - sold.amountIn });
    expect(proposeDistribution(baseInput({ cfg, snapshot: afterSell, now: quarter, lastOrders: [sold], rolling: testRolling({ soldLast24h: sold.amountIn }) }))).toEqual([]);
    expect(scheduleAllowance(target, target / 4n, quarter, "twap")).toBe(0n);
    expect(scheduleAllowance(target, target / 4n, dayStart + DAY_MS / 2, "twap")).toBe(target / 4n);
  });

  it("never sells within five minutes of an own buy", () => {
    const cfg = testConfig({ strategy: { distribution: { enabled: true, pctOfVaultPerDay: 0.5, mode: "strength" }, rebalance: { enabled: true } } });
    const now = 1_000_000_000_000;
    const buy = toOrder(
      { projectId: "test", side: "buy", reason: "REB", inputMint: "So11111111111111111111111111111111111111112", outputMint: cfg.mint, amountIn: solToLamports(0.1), maxSlippageBps: 100, refPrice: 0.0002, note: "x" },
      "filled",
      now - 60_000,
    );
    const input = baseInput({ cfg, now, snapshot: testSnapshot({ buyFlow5mSol: 3, sellFlow5mSol: 1 }), recentPrices: [0.00019, 0.0002], lastOrders: [buy] });
    expect(proposeDistribution(input)).toEqual([]);
  });
});

describe("DEF level defense", () => {
  it("buys at the level and stops when the level budget is spent", () => {
    const cfg = testConfig({
      rules: { defenseBudgetSol: 10, maxDefenseSpendPerDaySol: 10 },
      strategy: { defense: { enabled: true, levels: [{ price: 0.0002, budgetSol: 1 }] }, clip: { minSol: 0.05, maxSol: 0.2, jitterPct: 0.35 } },
    });
    const rng = seededRng(3);
    const feed = new FakeFeed(tokensToBase(1_000_000, DECIMALS), solToLamports(50));
    const exec = new FakeExecutor();
    const orders: Order[] = [];
    const start = 1_700_000_000_000;
    let spent = 0n;
    let lastFillTs = -Infinity;
    let minGap = Infinity;
    for (let i = 0; i < 1200; i++) {
      const now = start + i * 1_000; // 1 s ticks, price pinned just under the level under sell pressure
      const snapshot = feed.snapshot(0.000199, 0.5, 2, now);
      const rolling = testRolling({ defenseSpentLast24hLamports: spent, defenseSpentTotalLamports: spent });
      const proposals = proposeDefense({ cfg, snapshot, rolling, now, rng, lastOrders: orders });
      expect(proposals.length).toBeLessThanOrEqual(1);
      for (const p of proposals) {
        expect(p.side).toBe("buy");
        expect(p.reason).toBe("DEF");
        expect(p.note.startsWith("level:0.0002")).toBe(true);
        const verdict = assess(p, { cfg, snapshot, rolling, now });
        expect(verdict.ok).toBe(true);
        const order = toOrder(p, "approved", now);
        const fill = exec.execute(order, snapshot, now);
        feed.applyFill(fill);
        spent += fill.inAmount;
        if (Number.isFinite(lastFillTs)) minGap = Math.min(minGap, now - lastFillTs);
        lastFillTs = now;
        orders.unshift({ ...order, status: "filled" });
      }
    }
    expect(exec.fills.length).toBeGreaterThan(4);
    expect(spent).toBeLessThanOrEqual(solToLamports(1));
    expect(spent).toBeGreaterThan(solToLamports(0.99)); // the last clip is resized to what is left
    expect(minGap).toBeGreaterThanOrEqual(DEF_MIN_GAP_MS * (1 - 0.35));
    // budget spent: silent from now on
    const after = proposeDefense({ cfg, snapshot: feed.snapshot(0.000199, 0.5, 2, start + 2_000_000), rolling: testRolling({ defenseSpentTotalLamports: spent, defenseSpentLast24hLamports: spent }), now: start + 2_000_000, rng, lastOrders: orders });
    expect(after).toEqual([]);
  });

  it("stays quiet above the level when nobody is selling, and when the price is well above it", () => {
    const cfg = testConfig({ strategy: { defense: { enabled: true, levels: [{ price: 0.0002, budgetSol: 1 }] } } });
    expect(proposeDefense(baseInput({ cfg, snapshot: testSnapshot({ price: 0.0002005, sellFlow5mSol: 0, buyFlow5mSol: 1 }) }))).toEqual([]);
    expect(proposeDefense(baseInput({ cfg, snapshot: testSnapshot({ price: 0.00025, sellFlow5mSol: 5 }) }))).toEqual([]);
    // just above the level with sellers present: defend
    expect(proposeDefense(baseInput({ cfg, snapshot: testSnapshot({ price: 0.0002005, sellFlow5mSol: 2 }) }))).toHaveLength(1);
  });

  it("is capped by the project budget, the daily limit and the vault balance", () => {
    const cfg = testConfig({
      rules: { defenseBudgetSol: 0.3, maxDefenseSpendPerDaySol: 0.1 },
      strategy: { defense: { enabled: true, levels: [{ price: 0.0002, budgetSol: 5 }] }, clip: { minSol: 1, maxSol: 1, jitterPct: 0 } },
    });
    const p = proposeDefense(baseInput({ cfg, snapshot: testSnapshot({ price: 0.00019, sellFlow5mSol: 2 }) }));
    expect(p).toHaveLength(1);
    expect(p[0]!.amountIn).toBe(solToLamports(0.1));
    const poor = proposeDefense(baseInput({ cfg, snapshot: testSnapshot({ price: 0.00019, sellFlow5mSol: 2, vaultLamports: solToLamports(0.05) }) }));
    expect(poor[0]!.amountIn).toBe(solToLamports(0.04)); // 0.05 minus the 0.01 fee reserve
  });

  it("never buys within five minutes of an own sell", () => {
    const cfg = testConfig({ strategy: { defense: { enabled: true, levels: [{ price: 0.0002, budgetSol: 1 }] } } });
    const now = 1_000_000_000_000;
    const sell = toOrder(
      { projectId: "test", side: "sell", reason: "DIST", inputMint: cfg.mint, outputMint: "So11111111111111111111111111111111111111112", amountIn: 1_000_000n, maxSlippageBps: 100, refPrice: 0.0002, note: "x" },
      "filled",
      now - 120_000,
    );
    expect(proposeDefense(baseInput({ cfg, now, snapshot: testSnapshot({ price: 0.00019, sellFlow5mSol: 2 }), lastOrders: [sell] }))).toEqual([]);
  });
});

describe("REB inventory rebalance", () => {
  // 50 SOL + 1,000,000 tokens at 0.0002 = 200 SOL of tokens: SOL share 20%
  it("stays silent inside the band", () => {
    const cfg = testConfig({ strategy: { rebalance: { enabled: true, targetSolShare: 0.25, band: 0.1 } } });
    expect(proposeRebalance(baseInput({ cfg }))).toEqual([]);
  });

  it("sells a quarter of the gap when SOL is short, within the cap and one clip", () => {
    // clip.maxSol raised above the quarter-gap so the gap logic is what binds here
    const cfg = testConfig({ rules: { dailySellCapPct: 20 }, strategy: { rebalance: { enabled: true, targetSolShare: 0.5, band: 0.1 }, clip: { maxSol: 50 } } });
    const p = proposeRebalance(baseInput({ cfg }));
    expect(p).toHaveLength(1);
    expect(p[0]!.side).toBe("sell");
    expect(p[0]!.reason).toBe("REB");
    // gap 30% of 250 SOL = 75 SOL, a quarter is 18.75 SOL = 93,750 tokens
    expect(p[0]!.amountIn).toBe(tokensToBase(93_750, DECIMALS));
    const tight = testConfig({ rules: { dailySellCapPct: 0.5 }, strategy: { rebalance: { enabled: true, targetSolShare: 0.5, band: 0.1 }, clip: { maxSol: 50 } } });
    const capped = proposeRebalance(baseInput({ cfg: tight }));
    expect(capped[0]!.amountIn).toBe(tokensToBase(5_000, DECIMALS));
  });

  it("never sells more than one clip in a single rebalance order", () => {
    // default clip.maxSol 0.5: the 18.75 SOL quarter-gap is capped to 0.5 SOL = 2,500 tokens, no market-moving step
    const cfg = testConfig({ rules: { dailySellCapPct: 20 }, strategy: { rebalance: { enabled: true, targetSolShare: 0.5, band: 0.1 } } });
    const p = proposeRebalance(baseInput({ cfg }));
    expect(p[0]!.amountIn).toBe(tokensToBase(2_500, DECIMALS));
  });

  it("buys a quarter of the gap when SOL is in excess, within one clip", () => {
    const cfg = testConfig({ strategy: { rebalance: { enabled: true, targetSolShare: 0.1, band: 0.05 }, clip: { maxSol: 50 } } });
    const p = proposeRebalance(baseInput({ cfg }));
    expect(p).toHaveLength(1);
    expect(p[0]!.side).toBe("buy");
    // gap 10% of 250 SOL = 25 SOL, a quarter is 6.25 SOL
    expect(p[0]!.amountIn).toBe(solToLamports(6.25));
  });

  it("under a mandate a rebalance sell obeys the stops that hold distribution; buys are unaffected", () => {
    const sellCfg = testConfig({ rules: { dailySellCapPct: 20 }, strategy: { rebalance: { enabled: true, targetSolShare: 0.5, band: 0.1 }, clip: { maxSol: 50 } } });
    const mandate = { profile: "balanced" as const, autonomy: "auto" as const, startedAt: 0 };
    // distribution switched off by the desk (team-wallet sell, own share, liquidity, target reached): no REB sell
    expect(proposeRebalance(baseInput({ cfg: { ...sellCfg, mandate, strategy: { ...sellCfg.strategy, distribution: { ...sellCfg.strategy.distribution, enabled: false } } } }))).toEqual([]);
    // under the mandate's alert line: no REB sell
    const on = { ...sellCfg, mandate: { ...mandate, alertFloor: 0.0003 }, strategy: { ...sellCfg.strategy, distribution: { ...sellCfg.strategy.distribution, enabled: true } } };
    expect(proposeRebalance(baseInput({ cfg: on }))).toEqual([]);
    // distribution on and price above the line: the sell goes through
    const ok = { ...on, mandate: { ...mandate, alertFloor: 0.0001 } };
    expect(proposeRebalance(baseInput({ cfg: ok }))).toHaveLength(1);
    // without a mandate the founder's explicit rebalance setting stands on its own
    expect(proposeRebalance(baseInput({ cfg: sellCfg }))).toHaveLength(1);
    // a buy (too much SOL) is not a distribution and is never held by these stops
    const buyCfg = testConfig({ strategy: { rebalance: { enabled: true, targetSolShare: 0.1, band: 0.05 }, clip: { maxSol: 50 } } });
    expect(proposeRebalance(baseInput({ cfg: { ...buyCfg, mandate: { ...mandate, alertFloor: 0.0003 } } }))[0]?.side).toBe("buy");
  });

  it("under a mandate it never sells back what the defense just bought, and never sells cap dust", () => {
    const mandate = { profile: "balanced" as const, autonomy: "auto" as const, startedAt: 0 };
    const base = testConfig({ rules: { dailySellCapPct: 20 }, strategy: { distribution: { enabled: true, pctOfVaultPerDay: 0.5, mode: "strength" }, rebalance: { enabled: true, targetSolShare: 0.5, band: 0.1 }, clip: { maxSol: 50 } } });
    const cfg = { ...base, mandate };
    const now = 1_000_000_000_000;
    const defBuy: Order = { id: "d1", projectId: "test", side: "buy", reason: "DEF", inputMint: "So11111111111111111111111111111111111111112", outputMint: cfg.mint, amountIn: solToLamports(0.5), maxSlippageBps: 100, refPrice: 0.0002, note: "level:0.00019 under", status: "filled", createdAt: now - 10 * 60_000, updatedAt: now - 10 * 60_000 };
    expect(proposeRebalance(baseInput({ cfg, now, lastOrders: [defBuy] }))).toEqual([]); // 10 minutes after a defense buy
    const older = { ...defBuy, createdAt: now - 16 * 60_000, updatedAt: now - 16 * 60_000 };
    expect(proposeRebalance(baseInput({ cfg, now, lastOrders: [older] }))).toHaveLength(1);
    // cap dust: 0.1 SOL of cap left under a 0.25 SOL minimum clip -> wait for the window
    const dust = { ...cfg, rules: { ...cfg.rules, dailySellCapPct: 0.01 }, strategy: { ...cfg.strategy, clip: { ...cfg.strategy.clip, minSol: 0.25 } } };
    expect(proposeRebalance(baseInput({ cfg: dust, now }))).toEqual([]);
    expect(proposeRebalance(baseInput({ cfg: { ...dust, mandate: undefined }, now })).length).toBe(1); // without a mandate the founder's setting stands
  });

  it("waits ten minutes between orders", () => {
    const cfg = testConfig({ strategy: { rebalance: { enabled: true, targetSolShare: 0.1, band: 0.05 } } });
    const now = 1_000_000_000_000;
    const first = proposeRebalance(baseInput({ cfg, now }))[0]!;
    const recent = toOrder(first, "filled", now - 5 * 60_000);
    expect(proposeRebalance(baseInput({ cfg, now, lastOrders: [recent] }))).toEqual([]);
    const old = toOrder(first, "filled", now - 11 * 60_000);
    expect(proposeRebalance(baseInput({ cfg, now, lastOrders: [old] }))).toHaveLength(1);
  });
});

describe("detectors", () => {
  it("flags a 3:1 sell/buy flow and reports the nearest level", () => {
    const snaps: Snapshot[] = [1, 2, 3, 4, 5].map((i) => testSnapshot({ ts: i, price: 0.00021, sellFlow5mSol: 3, buyFlow5mSol: 1 }));
    const r = detectSellPressure(snaps, [{ price: 0.0002, budgetSol: 1 }, { price: 0.00015, budgetSol: 1 }]);
    expect(r.pressure).toBe(true);
    expect(r.costPerHourSol).toBe(24);
    expect(r.nearestLevel?.price).toBe(0.0002);
    expect(r.pctAboveLevel).toBeCloseTo(5, 5);
    const calm = detectSellPressure(snaps.map((s) => ({ ...s, sellFlow5mSol: 1, buyFlow5mSol: 1 })), []);
    expect(calm.pressure).toBe(false);
    expect(detectSellPressure([], []).pressure).toBe(false);
  });

  it("detects level hits, low budget and a used-up cap", () => {
    const levels = [{ price: 0.0002, budgetSol: 1 }, { price: 0.0001, budgetSol: 1 }];
    expect(detectLevelHit(testSnapshot({ price: 0.000199 }), levels).map((l) => l.price)).toEqual([0.0002]);
    expect(detectLevelHit(testSnapshot({ price: 0.00025 }), levels)).toEqual([]);

    const cfg = testConfig({ rules: { defenseBudgetSol: 10 }, strategy: { defense: { enabled: true, levels } } });
    expect(detectBudgetLow(cfg, testRolling({ defenseSpentTotalLamports: solToLamports(8.5) })).low).toBe(true);
    expect(detectBudgetLow(cfg, testRolling({ defenseSpentTotalLamports: solToLamports(5) })).low).toBe(false);

    const capped = detectCapReached(cfg, testSnapshot({ vaultTokens: tokensToBase(995_000, DECIMALS) }), testRolling({ soldLast24h: tokensToBase(5_000, DECIMALS) }));
    expect(capped.reached).toBe(true);
    expect(detectCapReached(cfg, testSnapshot(), testRolling()).reached).toBe(false);
  });
});

describe("allStrategies", () => {
  it("returns only the enabled strategies in DEF, DIST, REB order", () => {
    expect(allStrategies(testConfig()).map((s) => s.name)).toEqual([]);
    const all = testConfig({ strategy: { defense: { enabled: true, levels: [] }, distribution: { enabled: true }, rebalance: { enabled: true } } });
    expect(allStrategies(all).map((s) => s.name)).toEqual(["DEF", "DIST", "REB"]);
    expect(allStrategies(testConfig({ strategy: { rebalance: { enabled: true } } })).map((s) => s.name)).toEqual(["REB"]);
  });
});
