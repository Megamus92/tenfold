import { describe, expect, it } from "vitest";
import { solToLamports, tokensToBase } from "@tenfold/core";
import type { Coverage, DailyReport } from "@tenfold/core";
import { X_MAX_CHARS, badgeChange, compose, dailyRecap, hypeWords, isDowngrade, levelDefended, milestone, registerOf, withdrawalNotice } from "./drafts.js";
import type { Draft, DraftContext } from "./drafts.js";
import { PROOF, T0, project } from "./testkit.js";

const ctx = (tone?: string, over: Record<string, unknown> = {}): DraftContext => ({
  cfg: project({ marketing: { mode: "approve", xHandle: "alphacoin", ...(tone ? { tone } : {}) }, ...over }),
  proofBaseUrl: PROOF,
});

const report = (over: Partial<DailyReport> = {}): DailyReport => ({
  projectId: "alpha",
  from: T0 - 86_400_000,
  to: T0,
  fills: 9,
  byReason: { DIST: 6, DEF: 3 },
  soldTokens: tokensToBase(3_000, 6),
  soldProceedsLamports: solToLamports(0.6),
  boughtTokens: tokensToBase(5_000, 6),
  boughtCostLamports: solToLamports(0.9),
  defenseLamports: solToLamports(0.9),
  feesLamports: 50_000n,
  priceOpen: 0.00018,
  priceClose: 0.0002,
  vaultTokens: tokensToBase(997_000, 6),
  vaultLamports: solToLamports(49.7),
  ...over,
});

const coverage: Coverage = {
  projectId: "alpha",
  ts: T0,
  tier: "managed",
  data: {
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    lpSecured: true,
    dangerousExtensions: [],
    totalSupply: "1000000000000000",
    insiderWallets: [],
    insiderOutsidePct: 3.2,
    vaultPct: 10,
    insiderSellCount: 0,
    reasons: [],
  },
};

function clean(d: Draft | undefined): Draft {
  expect(d).toBeDefined();
  const draft = d!;
  expect(draft.x.length).toBeLessThanOrEqual(X_MAX_CHARS);
  expect(hypeWords(draft.x, ["Alpha Coin", "alphacoin"])).toEqual([]);
  expect(hypeWords(draft.telegram, ["Alpha Coin", "alphacoin"])).toEqual([]);
  expect(draft.x).toContain(`${PROOF}/p/alpha`);
  expect(draft.telegram).toContain(`${PROOF}/p/alpha`);
  expect(draft.x).toContain("@alphacoin");
  return draft;
}

/** Every number-like token in the text, so two tones can be compared on facts alone. */
function numbers(s: string): string[] {
  return (s.match(/\d[\d,.]*%?/g) ?? []).map((n) => n.replace(/[.,]$/, ""));
}

describe("dailyRecap", () => {
  it("states volume by reason, cap used, price open->close, badge and anchor, within the X limit", () => {
    const d = clean(
      dailyRecap(report(), coverage, ctx(), {
        volumeByReasonSol: { DIST: 0.6, DEF: 0.9 },
        anchor: { projectId: "alpha", day: "2026-10-29", hash: "abcdef0123456789abcdef", entries: 9, ts: T0 },
      }),
    );
    expect(d.kind).toBe("daily_recap");
    expect(d.key).toBe("daily_recap:2026-10-30");
    expect(d.x).toContain("9 fills, 1.5 SOL: DEF 0.9, DIST 0.6");
    expect(d.x).toContain("Price 0.00018 -> 0.0002 SOL (+11.1%)");
    // sold 3,000 of a 1,000,000 base at a 0.5% cap (5,000 tokens) = 60% used
    expect(d.x).toContain("Sell cap 0.5% of vault, 60% used");
    expect(d.x).toContain("Log hash abcdef0123...");
    expect(d.telegram).toContain("DEF (defense buys): 0.9 SOL");
    expect(d.telegram).toContain("Badge: managed");
    expect(d.telegram).toContain("sha256 abcdef0123456789abcdef");
    expect(d.telegram).toContain("Sold: 3,000 tokens for 0.6 SOL");
  });

  it("mentions LP fees only when there are some, and says 'no vault trades' for a quiet day", () => {
    const quiet = clean(dailyRecap(report({ fills: 0, byReason: {}, soldTokens: 0n, soldProceedsLamports: 0n, boughtTokens: 0n, boughtCostLamports: 0n, defenseLamports: 0n }), undefined, ctx()));
    expect(quiet.x).toContain("No vault trades");
    expect(quiet.x).not.toContain("LP fees");
    const lp = clean(dailyRecap(report(), undefined, ctx(), { lpFeesSol: 0.05 }));
    expect(lp.x).toContain("LP fees earned 0.05 SOL");
  });

  it("returns nothing when there is no price and no fill in the window", () => {
    expect(dailyRecap(report({ fills: 0, priceOpen: undefined, priceClose: undefined }), undefined, ctx())).toBeUndefined();
  });

  it("changes the register with the tone but never the numbers", () => {
    const neutral = clean(dailyRecap(report(), coverage, ctx()));
    const casual = clean(dailyRecap(report(), coverage, ctx("keep it casual and friendly")));
    const formal = clean(dailyRecap(report(), coverage, ctx("formal, institutional")));
    expect(casual.x).not.toBe(neutral.x);
    expect(formal.x).not.toBe(neutral.x);
    expect(numbers(casual.x)).toEqual(numbers(neutral.x));
    expect(numbers(formal.x)).toEqual(numbers(neutral.x));
  });

  it("drops low-priority segments before the link when the project name is long", () => {
    const long = ctx(undefined, { name: "A".repeat(80) });
    const d = clean(dailyRecap(report(), coverage, long, { volumeByReasonSol: { DIST: 0.6, DEF: 0.9, REB: 0.2, MANUAL: 0.1 } }));
    expect(d.x.endsWith(`${PROOF}/p/alpha`)).toBe(true);
  });
});

describe("milestone", () => {
  it("posts volume, holders and days from the value passed in", () => {
    expect(clean(milestone("volume", 1000, ctx())).x).toContain("passed 1000 SOL of vault trading volume");
    expect(clean(milestone("holders", 2500, ctx())).x).toContain("2,500 holders");
    expect(clean(milestone("days", 30, ctx())).x).toContain("30 days managed by Tenfold");
  });

  it("refuses values that are not real data", () => {
    expect(milestone("holders", 0, ctx())).toBeUndefined();
    expect(milestone("holders", 12.5, ctx())).toBeUndefined();
    expect(milestone("volume", Number.NaN, ctx())).toBeUndefined();
    expect(milestone("days", -1, ctx())).toBeUndefined();
  });
});

describe("levelDefended", () => {
  it("says what the level cost, in how many buys, over how long, with the low", () => {
    const d = clean(levelDefended({ level: 0.00018, spentSol: 2.4, fills: 7, durationMin: 45, lowPrice: 0.000176, ts: T0 }, ctx()));
    expect(d.x).toBe(`Alpha Coin (@alphacoin): the 0.00018 level held. Tenfold spent 2.4 SOL in 7 real buys over 45 min. Low 0.000176. Fills: ${PROOF}/p/alpha`);
  });

  it("needs a positive spend", () => {
    expect(levelDefended({ level: 0.00018, spentSol: 0 }, ctx())).toBeUndefined();
  });
});

describe("withdrawalNotice", () => {
  it("covers requested, settled and cancelled, with delay and tx", () => {
    const req = clean(withdrawalNotice({ status: "requested", amountSol: 10, settlesAt: T0 + 86_400_000 }, ctx()));
    expect(req.x).toContain("requested a withdrawal of 10 SOL from the vault. It settles after the 24h delay, at 2026-10-31 12:00 UTC.");
    const settled = clean(withdrawalNotice({ status: "settled", amountSol: 10, amountTokens: 50_000, txSig: "5KtPn3abcdef" }, ctx()));
    expect(settled.x).toContain("a withdrawal of 10 SOL and 50,000 tokens from the Alpha Coin (@alphacoin) vault settled after the 24h delay. tx 5KtPn3ab...");
    const cancelled = clean(withdrawalNotice({ status: "cancelled", amountSol: 3 }, ctx()));
    expect(cancelled.x).toContain("was cancelled before the 24h delay ended");
  });

  it("returns nothing without an amount", () => {
    expect(withdrawalNotice({ status: "requested" }, ctx())).toBeUndefined();
  });
});

describe("badgeChange", () => {
  it("posts upgrades with the reasons", () => {
    const d = clean(badgeChange({ from: "managed", to: "gold", reasons: ["every insider wallet is in the vault or locked", "LP burned."] }, ctx()));
    expect(d.x).toContain("badge: managed -> gold. Why: every insider wallet is in the vault or locked. LP burned.");
    expect(d.x).not.toContain("Downgrades");
  });

  it("posts downgrades too, and says so", () => {
    const d = clean(badgeChange({ from: "gold", to: "flagged", reasons: ["insider wallet 3Kd9...sold 1.2% of supply outside the vault"] }, ctx()));
    expect(d.x).toContain("gold -> flagged");
    expect(d.x).toContain("Downgrades are posted like upgrades.");
    expect(isDowngrade({ from: "gold", to: "flagged" })).toBe(true);
    expect(isDowngrade({ from: "beta", to: "managed" })).toBe(false);
  });

  it("ignores a no-op or unknown change, including the first assignment (from: null)", () => {
    expect(badgeChange({ from: "gold", to: "gold", reasons: [] }, ctx())).toBeUndefined();
    expect(badgeChange({ from: null as unknown as "beta", to: "beta", reasons: [] }, ctx())).toBeUndefined();
  });

  it("keeps the first reason on X and drops the later ones first when space runs out", () => {
    const reasons = ["insider wallet 3Kd9 sold 1.2% of supply outside the vault", "x".repeat(120), "y".repeat(120)];
    const d = clean(badgeChange({ from: "gold", to: "flagged", reasons }, ctx()));
    expect(d.x).toContain("Why: insider wallet 3Kd9 sold 1.2% of supply outside the vault.");
    expect(d.x).not.toContain("xxxx");
    expect(d.telegram).toContain("  - " + "x".repeat(120));
  });
});

describe("guards", () => {
  it("maps tones to registers", () => {
    expect(registerOf(undefined)).toBe("neutral");
    expect(registerOf("casual, like a friend")).toBe("casual");
    expect(registerOf("Professional and formal")).toBe("formal");
    expect(registerOf("whatever")).toBe("neutral");
  });

  it("flags hype words but not the project's own name", () => {
    expect(hypeWords("this is going to the moon, massive", ["Moon Coin"])).toEqual(["moon", "to the moon", "massive"]);
    expect(hypeWords("Moon Coin daily recap", ["Moon Coin"])).toEqual([]);
    expect(hypeWords("pumpkin season")).toEqual([]);
  });

  it("compose keeps mandatory segments and drops optional ones from the lowest priority", () => {
    const text = compose(
      [
        { text: "lead", priority: 0 },
        { text: "x".repeat(100), priority: 1 },
        { text: "y".repeat(100), priority: 2 },
        { text: "link", priority: 0 },
      ],
      120,
    );
    expect(text).toBe(`lead ${"x".repeat(100)} link`);
  });
});
