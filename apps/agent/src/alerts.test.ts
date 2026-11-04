import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { solToLamports } from "@tenfold/core";
import { AlertPoller, formatEvent } from "./alerts.js";
import { fixture } from "./testkit.js";
import type { Fixture } from "./testkit.js";

let fx: Fixture;
beforeEach(() => {
  fx = fixture();
});
afterEach(() => fx.cleanup());

describe("formatEvent", () => {
  it("formats sell_pressure with level, SOL/hour and hours of budget", () => {
    // snapshot: sells 2, buys 1 over 5 min => 12 SOL/h; level 0.00018 has 4 SOL => 0.3 h
    const text = formatEvent({ type: "sell_pressure", projectId: "test", ts: Date.now(), data: { price: 0.00019 } }, fx.cfg, fx.ledger);
    expect(text).toBe("Heavy sell pressure at 0.00019, holding 0.00018 costs ~12 SOL/hour, budget lasts ~0.3 h. Hold, lower the level, or let it breathe?");
  });

  it("uses the engine's own numbers when the event carries them", () => {
    const text = formatEvent(
      { type: "sell_pressure", projectId: "test", ts: Date.now(), data: { price: 0.00019, level: 0.00018, costPerHourSol: 3, hoursLeft: 1.5 } },
      fx.cfg,
      fx.ledger,
    );
    expect(text).toMatch(/costs ~3 SOL\/hour, budget lasts ~1.5 h/);
  });

  it("formats the daily report as a short table-like text", () => {
    const now = Date.now();
    fx.ledger.insertSnapshot({ projectId: "test", ts: now - 3_600_000, price: 0.00018, buyFlow5mSol: 1, sellFlow5mSol: 1, vaultTokens: 1_000_000_000_000n, vaultLamports: solToLamports(50) });
    fx.ledger.insertOrder({
      projectId: "test",
      side: "sell",
      reason: "DIST",
      inputMint: fx.cfg.mint,
      outputMint: "So11111111111111111111111111111111111111112",
      amountIn: 2_000_000_000n,
      maxSlippageBps: 100,
      refPrice: 0.0002,
    });
    const order = fx.ledger.listOrders("test")[0]!;
    fx.ledger.insertFill({
      orderId: order.id,
      projectId: "test",
      side: "sell",
      reason: "DIST",
      inAmount: 2_000_000_000n,
      outAmount: solToLamports(0.4),
      price: 0.0002,
      feeLamports: 10_000n,
      ts: now - 60_000,
      paper: true,
    });
    const text = formatEvent({ type: "daily_report", projectId: "test", ts: now, data: {} }, fx.cfg, fx.ledger)!;
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^Test Token: 24h report \(/);
    expect(lines[1]).toMatch(/^Price: 0.00018 -> 0.0002 \+11.1%$/);
    expect(lines[2]).toBe("Fills: 1 (DIST 1)");
    expect(lines[3]).toMatch(/^Sold: 2,000 tokens for 0.4 SOL @ 0.0002 \(\+\d+ bps vs token VWAP\)$/);
    expect(lines[4]).toBe("Bought: 0 tokens for 0 SOL (defense 0 SOL)");
    expect(lines[5]).toBe("Fees: 0 SOL");
    expect(lines[6]).toBe("Vault: 1,000,000 tokens + 50 SOL");
  });

  it("skips small automatic fills but relays manual and defense fills above 0.5 SOL", () => {
    const base = { projectId: "test", ts: Date.now() };
    expect(formatEvent({ ...base, type: "order_filled", data: { side: "sell", reason: "DIST", inAmount: "2000000000", outAmount: solToLamports(0.4).toString() } }, fx.cfg, fx.ledger)).toBeUndefined();
    expect(formatEvent({ ...base, type: "order_filled", data: { side: "buy", reason: "DEF", inAmount: solToLamports(0.3).toString(), outAmount: "1500000000" } }, fx.cfg, fx.ledger)).toBeUndefined();
    expect(
      formatEvent({ ...base, type: "order_filled", data: { side: "buy", reason: "DEF", inAmount: solToLamports(1).toString(), outAmount: "5000000000", price: 0.0002 } }, fx.cfg, fx.ledger),
    ).toBe("Defense buy filled: 5,000 tokens for 1 SOL @ 0.0002.");
    expect(formatEvent({ ...base, type: "order_rejected", data: { side: "sell", code: "cap", reason: "Daily sell cap of 0.5% is used up for the next 24h." } }, fx.cfg, fx.ledger)).toBe(
      "Order rejected (sell) [cap]: Daily sell cap of 0.5% is used up for the next 24h.",
    );
    expect(formatEvent({ ...base, type: "config_changed", data: {} }, fx.cfg, fx.ledger)).toBeUndefined();
  });

  it("does not claim nothing was spent when a sent transaction's outcome is unknown", () => {
    const base = { projectId: "test", ts: Date.now() };
    const failed = formatEvent({ ...base, type: "order_failed", data: { side: "sell", error: "quote failed: no route" } }, fx.cfg, fx.ledger)!;
    expect(failed).toMatch(/^Order failed \(sell\): quote failed: no route\. Nothing was spent/);
    const unknown = formatEvent({ ...base, type: "order_failed", data: { side: "sell", error: "tx 5ig outcome unknown", txSig: "5ig" } }, fx.cfg, fx.ledger)!;
    expect(unknown).toMatch(/^Order unconfirmed \(sell\): tx 5ig outcome unknown\. It may have filled/);
    expect(unknown).not.toMatch(/Nothing was spent/);
  });
});

describe("AlertPoller", () => {
  it("sends one message per undelivered event to the bound chat, rate-limited, then marks delivered", async () => {
    const sent: { chatId: string; text: string }[] = [];
    const waits: number[] = [];
    let clock = 1_000_000;
    fx.ledger.insertEvent({ type: "paused", projectId: "test", ts: Date.now(), data: { by: "founder" } });
    fx.ledger.insertEvent({ type: "resumed", projectId: "test", ts: Date.now(), data: {} });
    fx.ledger.insertEvent({ type: "order_proposed", projectId: "test", ts: Date.now(), data: {} });
    fx.ledger.insertEvent({ type: "paused", projectId: "unbound", ts: Date.now(), data: {} });
    const poller = new AlertPoller({
      ledger: fx.ledger,
      projects: () => [fx.cfg],
      send: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    expect(await poller.tick()).toBe(2);
    expect(sent).toEqual([
      { chatId: "424242", text: "Paused (founder). No new orders until resumed." },
      { chatId: "424242", text: "Resumed. Defense, distribution and rebalancing are live again." },
    ]);
    expect(waits).toEqual([1000]);
    expect(fx.ledger.undeliveredEvents()).toHaveLength(0);
  });

  it("keeps an event undelivered when sending fails", async () => {
    fx.ledger.insertEvent({ type: "resumed", projectId: "test", ts: Date.now(), data: {} });
    const poller = new AlertPoller({
      ledger: fx.ledger,
      projects: () => [fx.cfg],
      send: async () => {
        throw new Error("telegram down");
      },
      sleep: async () => undefined,
    });
    expect(await poller.tick()).toBe(0);
    expect(fx.ledger.undeliveredEvents()).toHaveLength(1);
  });
});
