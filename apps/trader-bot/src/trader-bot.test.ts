import { describe, it, expect, afterAll } from "vitest";
import { DEFAULT_RULES, DEFAULT_STRATEGY, Ledger, WSOL_MINT, parseProjectConfig, solToLamports, tokensToBase, type ProjectConfig } from "@tenfold/core";
import { base58Decode, extractMints, isPubkey } from "./mint.js";
import { lookupMint } from "./lookup.js";
import { formatLookup, formatUnknown, fmtPct, proofUrl, START_TEXT } from "./format.js";
import { RateLimiter, replyFor } from "./bot.js";

const MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const FOUNDER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const TX = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const BASE = "https://proof.tenfold.xyz/";
const DAY = 86_400_000;

function cfg(): ProjectConfig {
  return parseProjectConfig({
    id: "test",
    name: "Test Token",
    mint: MINT,
    decimals: 6,
    walletPubkey: WALLET,
    mode: "live",
    rules: { ...DEFAULT_RULES, dailySellCapPct: 0.5 },
    strategy: { ...DEFAULT_STRATEGY },
    createdAt: 1_700_000_000_000,
    paused: false,
  });
}

/** Ledger with one project, a snapshot, one sell today (40% of the cap), a coverage row and one insider sell. */
function seed(now: number): Ledger {
  const l = new Ledger(":memory:");
  const c = cfg();
  l.upsertProject(c);
  l.insertSnapshot({ projectId: "test", ts: now - 60_000, price: 0.0002, buyFlow5mSol: 1, sellFlow5mSol: 1, vaultTokens: tokensToBase(998_000, 6), vaultLamports: solToLamports(50) });
  const o = l.insertOrder({ projectId: "test", side: "sell", reason: "DIST", inputMint: MINT, outputMint: WSOL_MINT, amountIn: tokensToBase(2_000, 6), maxSlippageBps: 100, refPrice: 0.0002, status: "approved" });
  l.insertFill({ orderId: o.id, projectId: "test", side: "sell", reason: "DIST", inAmount: tokensToBase(2_000, 6), outAmount: solToLamports(0.4), price: 0.0002, feeLamports: 5000n, ts: now - 3_600_000, paper: false });
  l.insertCoverage({
    projectId: "test",
    ts: now - 1_800_000,
    tier: "flagged",
    data: {
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: false,
      lpSecured: true,
      dangerousExtensions: [],
      totalSupply: "1000000000000000",
      insiderWallets: [{ wallet: FOUNDER, pctOfSupply: 7, declared: true, locked: false }],
      insiderOutsidePct: 7,
      vaultPct: 10,
      insiderSellCount: 1,
      reasons: ["Mint authority revoked", "Freeze authority still active: holders can be frozen", "1 insider sell in the last 30 days"],
    },
  });
  l.recordInsiderSell({ projectId: "test", wallet: FOUNDER, ts: now - 2 * DAY, amount: 10_000_000_000_000n, txSig: TX, pctOfSupply: 1 });
  return l;
}

describe("mint extraction", () => {
  it("decodes base58 and recognises 32-byte keys only", () => {
    expect(base58Decode(MINT)?.length).toBe(32);
    expect(base58Decode("11111111111111111111111111111111")?.every((b) => b === 0)).toBe(true);
    expect(base58Decode("0OIl")).toBeUndefined();
    expect(isPubkey(MINT)).toBe(true);
    expect(isPubkey(TX)).toBe(false);
    expect(isPubkey("abc")).toBe(false);
  });

  it("finds mints in plain text and in links, ignores signatures and duplicates", () => {
    expect(extractMints(`is ${MINT} legit?`)).toEqual([MINT]);
    expect(extractMints(`https://solscan.io/token/${MINT}`)).toEqual([MINT]);
    expect(extractMints(`https://pump.fun/coin/${MINT} and ${WALLET}`)).toEqual([MINT, WALLET]);
    expect(extractMints(`${MINT} ${MINT}`)).toEqual([MINT]);
    expect(extractMints(`tx ${TX}`)).toEqual([]);
    expect(extractMints("gm")).toEqual([]);
    expect(extractMints("")).toEqual([]);
  });
});

describe("lookup and format", () => {
  const now = Date.now();
  const ledger = seed(now);
  afterAll(() => ledger.close());

  it("reads the project, its coverage, cap usage and 7 day insider sells from the ledger", () => {
    const v = lookupMint(ledger, MINT, now);
    expect(v).toBeDefined();
    expect(v).toMatchObject({ id: "test", name: "Test Token", tier: "flagged", dailySellCapPct: 0.5, withdrawalDelayHours: 24, vaultPct: 10, insiderOutsidePct: 7, insiderSells7d: 1 });
    expect(v?.capUsedTodayPct).toBe(40);
    expect(v?.statement).toBe(
      `Tenfold FLAGGED: an insider wallet sold since onboarding (1 sell); 7% of supply held by insiders outside the vault; last insider sell: ${new Date(now - 2 * DAY).toISOString().slice(0, 10)}`,
    );
    expect(lookupMint(ledger, WSOL_MINT, now)).toBeUndefined();
  });

  it("formats the managed reply with every figure, the proof link and the Solscan link", () => {
    const v = lookupMint(ledger, MINT, now);
    if (!v) throw new Error("expected a view");
    const text = formatLookup(v, BASE);
    expect(text.split("\n")[0]).toBe("Test Token: Flagged by Tenfold");
    expect(text).toContain("Tenfold FLAGGED:");
    expect(text).toContain("Daily sell cap: 0.5% of vault tokens per 24h, 40% used today");
    expect(text).toContain("Withdrawal delay: 24 h");
    expect(text).toContain("Vault share of supply: 10%");
    expect(text).toContain("Insiders outside vault and locks: 7%");
    expect(text).toContain("Insider sells (7d): 1");
    expect(text).toContain("- Freeze authority still active: holders can be frozen");
    expect(text).toContain(`Proof: https://proof.tenfold.xyz/p/test`);
    expect(text).toContain(`Solscan: https://solscan.io/token/${MINT}`);
    expect(text.length).toBeLessThan(4000);
  });

  it("handles a project with no coverage yet and the unknown case", () => {
    const l = new Ledger(":memory:");
    l.upsertProject({ ...cfg(), mode: "paper", paused: true });
    const v = lookupMint(l, MINT, now);
    expect(v?.tier).toBe("beta");
    expect(v?.vaultPct).toBeNull();
    expect(v?.statement).toMatch(/supply coverage not checked yet$/);
    const text = formatLookup(v as NonNullable<typeof v>, BASE);
    expect(text).toContain("Managed by Tenfold, beta (paper) (paused)");
    expect(text).toContain("Vault share of supply: n/a");
    expect(text).toContain("Coverage checked: not yet");
    expect(text).not.toContain("Why:");
    l.close();

    const unknown = formatUnknown(WSOL_MINT);
    expect(unknown.split("\n")[0]).toBe(`Not managed by Tenfold: ${WSOL_MINT}`);
    expect(unknown.split("\n")).toHaveLength(2);
    expect(unknown).toContain("daily sell cap");
  });

  it("helpers", () => {
    expect(fmtPct(40)).toBe("40%");
    expect(fmtPct(0.5)).toBe("0.5%");
    expect(fmtPct(null)).toBe("n/a");
    expect(proofUrl("https://x.y/", "abc")).toBe("https://x.y/p/abc");
    expect(START_TEXT.split("\n")).toHaveLength(3);
  });
});

describe("replyFor and rate limit", () => {
  const now = Date.now();
  const ledger = seed(now);
  afterAll(() => ledger.close());

  it("answers each mint in the message, nothing when there is none", () => {
    expect(replyFor(ledger, "hello", BASE, now)).toBeUndefined();
    const one = replyFor(ledger, `check ${MINT}`, BASE, now);
    expect(one).toContain("Test Token: Flagged by Tenfold");
    const two = replyFor(ledger, `${MINT} vs ${WSOL_MINT}`, BASE, now);
    expect(two).toContain("Test Token");
    expect(two).toContain(`Not managed by Tenfold: ${WSOL_MINT}`);
  });

  it("allows one reply per chat every 2 s", () => {
    const rl = new RateLimiter(2000);
    expect(rl.allow("a", 1000)).toBe(true);
    expect(rl.allow("a", 2500)).toBe(false);
    expect(rl.allow("b", 2500)).toBe(true);
    expect(rl.allow("a", 3000)).toBe(true);
    expect(rl.allow("a", 4999)).toBe(false);
    expect(rl.allow("a", 5000)).toBe(true);
  });
});
