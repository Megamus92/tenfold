import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "@solana/web3.js";
import { seededRng } from "@tenfold/core";
import { FeedError, JupiterFeed, SimFeed, buyPriceFromQuote, flowFromDexScreener, liquidityFromImpact, sellPriceFromQuote } from "./feed.js";
import { parseQuote, JupiterError } from "./jupiter.js";
import { HttpError } from "./http.js";
import { testConfig } from "./testutil.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A Connection double exposing only the two RPC methods the feed uses. */
function fakeRpc(lamports: number, tokenAmount: string | null): Connection {
  const rpc = {
    getBalance: async () => lamports,
    getTokenAccountBalance: async () => {
      if (tokenAmount === null) throw new Error("failed to get token account balance: Invalid param: could not find account");
      return { context: { slot: 1 }, value: { amount: tokenAmount, decimals: 6, uiAmount: null } };
    },
  };
  return rpc as unknown as Connection;
}

describe("SimFeed", () => {
  const cfg = testConfig();

  it("is deterministic for the same seed and differs across seeds", async () => {
    const make = (seed: number) =>
      new SimFeed({ startPrice: 0.0002, driftPerStep: 0, volPerStep: 0.02, vaultTokens: 1_000_000n, vaultLamports: 5_000_000_000n, rng: seededRng(seed) });
    const a = make(7);
    const b = make(7);
    const c = make(8);
    const pa: number[] = [];
    const pb: number[] = [];
    const pc: number[] = [];
    for (let i = 0; i < 50; i++) {
      pa.push(a.step());
      pb.push(b.step());
      pc.push(c.step());
    }
    expect(pa).toEqual(pb);
    expect(pa).not.toEqual(pc);
    expect(pa.every((p) => p > 0)).toBe(true);
    const sa = await a.snapshot(cfg);
    const sb = await b.snapshot(cfg);
    expect(sa).toEqual(sb);
    expect(sa.price).toBe(pa[49]);
    expect(sa.buyFlow5mSol + sa.sellFlow5mSol).toBeGreaterThan(0);
  });

  it("drifts upward with positive drift and zero vol", () => {
    const f = new SimFeed({ startPrice: 1, driftPerStep: 0.01, volPerStep: 0, vaultTokens: 0n, vaultLamports: 0n, rng: seededRng(1) });
    for (let i = 0; i < 10; i++) f.step();
    expect(f.currentPrice).toBeCloseTo(1.01 ** 10, 10);
    expect(f.tick).toBe(10);
  });

  it("applies fills to the simulated balances", async () => {
    const f = new SimFeed({ startPrice: 0.0002, driftPerStep: 0, volPerStep: 0, vaultTokens: 1_000_000_000n, vaultLamports: 1_000_000_000n, rng: seededRng(3) });
    f.applyFill({ side: "sell", inAmount: 100_000_000n, outAmount: 20_000_000n, feeLamports: 5_000n });
    let s = await f.snapshot(cfg);
    expect(s.vaultTokens).toBe(900_000_000n);
    expect(s.vaultLamports).toBe(1_019_995_000n);
    f.applyFill({ side: "buy", inAmount: 19_995_000n, outAmount: 50_000_000n, feeLamports: 5_000n });
    s = await f.snapshot(cfg);
    expect(s.vaultTokens).toBe(950_000_000n);
    expect(s.vaultLamports).toBe(1_000_000_000n - 5_000n);
  });
});

describe("quote helpers", () => {
  it("derives prices from both quote directions", () => {
    const buy = parseQuote({ inputMint: "a", outputMint: "b", inAmount: "100000000", outAmount: "500000000000", priceImpactPct: "0.0123", routePlan: [{}, {}] });
    expect(buy.priceImpact).toBeCloseTo(0.0123);
    expect(buy.hops).toBe(2);
    // 0.1 SOL for 500,000 tokens (6 decimals) = 0.0000002 SOL/token
    expect(buyPriceFromQuote(buy, 6)).toBeCloseTo(2e-7, 15);
    const sell = parseQuote({ inAmount: "500000000000", outAmount: "100000000" });
    expect(sellPriceFromQuote(sell, 6)).toBeCloseTo(2e-7, 15);
    expect(liquidityFromImpact(1, 0.02)).toBe(50);
    expect(liquidityFromImpact(1, 0)).toBeUndefined();
  });

  it("rejects malformed quote bodies with JupiterError", () => {
    expect(() => parseQuote({ error: "Could not find any route" })).toThrowError(JupiterError);
    expect(() => parseQuote({ inAmount: "abc", outAmount: "1" })).toThrowError(JupiterError);
    expect(() => parseQuote("nope")).toThrowError(JupiterError);
  });

  it("splits DexScreener 5m volume by txn counts for the deepest SOL pair, zero when missing", () => {
    const body = {
      pairs: [
        { liquidity: { usd: 1000 }, txns: { m5: { buys: 1, sells: 1 } }, volume: { m5: 1000 }, priceUsd: "1", priceNative: "0.01", quoteToken: { symbol: "SOL" } },
        { liquidity: { usd: 50000 }, txns: { m5: { buys: 3, sells: 1 } }, volume: { m5: 400 }, priceUsd: "0.02", priceNative: "0.0001", quoteToken: { symbol: "SOL" } },
      ],
    };
    // deepest pair: 400 USD at 200 USD/SOL = 2 SOL, split 3:1
    const f = flowFromDexScreener(body);
    expect(f.buyFlow5mSol).toBeCloseTo(1.5, 9);
    expect(f.sellFlow5mSol).toBeCloseTo(0.5, 9);
    expect(flowFromDexScreener({ pairs: [] })).toEqual({ buyFlow5mSol: 0, sellFlow5mSol: 0 });
    expect(flowFromDexScreener(null)).toEqual({ buyFlow5mSol: 0, sellFlow5mSol: 0 });
    expect(flowFromDexScreener({ pairs: [{ liquidity: { usd: 1 } }] })).toEqual({ buyFlow5mSol: 0, sellFlow5mSol: 0 });
  });
});

describe("JupiterFeed", () => {
  const cfg = testConfig();

  it("builds a snapshot from quotes, DexScreener and the RPC", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/swap/v1/quote")) {
        const u = new URL(url);
        const amount = u.searchParams.get("amount");
        const input = u.searchParams.get("inputMint");
        if (input === cfg.mint) {
          // sell leg: 500,000 tokens -> 0.099 SOL
          return jsonResponse({ inAmount: amount, outAmount: "99000000", priceImpactPct: "0.001" });
        }
        if (amount === "100000000") return jsonResponse({ inAmount: amount, outAmount: "500000000000", priceImpactPct: "0.001" });
        // 1 SOL impact quote: 2% impact -> 50 SOL depth
        return jsonResponse({ inAmount: amount, outAmount: "4900000000000", priceImpactPct: "0.02" });
      }
      if (url.includes("dexscreener")) {
        return jsonResponse({
          pairs: [{ liquidity: { usd: 100 }, txns: { m5: { buys: 2, sells: 2 } }, volume: { m5: 400 }, priceUsd: "0.02", priceNative: "0.0001", quoteToken: { symbol: "SOL" } }],
        });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const feed = new JupiterFeed(fakeRpc(3_000_000_000, "123456"));
    const s = await feed.snapshot(cfg);
    // buy price 0.1/500000 = 2e-7, sell price 0.099/500000 = 1.98e-7, mid 1.99e-7
    expect(s.price).toBeCloseTo(1.99e-7, 15);
    expect(s.liquiditySol).toBeCloseTo(50, 9);
    expect(s.buyFlow5mSol).toBeCloseTo(1, 9);
    expect(s.sellFlow5mSol).toBeCloseTo(1, 9);
    expect(s.vaultLamports).toBe(3_000_000_000n);
    expect(s.vaultTokens).toBe(123_456n);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("treats a missing ATA as zero tokens and a DexScreener outage as zero flow", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/swap/v1/quote")) return jsonResponse({ inAmount: "100000000", outAmount: "500000000000", priceImpactPct: "0.001" });
        throw new Error("fetch failed");
      }),
    );
    const feed = new JupiterFeed(fakeRpc(0, null));
    const s = await feed.snapshot(cfg);
    expect(s.vaultTokens).toBe(0n);
    expect(s.buyFlow5mSol).toBe(0);
    expect(s.sellFlow5mSol).toBe(0);
    expect(s.price).toBeGreaterThan(0);
  });

  it("throws a non-retryable FeedError when Jupiter has no route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/swap/v1/quote")) return jsonResponse({ error: "Could not find any route" }, 400);
        return jsonResponse({ pairs: [] });
      }),
    );
    const feed = new JupiterFeed(fakeRpc(0, "0"));
    const err = await feed.snapshot(cfg).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeedError);
    expect((err as FeedError).retryable).toBe(false);
    expect((err as FeedError).cause).toBeInstanceOf(HttpError);
  });

  it("throws a retryable FeedError on 429 and on a timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "rate limited" }, 429)));
    const feed = new JupiterFeed(fakeRpc(0, "0"));
    const err429 = await feed.snapshot(cfg).catch((e: unknown) => e);
    expect(err429).toBeInstanceOf(FeedError);
    expect((err429 as FeedError).retryable).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        throw e;
      }),
    );
    const errTimeout = await feed.snapshot(cfg).catch((e: unknown) => e);
    expect(errTimeout).toBeInstanceOf(FeedError);
    expect((errTimeout as FeedError).retryable).toBe(true);
  });
});
