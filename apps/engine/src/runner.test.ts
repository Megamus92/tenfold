import { describe, it, expect } from "vitest";
import { DEFAULT_RULES, DEFAULT_STRATEGY, Ledger, WSOL_MINT, parseProjectConfig, seededRng, solToLamports, tokensToBase } from "@tenfold/core";
import type { Fill, Order, ProjectConfig, Snapshot } from "@tenfold/core";
import { ProjectRunner } from "./runner.js";
import type { Executor, PriceFeed } from "./runner.js";

const MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const DEC = 6;

function cfg(over: Partial<ProjectConfig["strategy"]> = {}, rules: Partial<ProjectConfig["rules"]> = {}): ProjectConfig {
  return parseProjectConfig({
    id: "t1",
    name: "T1",
    mint: MINT,
    decimals: DEC,
    walletPubkey: WALLET,
    mode: "paper",
    rules: { ...DEFAULT_RULES, defenseBudgetSol: 10, maxDefenseSpendPerDaySol: 10, ...rules },
    strategy: { ...DEFAULT_STRATEGY, ...over },
    createdAt: 0,
    paused: false,
  });
}

/** Scripted feed: fixed price and flows, balances follow fills. */
class ScriptFeed implements PriceFeed {
  price = 0.0002;
  buy = 1;
  sell = 1;
  tokens = tokensToBase(1_000_000, DEC);
  lamports = solToLamports(50);
  fail = false;
  async snapshot(): Promise<Omit<Snapshot, "projectId" | "ts">> {
    if (this.fail) throw new Error("feed down");
    return { price: this.price, buyFlow5mSol: this.buy, sellFlow5mSol: this.sell, vaultTokens: this.tokens, vaultLamports: this.lamports };
  }
  apply(f: Fill): void {
    if (f.side === "buy") {
      this.lamports -= f.inAmount + f.feeLamports;
      this.tokens += f.outAmount;
    } else {
      this.tokens -= f.inAmount;
      this.lamports += f.outAmount - f.feeLamports;
    }
  }
}

/** Fills at the snapshot price; can be told to throw. */
class ScriptExecutor implements Executor {
  fills: Fill[] = [];
  fail = false;
  constructor(private readonly clock: () => number) {}
  async execute(order: Order, c: ProjectConfig, s: Snapshot): Promise<Fill> {
    if (this.fail) throw new Error("rpc exploded");
    const out = order.side === "buy" ? tokensToBase(Number(order.amountIn) / 1e9 / s.price, c.decimals) : solToLamports((Number(order.amountIn) / 10 ** c.decimals) * s.price);
    const f: Fill = { orderId: order.id, projectId: order.projectId, side: order.side, reason: order.reason, inAmount: order.amountIn, outAmount: out, price: s.price, feeLamports: 5000n, ts: this.clock(), paper: true };
    this.fills.push(f);
    return f;
  }
}

function harness(c: ProjectConfig) {
  const ledger = new Ledger(":memory:");
  ledger.upsertProject(c);
  const start = new Date(2026, 9, 31, 10, 0, 0).getTime(); // 10:00 local, after the 09:00 report hour
  let now = start;
  const clock = (): number => now;
  const feed = new ScriptFeed();
  const exec = new ScriptExecutor(clock);
  const runner = new ProjectRunner({ ledger, feed, executor: exec, rng: seededRng(5), cfg: c, now: clock, afterFill: (f) => feed.apply(f), persistConfig: () => undefined });
  const advance = (ms: number): void => {
    now += ms;
  };
  return { ledger, feed, exec, runner, advance, start };
}

describe("ProjectRunner", () => {
  it("skips the tick when the feed fails and records nothing", async () => {
    const h = harness(cfg());
    h.feed.fail = true;
    await h.runner.tick();
    expect(h.ledger.latestSnapshot("t1")).toBeUndefined();
    h.feed.fail = false;
    await h.runner.tick();
    expect(h.ledger.latestSnapshot("t1")).toBeDefined();
  });

  it("runs a manual_order through assess and execute, with amountIn as the size", async () => {
    const h = harness(cfg());
    h.ledger.enqueueCommand("t1", "manual_order", {
      side: "buy",
      reason: "MANUAL",
      note: "founder test",
      refPrice: 0.0002,
      inputMint: WSOL_MINT,
      outputMint: MINT,
      amountIn: solToLamports(0.5).toString(),
    });
    await h.runner.tick();
    expect(h.exec.fills).toHaveLength(1);
    expect(h.exec.fills[0]!.reason).toBe("MANUAL");
    expect(h.exec.fills[0]!.inAmount).toBe(solToLamports(0.5));
    const cmds = h.ledger.pendingCommands();
    expect(cmds).toHaveLength(0);
    const orders = h.ledger.listOrders("t1");
    expect(orders).toHaveLength(1);
    expect(orders[0]!.status).toBe("filled");
    expect(orders[0]!.note).toBe("founder test");
    const ev = h.ledger.listEvents("t1", { types: ["order_filled"] });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toMatchObject({ side: "buy", reason: "MANUAL", paper: true });
  });

  it("resizes a manual sell to the cap once and rejects a sell with nothing left, emitting order_rejected", async () => {
    const h = harness(cfg({}, { dailySellCapPct: 0.5 }));
    // 6,000 tokens asked, 5,000 allowed: resized and filled
    h.ledger.enqueueCommand("t1", "manual_order", { side: "sell", amountIn: tokensToBase(6_000, DEC).toString() });
    await h.runner.tick();
    expect(h.exec.fills).toHaveLength(1);
    expect(h.exec.fills[0]!.inAmount).toBe(tokensToBase(5_000, DEC));
    expect(h.ledger.listOrders("t1")[0]!.note).toContain("resized:cap");
    // the cap is now used up: a second sell is rejected
    h.advance(60_000);
    h.ledger.enqueueCommand("t1", "manual_order", { side: "sell", amountIn: tokensToBase(100, DEC).toString() });
    await h.runner.tick();
    expect(h.exec.fills).toHaveLength(1);
    const rejected = h.ledger.listEvents("t1", { types: ["order_rejected"] });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.data).toMatchObject({ side: "sell", code: "cap" });
    expect(typeof rejected[0]!.data.reason).toBe("string");
    const cmd = h.ledger.db.prepare("SELECT status, error FROM commands ORDER BY created_at DESC LIMIT 1").get() as { status: string; error: string };
    expect(cmd.status).toBe("failed");
    expect(cmd.error).toContain("cap");
    expect(h.ledger.listEvents("t1", { types: ["cap_reached"] })).toHaveLength(1);
  });

  it("a circuit breaker pauses the project until the founder resumes it", async () => {
    const h = harness(cfg({ distribution: { enabled: true, pctOfVaultPerDay: 0.5, mode: "strength" } }));
    await h.runner.tick();
    // six minutes of history, then a 40% drop in one tick: the next sell is rejected and the project pauses
    for (let i = 0; i < 36; i++) {
      h.advance(10_000);
      await h.runner.tick();
    }
    h.feed.price = 0.0002 * 0.6;
    h.advance(10_000);
    h.ledger.enqueueCommand("t1", "manual_order", { side: "sell", amountIn: tokensToBase(100, DEC).toString() });
    await h.runner.tick();
    expect(h.ledger.listEvents("t1", { types: ["circuit_breaker"] }).length).toBeGreaterThanOrEqual(1);
    expect(h.runner.cfg.paused).toBe(true);
    expect(h.ledger.listEvents("t1", { types: ["paused"] })[0]?.data.by).toBe("circuit breaker");
    // ten minutes later the move is out of the window; still paused, nothing trades
    const fills = h.exec.fills.length;
    for (let i = 0; i < 60; i++) {
      h.advance(10_000);
      await h.runner.tick();
    }
    expect(h.runner.cfg.paused).toBe(true);
    expect(h.exec.fills.length).toBe(fills);
  });

  it("pauses and resumes via commands, persisting and emitting once each", async () => {
    let persisted: ProjectConfig | undefined;
    const h = harness(cfg({ rebalance: { enabled: true, targetSolShare: 0.5, band: 0.05 } }));
    const r = new ProjectRunner({
      ledger: h.ledger,
      feed: h.feed,
      executor: h.exec,
      rng: seededRng(1),
      cfg: cfg({ rebalance: { enabled: true, targetSolShare: 0.5, band: 0.05 } }),
      now: () => h.start,
      persistConfig: (c) => {
        persisted = c;
      },
    });
    h.ledger.enqueueCommand("t1", "pause", { why: "founder said so" });
    await r.tick();
    expect(r.cfg.paused).toBe(true);
    expect(persisted?.paused).toBe(true);
    expect(h.ledger.getProject("t1")?.paused).toBe(true);
    expect(h.exec.fills).toHaveLength(0); // REB would have sold otherwise
    const paused = h.ledger.listEvents("t1", { types: ["paused"] });
    expect(paused).toHaveLength(1);
    expect(paused[0]!.data).toMatchObject({ by: "founder", why: "founder said so" });
    h.ledger.enqueueCommand("t1", "resume");
    await r.tick();
    expect(r.cfg.paused).toBe(false);
    expect(h.ledger.listEvents("t1", { types: ["resumed"] })).toHaveLength(1);
    expect(h.exec.fills).toHaveLength(1); // REB back in action
    expect(h.exec.fills[0]!.reason).toBe("REB");
  });

  it("marks the order failed and emits order_failed when the executor throws", async () => {
    const h = harness(cfg());
    h.exec.fail = true;
    h.ledger.enqueueCommand("t1", "manual_order", { side: "buy", amountSol: 0.1 });
    await h.runner.tick();
    const o = h.ledger.listOrders("t1")[0]!;
    expect(o.status).toBe("failed");
    expect(o.note).toContain("rpc exploded");
    const ev = h.ledger.listEvents("t1", { types: ["order_failed"] });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toMatchObject({ side: "buy", reason: "MANUAL", error: "rpc exploded" });
  });

  it("throttles sell_pressure to once per 10 minutes and level_hit per level", async () => {
    const h = harness(cfg({ defense: { enabled: true, levels: [{ price: 0.0002, budgetSol: 1 }] } }));
    h.feed.price = 0.000199;
    h.feed.sell = 3;
    h.feed.buy = 1;
    for (let i = 0; i < 30; i++) {
      await h.runner.tick();
      h.advance(10_000);
    }
    expect(h.ledger.listEvents("t1", { types: ["sell_pressure"] })).toHaveLength(1);
    expect(h.ledger.listEvents("t1", { types: ["level_hit"] })).toHaveLength(1);
    expect(h.ledger.listEvents("t1", { types: ["level_hit"] })[0]!.data).toMatchObject({ level: 0.0002, price: 0.000199 });
    // DEF bought at the level, spaced by the jittered gap
    const def = h.exec.fills.filter((f) => f.reason === "DEF");
    expect(def.length).toBeGreaterThan(3);
    expect(def.every((f) => f.side === "buy")).toBe(true);
    for (let i = 1; i < def.length; i++) expect(def[i]!.ts - def[i - 1]!.ts).toBeGreaterThanOrEqual(10_000);
    // after 10 more minutes the throttles reopen
    h.advance(10 * 60_000);
    await h.runner.tick();
    expect(h.ledger.listEvents("t1", { types: ["sell_pressure"] })).toHaveLength(2);
    expect(h.ledger.listEvents("t1", { types: ["level_hit"] })).toHaveLength(2);
  });

  it("emits the daily report once per local day after 09:00", async () => {
    const h = harness(cfg());
    await h.runner.tick();
    h.advance(60_000);
    await h.runner.tick();
    expect(h.ledger.listEvents("t1", { types: ["daily_report"] })).toHaveLength(1);
    h.advance(24 * 3_600_000);
    await h.runner.tick();
    expect(h.ledger.listEvents("t1", { types: ["daily_report"] })).toHaveLength(2);
  });

  it("never lets DIST and DEF trade against each other in one tick", async () => {
    // Price right at a level with strong buy flow: DEF wants to buy, DIST would want to sell. Only one may act.
    const h = harness(cfg({ defense: { enabled: true, levels: [{ price: 0.0002, budgetSol: 1 }] }, distribution: { enabled: true, pctOfVaultPerDay: 0.5, mode: "strength" } }));
    h.feed.price = 0.000201;
    h.feed.buy = 3;
    h.feed.sell = 1;
    for (let i = 0; i < 60; i++) {
      await h.runner.tick();
      h.advance(10_000);
    }
    const buys = h.exec.fills.filter((f) => f.side === "buy");
    const sells = h.exec.fills.filter((f) => f.side === "sell");
    expect(buys.length).toBeGreaterThan(0);
    expect(sells).toHaveLength(0);
  });
});
