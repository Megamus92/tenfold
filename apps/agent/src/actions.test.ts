import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject, solToLamports } from "@tenfold/core";
import {
  CAP_RAISE_DELAY_MS,
  applyPendingCapRaises,
  costToHold,
  getStatus,
  lowerDailyCap,
  manualOrder,
  pause,
  pendingCapRaises,
  requestRaiseDailyCap,
  resume,
  setDefenseBudget,
  setDefenseLevel,
  setDistribution,
} from "./actions.js";
import type { ActionContext } from "./actions.js";
import { fixture } from "./testkit.js";
import type { Fixture } from "./testkit.js";

let fx: Fixture;
const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({ ledger: fx.ledger, cfg: loadProject("test"), projectId: "test", ...over });

beforeEach(() => {
  fx = fixture();
});
afterEach(() => fx.cleanup());

describe("set_distribution", () => {
  it("clamps the daily target to the cap, says so, and applies only on confirm", () => {
    const res = setDistribution(ctx(), { enabled: true, pctOfVaultPerDay: 5, mode: "twap" });
    expect(res.ok).toBe(true);
    expect(res.needsConfirmation).toBeDefined();
    expect(res.data?.clamped).toBe(true);
    expect(res.data?.pctOfVaultPerDay).toBe(0.5);
    expect(res.message).toMatch(/clamped to 0.5%/);
    expect(res.needsConfirmation?.summary).toMatch(/clamped/);
    // not applied yet
    expect(loadProject("test").strategy.distribution.pctOfVaultPerDay).toBe(0.3);
    expect(loadProject("test").strategy.distribution.mode).toBe("strength");

    const applied = res.needsConfirmation!.apply();
    expect(applied.ok).toBe(true);
    const after = loadProject("test").strategy.distribution;
    expect(after).toEqual({ enabled: true, pctOfVaultPerDay: 0.5, mode: "twap", minPrice: 0.0001 });
    expect(fx.ledger.pendingCommands().map((c) => c.type)).toEqual(["reload"]);
    expect(fx.ledger.getProject("test")?.strategy.distribution.pctOfVaultPerDay).toBe(0.5);
  });

  it("removes the floor when minPrice is 0", () => {
    const res = setDistribution(ctx(), { enabled: true, pctOfVaultPerDay: 0.2, mode: "strength", minPrice: 0 });
    res.needsConfirmation!.apply();
    expect(loadProject("test").strategy.distribution.minPrice).toBeUndefined();
  });
});

describe("lower_daily_cap", () => {
  it("applies instantly, persists, clamps distribution and notifies the engine", () => {
    const res = lowerDailyCap(ctx(), 0.2);
    expect(res.ok).toBe(true);
    expect(res.needsConfirmation).toBeUndefined();
    const cfg = loadProject("test");
    expect(cfg.rules.dailySellCapPct).toBe(0.2);
    expect(cfg.strategy.distribution.pctOfVaultPerDay).toBe(0.2);
    expect(fx.ledger.getProject("test")?.rules.dailySellCapPct).toBe(0.2);
    expect(fx.ledger.pendingCommands().some((c) => c.type === "reload")).toBe(true);
    expect(fx.ledger.listEvents("test", { types: ["config_changed"] })).toHaveLength(1);
  });

  it("refuses a value that is not lower", () => {
    const res = lowerDailyCap(ctx(), 0.5);
    expect(res.ok).toBe(false);
    expect(loadProject("test").rules.dailySellCapPct).toBe(0.5);
  });
});

describe("request_raise_daily_cap", () => {
  it("records a 48h pending change on confirm and applies it only when due", () => {
    const t0 = 1_800_000_000_000;
    const res = requestRaiseDailyCap(ctx({ now: t0 }), 1);
    expect(res.ok).toBe(true);
    expect(res.needsConfirmation).toBeDefined();
    expect(res.data?.applyAt).toBe(t0 + CAP_RAISE_DELAY_MS);
    expect(pendingCapRaises(fx.ledger, "test")).toHaveLength(0);

    res.needsConfirmation!.apply();
    const pending = pendingCapRaises(fx.ledger, "test");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.pct).toBe(1);
    expect(pending[0]!.applyAt).toBe(t0 + CAP_RAISE_DELAY_MS);
    expect(loadProject("test").rules.dailySellCapPct).toBe(0.5);

    // too early: nothing applies
    expect(applyPendingCapRaises(fx.ledger, t0 + CAP_RAISE_DELAY_MS - 1)).toEqual([]);
    expect(loadProject("test").rules.dailySellCapPct).toBe(0.5);
    expect(pendingCapRaises(fx.ledger, "test")).toHaveLength(1);

    // due: applies once
    expect(applyPendingCapRaises(fx.ledger, t0 + CAP_RAISE_DELAY_MS)).toEqual([{ projectId: "test", pct: 1 }]);
    expect(loadProject("test").rules.dailySellCapPct).toBe(1);
    expect(pendingCapRaises(fx.ledger, "test")).toHaveLength(0);
    expect(applyPendingCapRaises(fx.ledger, t0 + CAP_RAISE_DELAY_MS + 1)).toEqual([]);
  });

  it("is cancelled by lowering the cap", () => {
    requestRaiseDailyCap(ctx(), 2).needsConfirmation!.apply();
    expect(pendingCapRaises(fx.ledger, "test")).toHaveLength(1);
    const res = lowerDailyCap(ctx(), 0.1);
    expect(res.message).toMatch(/Cancelled 1 pending/);
    expect(pendingCapRaises(fx.ledger, "test")).toHaveLength(0);
    expect(applyPendingCapRaises(fx.ledger, Date.now() + CAP_RAISE_DELAY_MS + 1)).toEqual([]);
    expect(loadProject("test").rules.dailySellCapPct).toBe(0.1);
  });

  it("refuses a value that is not higher", () => {
    expect(requestRaiseDailyCap(ctx(), 0.5).ok).toBe(false);
  });
});

describe("manual_order", () => {
  it("pre-checks with the risk engine and enqueues a MANUAL command only on confirm", () => {
    const res = manualOrder(ctx(), { side: "buy", amountSol: 1, note: "test buy" });
    expect(res.ok).toBe(true);
    expect(res.needsConfirmation?.summary).toMatch(/Manual BUY: spend 1 SOL/);
    expect(fx.ledger.pendingCommands()).toHaveLength(0);

    const applied = res.needsConfirmation!.apply();
    expect(applied.ok).toBe(true);
    const cmds = fx.ledger.pendingCommands();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.type).toBe("manual_order");
    expect(cmds[0]!.payload).toMatchObject({ side: "buy", reason: "MANUAL", note: "test buy", amountIn: solToLamports(1).toString() });
  });

  it("converts a sell given in SOL to tokens at the latest price", () => {
    const res = manualOrder(ctx(), { side: "sell", amountSol: 0.2, note: "take some profit" });
    expect(res.ok).toBe(true);
    expect(res.data?.amountTokens).toBeCloseTo(1000, 6);
    res.needsConfirmation!.apply();
    expect(fx.ledger.pendingCommands()[0]!.payload).toMatchObject({ side: "sell", amountIn: "1000000000" });
  });

  it("refuses an order the risk engine would reject and quotes the reason", () => {
    const res = manualOrder(ctx(), { side: "sell", amountTokens: 100_000, note: "dump" });
    expect(res.ok).toBe(false);
    expect(res.needsConfirmation).toBeUndefined();
    expect(res.message).toMatch(/risk engine refuses/);
    expect(res.message).toMatch(/cap/);
    expect(fx.ledger.pendingCommands()).toHaveLength(0);
  });

  it("refuses when paused", () => {
    pause(ctx());
    const res = manualOrder(ctx(), { side: "buy", amountSol: 0.1, note: "x" });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/paused/);
  });
});

describe("pause / resume", () => {
  it("pauses instantly and resumes only on confirm", () => {
    const p = pause(ctx());
    expect(p.ok).toBe(true);
    expect(p.needsConfirmation).toBeUndefined();
    expect(loadProject("test").paused).toBe(true);
    expect(fx.ledger.pendingCommands().map((c) => c.type)).toEqual(["reload", "pause"]);

    const r = resume(ctx());
    expect(r.needsConfirmation).toBeDefined();
    expect(loadProject("test").paused).toBe(true);
    r.needsConfirmation!.apply();
    expect(loadProject("test").paused).toBe(false);
    expect(fx.ledger.pendingCommands().map((c) => c.type)).toContain("resume");
  });
});

describe("defense", () => {
  it("refuses a level budget above the remaining defense budget", () => {
    const res = setDefenseLevel(ctx(), { price: 0.00015, budgetSol: 11, action: "add" });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Only 10 SOL of defense budget is left/);
  });

  it("adds a level on confirm, sorted high to low, and removes it", () => {
    const add = setDefenseLevel(ctx(), { price: 0.00019, budgetSol: 2, action: "add" });
    expect(add.needsConfirmation).toBeDefined();
    expect(loadProject("test").strategy.defense.levels).toHaveLength(1);
    add.needsConfirmation!.apply();
    // A level added by the founder is pinned so the desk manager never moves it.
    expect(loadProject("test").strategy.defense.levels).toEqual([
      { price: 0.00019, budgetSol: 2, pinned: true },
      { price: 0.00018, budgetSol: 4 },
    ]);
    const rm = setDefenseLevel(ctx(), { price: 0.00018, budgetSol: 0, action: "remove" });
    rm.needsConfirmation!.apply();
    expect(loadProject("test").strategy.defense.levels).toEqual([{ price: 0.00019, budgetSol: 2, pinned: true }]);
  });

  it("sets the budget rules on confirm", () => {
    const res = setDefenseBudget(ctx(), { budgetSol: 20, maxPerDaySol: 5 });
    expect(res.needsConfirmation?.summary).toMatch(/20 SOL total, max 5 SOL per day/);
    res.needsConfirmation!.apply();
    expect(loadProject("test").rules).toMatchObject({ defenseBudgetSol: 20, maxDefenseSpendPerDaySol: 5 });
  });

  it("prices holding a level in SOL/hour and hours of budget", () => {
    // excess sells 1 SOL / 5 min => 12 SOL/h; level 0.00018 has 4 SOL => 0.333 h; today 4 SOL => 0.333 h
    const res = costToHold(ctx(), 0.00018);
    expect(res.ok).toBe(true);
    expect(res.data?.costPerHourSol).toBe(12);
    expect(res.data?.hoursLevelBudget).toBeCloseTo(4 / 12, 6);
    expect(res.data?.hoursToday).toBeCloseTo(4 / 12, 6);
    expect(res.message).toMatch(/costs ~12 SOL\/hour/);
    expect(res.message).toMatch(/10% below the current price/);
  });
});

describe("get_status", () => {
  it("reports cap usage, defense budget and fills in display units", () => {
    fx.ledger.insertOrder({
      projectId: "test",
      side: "buy",
      reason: "DEF",
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: fx.cfg.mint,
      amountIn: solToLamports(1),
      maxSlippageBps: 100,
      refPrice: 0.0002,
    });
    const order = fx.ledger.listOrders("test")[0]!;
    fx.ledger.insertFill({
      orderId: order.id,
      projectId: "test",
      side: "buy",
      reason: "DEF",
      inAmount: solToLamports(1),
      outAmount: 5_000_000_000n,
      price: 0.0002,
      feeLamports: 5000n,
      ts: Date.now(),
      paper: true,
    });
    const res = getStatus(ctx());
    expect(res.ok).toBe(true);
    const data = res.data!;
    expect(data.dailyCap).toMatchObject({ pct: 0.5, capTokens: 5000, soldTokens: 0, usedPct: 0 });
    expect(data.defense).toMatchObject({ budgetSol: 10, spentSol: 1, remainingSol: 9, spentTodaySol: 1, remainingTodaySol: 3, costPerHourSol: 12 });
    expect((data.lastFills as unknown[]).length).toBe(1);
    expect(res.message).toMatch(/DEF bought 5,000 for 1 SOL @ 0.0002 \(paper\)/);
    expect(res.message).toMatch(/Daily cap 0.5%: sold 0 \/ 5,000 \(0% used\)/);
  });
});
