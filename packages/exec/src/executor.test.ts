import { describe, expect, it } from "vitest";
import { ExecError, PaperExecutor, fillPrice, paperBuyOut, paperImpactBps, paperSellOut } from "./executor.js";
import type { JupiterQuote, Quoter, QuoteParams } from "./jupiter.js";
import { testConfig, testOrder, testSnapshot } from "./testutil.js";

describe("paper math", () => {
  it("sell 1,000 tokens at 0.0002 SOL with no impact yields 0.2 SOL minus the 0.3% fee", () => {
    // 1,000 tokens * 0.0002 SOL = 0.2 SOL = 200_000_000 lamports; minus 30 bps = 199_400_000
    expect(paperSellOut(1_000_000_000n, 0.0002, 6, 0)).toBe(199_400_000n);
  });

  it("buy with 0.2 SOL at 0.0002 SOL yields 1,000 tokens minus the 0.3% fee", () => {
    // 0.2 / 0.0002 = 1,000 tokens = 1_000_000_000 base units; minus 30 bps = 997_000_000
    expect(paperBuyOut(200_000_000n, 0.0002, 6, 0)).toBe(997_000_000n);
  });

  it("models impact as half the clip's share of liquidity, capped at 500 bps", () => {
    expect(paperImpactBps(0.2, 100)).toBeCloseTo(10, 9);
    expect(paperImpactBps(50, 100)).toBe(500);
    expect(paperImpactBps(1, undefined)).toBe(0);
    // 10 bps impact then 30 bps fee on a 0.2 SOL sell
    expect(paperSellOut(1_000_000_000n, 0.0002, 6, 10)).toBe(199_200_600n);
  });

  it("derives SOL-per-token prices from in/out on both sides", () => {
    expect(fillPrice("sell", 1_000_000_000n, 199_400_000n, 6)).toBeCloseTo(0.0001994, 12);
    expect(fillPrice("buy", 200_000_000n, 997_000_000n, 6)).toBeCloseTo(0.2 / 997, 12);
    expect(fillPrice("buy", 1n, 0n, 6)).toBe(0);
  });
});

describe("PaperExecutor", () => {
  const cfg = testConfig();

  it("fills a sell at the snapshot price with modelled impact and a 5000 lamport fee", async () => {
    const ex = new PaperExecutor({ now: () => 42 });
    const snap = testSnapshot({ price: 0.0002, liquiditySol: 100 });
    const fill = await ex.execute(testOrder("sell", 1_000_000_000n), cfg, snap);
    expect(fill.paper).toBe(true);
    expect(fill.inAmount).toBe(1_000_000_000n);
    expect(fill.outAmount).toBe(199_200_600n);
    expect(fill.feeLamports).toBe(5_000n);
    expect(fill.ts).toBe(42);
    expect(fill.side).toBe("sell");
    expect(fill.reason).toBe("DIST");
    expect(fill.price).toBeCloseTo(0.00019920060, 12);
    expect(fill.txSig).toBeUndefined();
  });

  it("fills a buy at the snapshot price when liquidity is unknown (no impact)", async () => {
    const ex = new PaperExecutor();
    const snap = testSnapshot({ price: 0.0002, liquiditySol: undefined });
    const fill = await ex.execute(testOrder("buy", 200_000_000n), cfg, snap);
    expect(fill.outAmount).toBe(997_000_000n);
    expect(fill.price).toBeCloseTo(0.2 / 997, 12);
  });

  it("uses the quoter's outAmount when one is provided and falls back to the model when it fails", async () => {
    const calls: QuoteParams[] = [];
    const quoter: Quoter = {
      async quote(p) {
        calls.push(p);
        if (calls.length === 1) {
          const q: JupiterQuote = {
            inputMint: p.inputMint,
            outputMint: p.outputMint,
            inAmount: p.amount,
            outAmount: 123_456_789n,
            otherAmountThreshold: 123_000_000n,
            slippageBps: p.slippageBps,
            priceImpact: 0.001,
            hops: 1,
            raw: {},
          };
          return q;
        }
        throw new Error("jupiter down");
      },
    };
    const ex = new PaperExecutor({ quoter });
    const snap = testSnapshot();
    const live = await ex.execute(testOrder("sell", 1_000_000_000n), cfg, snap);
    expect(live.outAmount).toBe(123_456_789n);
    expect(calls[0]?.slippageBps).toBe(100);
    const modelled = await ex.execute(testOrder("sell", 1_000_000_000n), cfg, snap);
    expect(modelled.outAmount).toBe(199_200_600n);
  });

  it("rejects orders whose mints do not match the project", async () => {
    const ex = new PaperExecutor();
    const bad = testOrder("buy", 1_000_000n, { inputMint: cfg.mint, outputMint: cfg.mint });
    await expect(ex.execute(bad, cfg, testSnapshot())).rejects.toBeInstanceOf(ExecError);
    await expect(ex.execute(testOrder("buy", 0n), cfg, testSnapshot())).rejects.toBeInstanceOf(ExecError);
  });
});
