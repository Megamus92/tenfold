import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject, saveProject } from "@tenfold/core";
import { getStatus, runTool, setDefenseLevel, setDistribution, setMandate } from "./actions.js";
import { formatEvent } from "./alerts.js";
import { parseToolCall } from "./tools.js";
import { fixture } from "./testkit.js";
import type { Fixture } from "./testkit.js";

let fx: Fixture;
beforeEach(() => {
  fx = fixture();
});
afterEach(() => fx.cleanup());

const ctx = () => ({ ledger: fx.ledger, cfg: loadProject("test"), projectId: "test" });

describe("set_mandate", () => {
  it("parses and validates the tool input", () => {
    expect(parseToolCall("set_mandate", { profile: "balanced", horizonDays: 30, distributePct: 50, alertFloor: 0.0001 })).toEqual({
      name: "set_mandate",
      input: { profile: "balanced", horizonDays: 30, distributePct: 50, alertFloor: 0.0001 },
    });
    expect(parseToolCall("set_mandate", { profile: "yolo" })).toHaveProperty("error");
    expect(parseToolCall("set_mandate", {})).toHaveProperty("error");
    expect(parseToolCall("set_mandate", { horizonDays: 0 })).toHaveProperty("error");
  });

  it("asks for confirmation, then derives the strategy from the mandate and keeps founder levels pinned", () => {
    const res = setMandate(ctx(), { profile: "protect", horizonDays: 60, distributePct: 20, alertFloor: 0.00015 });
    expect(res.needsConfirmation?.summary).toMatch(/protect the price first/);
    expect(res.needsConfirmation?.summary).toMatch(/20% of the vault over 60 days/);
    expect(res.needsConfirmation?.summary).toMatch(/Pace about 0.33%/);
    const applied = res.needsConfirmation!.apply();
    expect(applied.ok).toBe(true);
    const cfg = loadProject("test");
    expect(cfg.mandate?.profile).toBe("protect");
    expect(cfg.mandate?.autonomy).toBe("auto");
    expect(cfg.mandate?.alertFloor).toBe(0.00015);
    // the fixture's manual level was not pinned (set in the file, not through the agent) so the desk owns levels now
    expect(cfg.strategy.defense.levels).toEqual([]);
    expect(cfg.strategy.distribution.enabled).toBe(true);
    expect(cfg.strategy.distribution.pctOfVaultPerDay).toBeCloseTo(0.3333, 3);
    expect(cfg.strategy.rebalance.enabled).toBe(true);
    expect(fx.ledger.pendingCommands().some((c) => c.type === "reload")).toBe(true);
  });

  it("a level the founder adds through the agent is pinned and survives a mandate change", () => {
    const add = setDefenseLevel(ctx(), { price: 0.00016, budgetSol: 2, action: "add" });
    expect(add.needsConfirmation!.apply().ok).toBe(true);
    expect(loadProject("test").strategy.defense.levels.find((l) => l.price === 0.00016)?.pinned).toBe(true);
    const res = setMandate(ctx(), { profile: "distribute" });
    expect(res.needsConfirmation!.apply().ok).toBe(true);
    const cfg = loadProject("test");
    expect(cfg.strategy.defense.levels).toEqual([{ price: 0.00016, budgetSol: 2, pinned: true }]);
    expect(cfg.strategy.defense.enabled).toBe(true);
  });

  it("warns when the horizon needs more than the daily cap, and reports nothing to change on a no-op", () => {
    const res = setMandate(ctx(), { profile: "distribute", horizonDays: 10, distributePct: 100 });
    expect(res.needsConfirmation?.summary).toMatch(/above the 0.5% cap/);
    res.needsConfirmation!.apply();
    const again = setMandate(ctx(), { profile: "distribute" });
    expect(again.needsConfirmation).toBeUndefined();
    expect(again.message).toMatch(/already like that/);
  });

  it("changing only the alert floor keeps the horizon clock; changing the profile restarts it", () => {
    setMandate(ctx(), { profile: "balanced", horizonDays: 30, distributePct: 30 }).needsConfirmation!.apply();
    const first = loadProject("test").mandate!;
    setMandate(ctx(), { alertFloor: 0.0001 }).needsConfirmation!.apply();
    expect(loadProject("test").mandate!.startedAt).toBe(first.startedAt);
    setMandate(ctx(), { profile: "protect" }).needsConfirmation!.apply();
    expect(loadProject("test").mandate!.startedAt).toBeGreaterThanOrEqual(first.startedAt);
    expect(loadProject("test").mandate!.horizonDays).toBe(30);
  });

  it("re-sending the same profile does not restart the horizon; changing the share does, and says so", () => {
    setMandate(ctx(), { profile: "balanced", horizonDays: 30, distributePct: 30 }).needsConfirmation!.apply();
    const first = loadProject("test").mandate!;
    const same = setMandate(ctx(), { profile: "balanced", autonomy: "ask" });
    expect(same.needsConfirmation!.summary).toMatch(/clock keeps running/);
    same.needsConfirmation!.apply();
    expect(loadProject("test").mandate!.startedAt).toBe(first.startedAt);
    const changed = setMandate({ ...ctx(), now: first.startedAt + 1000 }, { distributePct: 50 });
    expect(changed.needsConfirmation!.summary).toMatch(/horizon restarts from today/);
    changed.needsConfirmation!.apply();
    expect(loadProject("test").mandate!.startedAt).toBe(first.startedAt + 1000);
    expect(loadProject("test").mandate!.startTokens).toBeUndefined();
  });

  it("a floor-only or autonomy-only change keeps the desk's levels and pace", () => {
    setMandate(ctx(), { profile: "balanced", horizonDays: 60, distributePct: 30 }).needsConfirmation!.apply();
    const c = loadProject("test");
    c.strategy.defense.levels = [{ price: 0.00017, budgetSol: 2, placedAt: 1 }];
    c.strategy.distribution.pctOfVaultPerDay = 0.21;
    saveProject(c);
    setMandate(ctx(), { alertFloor: 0.0001 }).needsConfirmation!.apply();
    const after = loadProject("test");
    expect(after.strategy.defense.levels).toEqual([{ price: 0.00017, budgetSol: 2, placedAt: 1 }]);
    expect(after.strategy.distribution.pctOfVaultPerDay).toBe(0.21);
    expect(after.mandate!.alertFloor).toBe(0.0001);
  });

  it("accepting the slower pace is recorded on the mandate", () => {
    setMandate(ctx(), { profile: "distribute", horizonDays: 10, distributePct: 100 }).needsConfirmation!.apply();
    const res = setMandate(ctx(), { acceptSlowPace: true });
    expect(res.needsConfirmation!.summary).toMatch(/slower pace accepted/);
    res.needsConfirmation!.apply();
    expect(loadProject("test").mandate!.acceptedSlowPace).toBe(true);
    expect(parseToolCall("set_mandate", { acceptSlowPace: true })).toEqual({ name: "set_mandate", input: { acceptSlowPace: true } });
  });

  it("on a mandate project set_distribution only changes the floor, and the desk's levels cannot be removed by hand", () => {
    setMandate(ctx(), { profile: "balanced" }).needsConfirmation!.apply();
    const refused = setDistribution(ctx(), { enabled: false, pctOfVaultPerDay: 0.4, mode: "twap" });
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/runs on a mandate/);
    const floor = setDistribution(ctx(), { enabled: true, pctOfVaultPerDay: 0.3, mode: "strength", minPrice: 0.00011 });
    expect(floor.needsConfirmation!.summary).toMatch(/selling floor to 0.00011/);
    floor.needsConfirmation!.apply();
    expect(loadProject("test").strategy.distribution.minPrice).toBe(0.00011);
    const c = loadProject("test");
    c.strategy.defense.levels = [{ price: 0.00017, budgetSol: 2, placedAt: 1 }];
    saveProject(c);
    const rm = setDefenseLevel(ctx(), { price: 0.00017, budgetSol: 0, action: "remove" });
    expect(rm.ok).toBe(false);
    expect(rm.message).toMatch(/the desk's/);
  });

  it("status shows the mandate and the horizon progress, counting every own sell as the desk does; runTool dispatches set_mandate", () => {
    runTool(ctx(), { name: "set_mandate", input: { profile: "balanced", horizonDays: 20, distributePct: 10 } }).needsConfirmation!.apply();
    const c = loadProject("test");
    c.mandate!.startTokens = "1000000000000"; // 1,000,000 tokens; the 10% target is 100,000
    saveProject(c);
    const fill = (orderId: string, reason: "DIST" | "REB" | "MANUAL", tokens: bigint) =>
      fx.ledger.insertFill({ orderId, projectId: "test", side: "sell", reason, inAmount: tokens, outAmount: 1_000_000n, price: 0.0002, feeLamports: 5000n, ts: Date.now(), paper: true });
    fill("f1", "DIST", 20_000_000_000n);
    fill("f2", "REB", 20_000_000_000n);
    fill("f3", "MANUAL", 10_000_000_000n);
    const st = getStatus(ctx());
    expect(st.message).toMatch(/Mandate: hold reasonable levels/);
    expect(st.message).toMatch(/Horizon: 50% of the target/);
    expect((st.data as { mandate?: { profile: string; donePct: number } }).mandate?.profile).toBe("balanced");
    expect((st.data as { mandate?: { donePct: number } }).mandate?.donePct).toBeCloseTo(50, 6);
  });

  it("under a mandate the engine's sell-pressure and budget-low questions are not relayed: the desk owns those calls", () => {
    runTool(ctx(), { name: "set_mandate", input: { profile: "balanced" } }).needsConfirmation!.apply();
    const c = loadProject("test");
    expect(formatEvent({ type: "sell_pressure", projectId: "test", ts: Date.now(), data: { price: 0.00019, level: 0.00018, costPerHourSol: 2, hoursLeft: 2 } }, c, fx.ledger)).toBeUndefined();
    expect(formatEvent({ type: "budget_low", projectId: "test", ts: Date.now(), data: { leftSol: 1, budgetSol: 10, pct: 10 } }, c, fx.ledger)).toBeUndefined();
    // without a mandate the founder is asked, as before
    expect(formatEvent({ type: "sell_pressure", projectId: "test", ts: Date.now(), data: { price: 0.00019, level: 0.00018, costPerHourSol: 2, hoursLeft: 2 } }, fx.cfg, fx.ledger)).toMatch(/Hold, lower the level, or let it breathe\?/);
  });
});

describe("desk alerts", () => {
  it("relays a desk decision as one line and skips the bookkeeping one", () => {
    const ev = (data: Record<string, unknown>) => ({ type: "desk_decision" as const, projectId: "test", ts: Date.now(), data });
    expect(formatEvent(ev({ kind: "place_level", price: 0.000186, budgetSol: 5, why: "Placed a defense level at 0.0001860 with 5.00 SOL." }), fx.cfg, fx.ledger)).toBe(
      "Desk: Placed a defense level at 0.0001860 with 5.00 SOL.",
    );
    expect(formatEvent(ev({ kind: "mandate_started", startTokens: "1" }), fx.cfg, fx.ledger)).toBeUndefined();
  });

  it("turns a proposal into an ask and an escalation into a question with options", () => {
    const prop = formatEvent({ type: "desk_proposal", projectId: "test", ts: Date.now(), data: { kind: "set_pace", why: "Pace 0.30% → 0.15%: sellers dominate." } }, fx.cfg, fx.ledger);
    expect(prop).toMatch(/^Desk proposal \(not applied/);
    expect(prop).toMatch(/Nothing applies by itself/);
    const esc = formatEvent(
      { type: "desk_escalation", projectId: "test", ts: Date.now(), data: { topic: "budget_top_up", why: "The defense budget is used up.", options: ["top up", "leave it"] } },
      fx.cfg,
      fx.ledger,
    );
    expect(esc).toBe("Your call: The defense budget is used up. Options: top up / leave it.");
    const liq = formatEvent({ type: "desk_escalation", projectId: "test", ts: Date.now(), data: { topic: "liquidity_pull", why: "Liquidity gone.", options: [] } }, fx.cfg, fx.ledger);
    expect(liq).toBe("I need you on this one. Liquidity gone.");
  });

  it("adds the desk's activity and the horizon to a daily report when the event carries them", () => {
    const now = Date.now();
    const text = formatEvent(
      { type: "daily_report", projectId: "test", ts: now, data: { desk: { place_level: 2, remove_level: 1, set_pace: 3 }, horizon: { donePct: 38.2, elapsedPct: 36.7, distributePct: 50, horizonDays: 30 } } },
      fx.cfg,
      fx.ledger,
    );
    expect(text).toMatch(/Horizon: 38.2% of the 50% target distributed at 36.7% of the 30 days/);
    expect(text).toMatch(/Desk: 2 ladders placed, 1 levels removed, 3 pace changes/);
    const quiet = formatEvent({ type: "daily_report", projectId: "test", ts: now, data: { desk: {} } }, fx.cfg, fx.ledger);
    expect(quiet).toMatch(/Desk: no changes needed/);
  });

  it("formats the weekly report from the event's own numbers", () => {
    const now = Date.now();
    const text = formatEvent(
      {
        type: "weekly_report",
        projectId: "test",
        ts: now,
        data: { from: now - 7 * 86_400_000, to: now, fills: 12, byReason: { DIST: 9, DEF: 3 }, soldTokens: "30000000000", soldProceedsLamports: "6000000000", boughtTokens: "5000000000", boughtCostLamports: "1000000000", defenseLamports: "1000000000", feesLamports: "30000000", priceOpen: 0.00018, priceClose: 0.0002, distributionVwap: 0.0002, distributionVsTokenBps: 120 },
      },
      fx.cfg,
      fx.ledger,
    );
    expect(text).toMatch(/7-day report/);
    expect(text).toMatch(/Fills: 12 \(DIST 9, DEF 3\)/);
    expect(text).toMatch(/\+120 bps vs token VWAP/);
  });
});
