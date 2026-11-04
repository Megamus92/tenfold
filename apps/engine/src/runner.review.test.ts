/**
 * Review tests: sequences that could let the engine exceed the daily sell cap or the defense budget.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_RULES, DEFAULT_STRATEGY, Ledger, parseProjectConfig, seededRng, solToLamports, tokensToBase } from "@tenfold/core";
import type { Fill, Order, ProjectConfig, Snapshot } from "@tenfold/core";
import { ProjectRunner } from "./runner.js";
import type { Executor, PriceFeed } from "./runner.js";

const MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const DEC = 6;

function cfg(over: Partial<ProjectConfig["strategy"]> = {}, rules: Partial<ProjectConfig["rules"]> = {}): ProjectConfig {
  return parseProjectConfig({
    id: "rv",
    name: "Review",
    mint: MINT,
    decimals: DEC,
    walletPubkey: WALLET,
    mode: "live",
    rules: { ...DEFAULT_RULES, defenseBudgetSol: 10, maxDefenseSpendPerDaySol: 10, ...rules },
    strategy: { ...DEFAULT_STRATEGY, ...over },
    createdAt: 0,
    paused: false,
  });
}

class ScriptFeed implements PriceFeed {
  price = 0.0002;
  buy = 1;
  sell = 1;
  tokens = tokensToBase(1_000_000, DEC);
  lamports = solToLamports(50);
  async snapshot(): Promise<Omit<Snapshot, "projectId" | "ts">> {
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

/**
 * Executor that, like the live JupiterExecutor, sends the transaction and then cannot learn its outcome:
 * it throws an error carrying the signature and `outcomeUnknown`. The tokens may well have left the vault.
 */
class LostConfirmationExecutor implements Executor {
  fills: Fill[] = [];
  lose = false;
  constructor(private readonly clock: () => number) {}
  async execute(order: Order, c: ProjectConfig, s: Snapshot): Promise<Fill> {
    if (this.lose) {
      throw Object.assign(new Error(`tx 5igLost outcome unknown: rpc unreachable`), { txSig: "5igLost", retryable: true, outcomeUnknown: true });
    }
    const out = order.side === "buy" ? tokensToBase(Number(order.amountIn) / 1e9 / s.price, c.decimals) : solToLamports((Number(order.amountIn) / 10 ** c.decimals) * s.price);
    const f: Fill = { orderId: order.id, projectId: order.projectId, side: order.side, reason: order.reason, inAmount: order.amountIn, outAmount: out, price: s.price, feeLamports: 5000n, ts: this.clock(), paper: false };
    this.fills.push(f);
    return f;
  }
}

function harness(c: ProjectConfig) {
  const ledger = new Ledger(":memory:");
  ledger.upsertProject(c);
  let now = new Date(2026, 9, 31, 10, 0, 0).getTime();
  const clock = (): number => now;
  const feed = new ScriptFeed();
  const exec = new LostConfirmationExecutor(clock);
  const runner = new ProjectRunner({ ledger, feed, executor: exec, rng: seededRng(5), cfg: c, now: clock, afterFill: (f) => feed.apply(f), persistConfig: () => undefined });
  return { ledger, feed, exec, runner, advance: (ms: number) => void (now += ms) };
}

describe("review: cap and budget under lost confirmations", () => {
  it("a sell whose on-chain outcome is unknown stays counted against the cap, so the next sell is refused", async () => {
    const h = harness(cfg({}, { dailySellCapPct: 0.5 }));
    // Full cap: 5,000 tokens. The transaction is sent, then the RPC goes silent.
    h.exec.lose = true;
    h.ledger.enqueueCommand("rv", "manual_order", { side: "sell", amountIn: tokensToBase(5_000, DEC).toString() });
    await h.runner.tick();
    const first = h.ledger.listOrders("rv")[0]!;
    expect(first.status).toBe("sent"); // not "failed": the tokens may have left the vault
    expect(h.ledger.rollingState("rv", h.runner.now()).soldLast24h).toBe(tokensToBase(5_000, DEC));

    // A second full-cap sell one minute later must be rejected: otherwise 10,000 tokens (1%) could leave in a day.
    h.exec.lose = false;
    h.advance(60_000);
    h.ledger.enqueueCommand("rv", "manual_order", { side: "sell", amountIn: tokensToBase(5_000, DEC).toString() });
    await h.runner.tick();
    expect(h.exec.fills).toHaveLength(0);
    const rejected = h.ledger.listEvents("rv", { types: ["order_rejected"] });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.data).toMatchObject({ side: "sell", code: "cap" });
    // and the order_failed event still told the founder about the lost confirmation
    expect(h.ledger.listEvents("rv", { types: ["order_failed"] })).toHaveLength(1);
  });

  it("a DEF buy whose on-chain outcome is unknown stays counted against the defense budget", async () => {
    const h = harness(cfg({ defense: { enabled: true, levels: [{ price: 0.0002, budgetSol: 1 }] } }, { defenseBudgetSol: 1, maxDefenseSpendPerDaySol: 1 }));
    h.feed.price = 0.000199;
    h.feed.sell = 3;
    // First tick: the level is under test, DEF buys and the confirmation is lost. The whole clip stays "sent".
    h.exec.lose = true;
    await h.runner.tick();
    const inflight = h.ledger.listOrders("rv");
    expect(inflight).toHaveLength(1);
    expect(inflight[0]!.reason).toBe("DEF");
    expect(inflight[0]!.status).toBe("sent");
    const spentSoFar = inflight[0]!.amountIn;
    expect(h.ledger.rollingState("rv", h.runner.now()).defenseSpentTotalLamports).toBe(spentSoFar);

    // From here on every DEF buy fills; the sum of what is in flight plus what fills must stay within the 1 SOL budget.
    h.exec.lose = false;
    for (let i = 0; i < 40; i++) {
      h.advance(30_000);
      await h.runner.tick();
    }
    const filled = h.exec.fills.filter((f) => f.reason === "DEF").reduce((a, f) => a + f.inAmount, 0n);
    expect(filled).toBeGreaterThan(0n);
    expect(spentSoFar + filled).toBeLessThanOrEqual(solToLamports(1));
  });

  it("a definitively failed order (no txSig) frees the cap again", async () => {
    const h = harness(cfg({}, { dailySellCapPct: 0.5 }));
    const failing: Executor = {
      execute: async () => {
        throw new Error("quote failed: no route");
      },
    };
    const r = new ProjectRunner({ ledger: h.ledger, feed: h.feed, executor: failing, rng: seededRng(1), cfg: cfg({}, { dailySellCapPct: 0.5 }), now: () => h.runner.now(), persistConfig: () => undefined });
    h.ledger.enqueueCommand("rv", "manual_order", { side: "sell", amountIn: tokensToBase(5_000, DEC).toString() });
    await r.tick();
    expect(h.ledger.listOrders("rv")[0]!.status).toBe("failed");
    expect(h.ledger.rollingState("rv", r.now()).soldLast24h).toBe(0n);
  });
});
