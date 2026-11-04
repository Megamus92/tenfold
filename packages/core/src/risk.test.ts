import { describe, it, expect } from "vitest";
import { assess, dailyCapAmount, dailyCapRemaining, solToLamports, tokensToBase } from "./risk.js";
import { Ledger } from "./ledger.js";
import { parseProjectConfig, DEFAULT_RULES, DEFAULT_STRATEGY } from "./config.js";
import type { ProjectConfig, RollingState, Snapshot } from "./types.js";
import { WSOL_MINT } from "./types.js";

const MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";

function cfg(over: Partial<ProjectConfig["rules"]> = {}, paused = false): ProjectConfig {
  return parseProjectConfig({
    id: "test",
    name: "Test",
    mint: MINT,
    decimals: 6,
    walletPubkey: WALLET,
    mode: "paper",
    rules: { ...DEFAULT_RULES, defenseBudgetSol: 10, maxDefenseSpendPerDaySol: 4, ...over },
    strategy: { ...DEFAULT_STRATEGY, distribution: { enabled: true, pctOfVaultPerDay: 0.5, mode: "strength", minPrice: 0.0001 } },
    createdAt: Date.now(),
    paused,
  });
}

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    projectId: "test",
    ts: Date.now(),
    price: 0.0002,
    buyFlow5mSol: 1,
    sellFlow5mSol: 2,
    vaultTokens: tokensToBase(1_000_000, 6),
    vaultLamports: solToLamports(50),
    ...over,
  };
}

function rolling(over: Partial<RollingState> = {}): RollingState {
  return { soldLast24h: 0n, defenseSpentLast24hLamports: 0n, defenseSpentTotalLamports: 0n, ordersLastHour: 0, ...over };
}

describe("daily cap", () => {
  it("is a percentage of the balance before today's sells", () => {
    const c = cfg({ dailySellCapPct: 0.5 });
    const s = snap();
    expect(dailyCapAmount(c, s, rolling())).toBe(tokensToBase(5_000, 6));
    // after selling 2,000 the base is still 1,000,000 (998,000 left + 2,000 sold)
    const s2 = snap({ vaultTokens: tokensToBase(998_000, 6) });
    expect(dailyCapRemaining(c, s2, rolling({ soldLast24h: tokensToBase(2_000, 6) }))).toBe(tokensToBase(3_000, 6));
  });

  it("rejects a sell above the cap and says how much still fits", () => {
    const c = cfg({ dailySellCapPct: 0.5 });
    const v = assess(
      { side: "sell", reason: "DIST", amountIn: tokensToBase(6_000, 6), maxSlippageBps: 100, refPrice: 0.0002 },
      { cfg: c, snapshot: snap(), rolling: rolling() },
    );
    expect(v.ok).toBe(false);
    expect(v.code).toBe("cap");
    expect(v.allowedAmountIn).toBe(tokensToBase(5_000, 6));
  });

  it("counts pending sells toward the cap", () => {
    const c = cfg({ dailySellCapPct: 1 });
    const v = assess(
      { side: "sell", reason: "DIST", amountIn: tokensToBase(6_000, 6), maxSlippageBps: 100, refPrice: 0.0002 },
      { cfg: c, snapshot: snap(), rolling: rolling({ soldLast24h: tokensToBase(5_000, 6) }) },
    );
    expect(v.ok).toBe(false);
    expect(v.allowedAmountIn).toBe(tokensToBase(5_050, 6));
  });
});

describe("defense budget", () => {
  it("rejects a DEF buy above the lifetime budget", () => {
    const v = assess(
      { side: "buy", reason: "DEF", amountIn: solToLamports(3), maxSlippageBps: 100, refPrice: 0.0002 },
      { cfg: cfg(), snapshot: snap(), rolling: rolling({ defenseSpentTotalLamports: solToLamports(8) }) },
    );
    expect(v.ok).toBe(false);
    expect(v.code).toBe("budget");
    expect(v.allowedAmountIn).toBe(solToLamports(2));
  });

  it("rejects a DEF buy above the daily defense limit", () => {
    const v = assess(
      { side: "buy", reason: "DEF", amountIn: solToLamports(3), maxSlippageBps: 100, refPrice: 0.0002 },
      { cfg: cfg(), snapshot: snap(), rolling: rolling({ defenseSpentLast24hLamports: solToLamports(2) }) },
    );
    expect(v.ok).toBe(false);
    expect(v.code).toBe("budget_day");
    expect(v.allowedAmountIn).toBe(solToLamports(2));
  });

  it("REB buys are not charged to the defense budget", () => {
    const v = assess(
      { side: "buy", reason: "REB", amountIn: solToLamports(3), maxSlippageBps: 100, refPrice: 0.0002 },
      { cfg: cfg(), snapshot: snap(), rolling: rolling({ defenseSpentTotalLamports: solToLamports(10) }) },
    );
    expect(v.ok).toBe(true);
  });
});

describe("other gates", () => {
  it("paused project rejects everything", () => {
    const v = assess(
      { side: "sell", reason: "DIST", amountIn: 1n, maxSlippageBps: 10, refPrice: 1 },
      { cfg: cfg({}, true), snapshot: snap(), rolling: rolling() },
    );
    expect(v.code).toBe("paused");
  });

  it("circuit breaker trips on a 40% move in 5 minutes", () => {
    const v = assess(
      { side: "sell", reason: "DIST", amountIn: 1n, maxSlippageBps: 10, refPrice: 0.0002 },
      { cfg: cfg({ circuitBreakerMovePct: 35 }), snapshot: snap({ price: 0.00012 }), rolling: rolling({ price5mAgo: 0.0002 }) },
    );
    expect(v.code).toBe("circuit");
  });

  it("distribution respects the price floor", () => {
    const v = assess(
      { side: "sell", reason: "DIST", amountIn: 1n, maxSlippageBps: 10, refPrice: 0.00005 },
      { cfg: cfg(), snapshot: snap({ price: 0.00005 }), rolling: rolling() },
    );
    expect(v.code).toBe("min_price");
  });

  it("pace limit", () => {
    const v = assess(
      { side: "sell", reason: "DIST", amountIn: 1n, maxSlippageBps: 10, refPrice: 0.0002 },
      { cfg: cfg({ maxOrdersPerHour: 5 }), snapshot: snap(), rolling: rolling({ ordersLastHour: 5 }) },
    );
    expect(v.code).toBe("pace");
  });
});

describe("ledger rolling state", () => {
  it("sums fills and pending orders in the last 24h", () => {
    const l = new Ledger(":memory:");
    const c = cfg();
    l.upsertProject(c);
    const o1 = l.insertOrder({
      projectId: "test",
      side: "sell",
      reason: "DIST",
      inputMint: MINT,
      outputMint: WSOL_MINT,
      amountIn: tokensToBase(1_000, 6),
      maxSlippageBps: 100,
      refPrice: 0.0002,
      status: "approved",
    });
    l.insertFill({
      orderId: o1.id,
      projectId: "test",
      side: "sell",
      reason: "DIST",
      inAmount: tokensToBase(1_000, 6),
      outAmount: solToLamports(0.2),
      price: 0.0002,
      feeLamports: 5000n,
      ts: Date.now(),
      paper: true,
    });
    l.insertOrder({
      projectId: "test",
      side: "sell",
      reason: "DIST",
      inputMint: MINT,
      outputMint: WSOL_MINT,
      amountIn: tokensToBase(500, 6),
      maxSlippageBps: 100,
      refPrice: 0.0002,
      status: "sent",
    });
    const d = l.insertOrder({
      projectId: "test",
      side: "buy",
      reason: "DEF",
      inputMint: WSOL_MINT,
      outputMint: MINT,
      amountIn: solToLamports(1),
      maxSlippageBps: 100,
      refPrice: 0.0002,
      status: "approved",
    });
    l.insertFill({
      orderId: d.id,
      projectId: "test",
      side: "buy",
      reason: "DEF",
      inAmount: solToLamports(1),
      outAmount: tokensToBase(5_000, 6),
      price: 0.0002,
      feeLamports: 5000n,
      ts: Date.now(),
      paper: true,
    });
    const r = l.rollingState("test");
    expect(r.soldLast24h).toBe(tokensToBase(1_500, 6));
    expect(r.defenseSpentTotalLamports).toBe(solToLamports(1));
    expect(r.ordersLastHour).toBe(3);
    const rep = l.dailyReport("test");
    expect(rep.fills).toBe(2);
    expect(rep.soldTokens).toBe(tokensToBase(1_000, 6));
    expect(rep.defenseLamports).toBe(solToLamports(1));
    l.close();
  });

  it("commands and events round-trip", () => {
    const l = new Ledger(":memory:");
    const cmd = l.enqueueCommand("test", "pause", {});
    expect(l.pendingCommands()[0]?.id).toBe(cmd.id);
    l.completeCommand(cmd.id);
    expect(l.pendingCommands()).toHaveLength(0);
    const id = l.insertEvent({ type: "cap_reached", projectId: "test", ts: Date.now(), data: { sold: 10n } });
    const un = l.undeliveredEvents();
    expect(un).toHaveLength(1);
    expect(un[0]?.data.sold).toBe("10");
    l.markDelivered([id]);
    expect(l.undeliveredEvents()).toHaveLength(0);
    l.close();
  });
});
