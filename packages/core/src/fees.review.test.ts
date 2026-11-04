/**
 * Review tests: the fee split can never owe more than the gross fee, whatever the terms say. Project terms are
 * schema-checked, but the global defaults come straight from the environment, so computeFee itself must hold the line.
 */
import { describe, it, expect } from "vitest";
import { computeFee, feeTermsFor } from "./config.js";

type Terms = ReturnType<typeof feeTermsFor>;

const REF = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

function terms(over: Partial<Terms> = {}): Terms {
  return { volumeBps: 50, cashoutBps: 200, referralBps: 1000, discountBps: 1000, ...over };
}

function invariants(base: bigint, t: Terms, kind: "volume" | "cashout" = "volume"): void {
  const f = computeFee(base, t, kind);
  expect(f.grossLamports).toBeGreaterThanOrEqual(0n);
  expect(f.netLamports).toBeGreaterThanOrEqual(0n);
  expect(f.discountLamports).toBeGreaterThanOrEqual(0n);
  expect(f.referralLamports).toBeGreaterThanOrEqual(0n);
  expect(f.referralLamports).toBeLessThanOrEqual(f.grossLamports);
  expect(f.discountLamports + f.referralLamports + f.netLamports).toBeLessThanOrEqual(f.grossLamports);
  // The fee itself never exceeds the base amount it is charged on.
  expect(f.grossLamports).toBeLessThanOrEqual(base);
}

describe("computeFee", () => {
  it("splits exactly with valid terms: discount + referral + net = gross, all rounding down", () => {
    const f = computeFee(1_234_567_891n, terms({ referrerWallet: REF }), "volume");
    expect(f.grossLamports).toBe(6_172_839n); // 0.5%
    expect(f.discountLamports).toBe(617_283n); // 10% of gross
    expect(f.referralLamports).toBe(555_555n); // 10% of what remains
    expect(f.netLamports).toBe(5_000_001n);
    expect(f.discountLamports + f.referralLamports + f.netLamports).toBe(f.grossLamports);
    // No referrer: nothing is discounted or shared.
    const g = computeFee(1_234_567_891n, terms(), "volume");
    expect(g).toEqual({ grossLamports: 6_172_839n, discountLamports: 0n, referralLamports: 0n, netLamports: 6_172_839n });
  });

  it("holds the invariants on tiny and odd amounts", () => {
    for (const base of [0n, 1n, 2n, 199n, 200n, 9_999n, 10_000n, 10_001n, 123_456_789_012_345n]) {
      invariants(base, terms({ referrerWallet: REF }));
      invariants(base, terms({ referrerWallet: REF }), "cashout");
      invariants(base, terms());
    }
  });

  it("never owes more than gross, and never a negative net, when the terms come from a bad environment", () => {
    const bad: Partial<Terms>[] = [
      { referralBps: 20_000 }, // 200% referral share
      { discountBps: 20_000 }, // 200% discount
      { discountBps: 20_000, referralBps: 20_000 },
      { referralBps: -500 },
      { discountBps: -500 },
      { volumeBps: 20_000 }, // fee larger than the trade
      { volumeBps: -50 },
      { volumeBps: Number.NaN },
      { referralBps: Number.NaN },
      { discountBps: 12.5 },
      { volumeBps: Number.POSITIVE_INFINITY },
    ];
    for (const over of bad) {
      invariants(1_000_000_000n, terms({ ...over, referrerWallet: REF }));
      invariants(1_000_000_000n, terms({ ...over, referrerWallet: REF }), "cashout");
      invariants(1_000_000_000n, terms(over));
    }
  });
});
