import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject } from "@tenfold/core";
import { getStatus, runTool, setDefenseLevel, setMandate } from "./actions.js";
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

  it("status shows the mandate and the horizon progress; runTool dispatches set_mandate", () => {
    runTool(ctx(), { name: "set_mandate", input: { profile: "balanced", horizonDays: 20, distributePct: 10 } }).needsConfirmation!.apply();
    const st = getStatus(ctx());
    expect(st.message).toMatch(/Mandate: hold reasonable levels/);
    expect((st.data as { mandate?: { profile: string } }).mandate?.profile).toBe("balanced");
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
    expect(prop).toMatch(/^Desk proposal \(nothing changed/);
    expect(prop).toMatch(/Say "do it"/);
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
