import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  DEFAULT_RULES,
  DEFAULT_STRATEGY,
  Ledger,
  WSOL_MINT,
  parseProjectConfig,
  solToLamports,
  tokensToBase,
  type Fill,
  type ProjectConfig,
  type ReasonCode,
  type Side,
} from "@tenfold/core";
import { projectView, verifyView, verifySignature, trackRecord, canonicalJson } from "./api.js";
import { renderProjectPage, renderIndex } from "./html.js";
import { buildServer } from "./server.js";

const MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const OTHER_MINT = "So11111111111111111111111111111111111111112";
const TX = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const SECRET = "test-secret";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function cfg(): ProjectConfig {
  return parseProjectConfig({
    id: "test",
    name: "Test Token",
    mint: MINT,
    decimals: 6,
    walletPubkey: WALLET,
    mode: "paper",
    rules: { ...DEFAULT_RULES, dailySellCapPct: 0.5, defenseBudgetSol: 10, maxDefenseSpendPerDaySol: 4 },
    strategy: { ...DEFAULT_STRATEGY, distribution: { enabled: true, pctOfVaultPerDay: 0.5, mode: "strength" } },
    createdAt: Date.now() - 10 * DAY,
    paused: false,
  });
}

interface FillSpec {
  side: Side;
  reason: ReasonCode;
  tokens: number;
  sol: number;
  ts: number;
  txSig?: string;
  paper?: boolean;
}

/** Insert an order and its fill so the ledger looks like the engine wrote it. */
function fill(l: Ledger, s: FillSpec): Fill {
  const tokenBase = tokensToBase(s.tokens, 6);
  const lamports = solToLamports(s.sol);
  const o = l.insertOrder({
    projectId: "test",
    side: s.side,
    reason: s.reason,
    inputMint: s.side === "sell" ? MINT : WSOL_MINT,
    outputMint: s.side === "sell" ? WSOL_MINT : MINT,
    amountIn: s.side === "sell" ? tokenBase : lamports,
    maxSlippageBps: 100,
    refPrice: s.sol / s.tokens,
    status: "approved",
  });
  const f: Fill = {
    orderId: o.id,
    projectId: "test",
    side: s.side,
    reason: s.reason,
    inAmount: s.side === "sell" ? tokenBase : lamports,
    outAmount: s.side === "sell" ? lamports : tokenBase,
    price: s.sol / s.tokens,
    feeLamports: 5000n,
    ts: s.ts,
    txSig: s.txSig,
    paper: s.paper ?? true,
  };
  l.insertFill(f);
  return f;
}

function seed(now: number): { ledger: Ledger; cfg: ProjectConfig } {
  const l = new Ledger(":memory:");
  const c = cfg();
  l.upsertProject(c);
  const snap = (ts: number, buy: number, sell: number, tokens: number, sol: number): void =>
    l.insertSnapshot({ projectId: "test", ts, price: 0.0002, buyFlow5mSol: buy, sellFlow5mSol: sell, vaultTokens: tokensToBase(tokens, 6), vaultLamports: solToLamports(sol) });
  snap(now - 2 * DAY, 10, 10, 1_000_000, 50);
  snap(now - HOUR, 5, 5, 1_000_000, 50);
  snap(now - 60_000, 2, 3, 998_000, 50.2);
  // market flow over 30 days = 35 SOL
  fill(l, { side: "sell", reason: "DIST", tokens: 2_000, sol: 0.4, ts: now - 2 * HOUR, txSig: TX });
  fill(l, { side: "buy", reason: "DEF", tokens: 5_000, sol: 1, ts: now - 3 * HOUR });
  fill(l, { side: "buy", reason: "REB", tokens: 2_500, sol: 0.5, ts: now - 5 * DAY });
  fill(l, { side: "sell", reason: "DIST", tokens: 1_000, sol: 0.2, ts: now - 40 * DAY });
  l.recordDeposit("test", "sol", solToLamports(50), TX, "initial funding");
  return { ledger: l, cfg: c };
}

describe("projectView", () => {
  const now = Date.now();
  const { ledger, cfg: c } = seed(now);
  afterAll(() => ledger.close());
  const v = projectView(ledger, c, now);

  it("computes today's cap from the balance before today's sells", () => {
    expect(v.today.capTokens).toBe(5_000);
    expect(v.today.soldTokens).toBe(2_000);
    expect(v.today.capUsedPct).toBe(40);
    expect(v.today.defenseSpentSol).toBe(1);
    expect(v.today.defenseBudgetLeftSol).toBe(9);
  });

  it("sums 30 day volume by reason in SOL and excludes older fills", () => {
    expect(v.volumeByReason30d).toEqual({ DEF: 1, DIST: 0.4, REB: 0.5, LP: 0, MANUAL: 0 });
    expect(v.vaultShareOfVolume30d).toEqual({ pct: 5.4, label: "estimate" });
    expect(v.pnl.proceedsSol30d).toBe(0.4);
    expect(v.pnl.defenseSpentSol30d).toBe(1);
    expect(v.pnl.feesSol30d).toBeCloseTo(0.000015, 9);
  });

  it("lists every fill newest first, in display units, with deposits and vault", () => {
    expect(v.trades).toHaveLength(4);
    expect(v.trades[0]?.reason).toBe("DIST");
    expect(v.trades[0]?.tokens).toBe(2_000);
    expect(v.trades[0]?.sol).toBe(0.4);
    expect(v.trades[0]?.txSig).toBe(TX);
    expect(v.trades[3]?.ts).toBe(now - 40 * DAY);
    expect(v.deposits).toEqual([{ ts: expect.any(Number), kind: "sol", amount: 50, txSig: TX, note: "initial funding" }]);
    expect(v.vault).toEqual({ tokens: 998_000, sol: 50.2, price: 0.0002, valueSol: 998_000 * 0.0002 + 50.2 });
    expect(v.lastSnapshotTs).toBe(now - 60_000);
    expect(v.badge).toBe("managed");
    expect(v.rules).toEqual({ dailySellCapPct: 0.5, defenseBudgetSol: 10, maxDefenseSpendPerDaySol: 4, withdrawalDelayHours: 24 });
  });

  it("serializes without bigint", () => {
    expect(() => JSON.stringify(v)).not.toThrow();
    expect(JSON.stringify(v)).not.toMatch(/"\d{10,}n"/);
  });

  it("works for a project with no snapshot and no fills", () => {
    const l = new Ledger(":memory:");
    const c2 = { ...cfg(), id: "empty", name: "Empty" };
    l.upsertProject(c2);
    const e = projectView(l, c2, now);
    expect(e.today.capUsedPct).toBe(0);
    expect(e.vault.valueSol).toBe(0);
    expect(e.vaultShareOfVolume30d.pct).toBeNull();
    expect(e.lastSnapshotTs).toBeNull();
    expect(e.trades).toEqual([]);
    l.close();
  });
});

const FOUNDER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const LINKED = "3yFwqXBfZY4jBVUafQ1YEXw189y2dN3V5KQKpKDgPzNe";
const ESCROW = "F1ockEscrow1111111111111111111111111111111111";
const TX_SELL = "2ZE7Rz1sWuq6Lk4wWz9wYyA2a8Vb6rJd3mB5nGq7hT1pXfQ9cN4yJ8kL2vM6sR3tU5wX7zA9bC1dE3fG5hJ7kL9m";
const TX_ANCHOR = "4qYwZ8kL2vM6sR3tU5wX7zA9bC1dE3fG5hJ7kL9mN2pQ4rS6tU8vW1xY3zA5bC7dE9fG2hJ4kL6mN8pQ1rS3tU5v";
const HASH = "a".repeat(64);

/** Add a coverage row, two insider sells, fees (one swept) and two anchors on top of seed(). */
function seedBadge(ledger: Ledger, now: number): void {
  ledger.insertCoverage({
    projectId: "test",
    ts: now - HOUR,
    tier: "flagged",
    data: {
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: false,
      lpSecured: true,
      dangerousExtensions: ["transferFeeConfig"],
      totalSupply: tokensToBase(1_000_000_000, 6).toString(),
      insiderWallets: [
        { wallet: FOUNDER, pctOfSupply: 5, declared: true, locked: false },
        { wallet: LINKED, pctOfSupply: 2, declared: false, locked: false },
        { wallet: ESCROW, pctOfSupply: 25, declared: false, locked: true },
      ],
      insiderOutsidePct: 7,
      vaultPct: 10,
      insiderSellCount: 2,
      reasons: ["Mint authority revoked", "Freeze authority still active: holders can be frozen", "1 insider sell in the last 30 days"],
    },
  });
  ledger.recordInsiderSell({ projectId: "test", wallet: LINKED, ts: now - 2 * DAY, amount: tokensToBase(10_000_000, 6), txSig: TX_SELL, pctOfSupply: 1 });
  ledger.recordInsiderSell({ projectId: "test", wallet: FOUNDER, ts: now - 45 * DAY, amount: tokensToBase(1_000, 6), txSig: TX });
  const swept = ledger.accrueFee({ projectId: "test", kind: "volume", baseLamports: solToLamports(10), grossLamports: solToLamports(0.05), discountLamports: 0n, referralLamports: 0n, paper: true, ts: now - 3 * DAY });
  ledger.accrueFee({ projectId: "test", kind: "volume", baseLamports: solToLamports(4), grossLamports: solToLamports(0.02), discountLamports: solToLamports(0.002), referralLamports: solToLamports(0.0018), paper: true, ts: now - DAY });
  ledger.accrueFee({ projectId: "test", kind: "cashout", baseLamports: solToLamports(1), grossLamports: solToLamports(0.02), discountLamports: 0n, referralLamports: 0n, paper: true, ts: now - HOUR });
  ledger.markFeesSwept([swept], TX);
  ledger.insertAnchor({ projectId: "test", day: "2026-10-29", hash: HASH, entries: 12, txSig: TX_ANCHOR });
  ledger.insertAnchor({ projectId: "test", day: "2026-10-30", hash: "b".repeat(64), entries: 3 });
}

describe("badge, coverage, fees and anchors", () => {
  const now = Date.now();
  const { ledger, cfg: c } = seed(now);
  seedBadge(ledger, now);
  afterAll(() => ledger.close());
  const v = projectView(ledger, c, now);

  it("takes the tier from the latest coverage and derives the badge family", () => {
    expect(v.tier).toBe("flagged");
    expect(v.badge).toBe("flagged");
    expect(v.reasons).toHaveLength(3);
    expect(v.badgeStatement).toBe(
      `Tenfold FLAGGED: an insider wallet sold since onboarding (2 sells); 7% of supply held by insiders outside the vault; last insider sell: ${new Date(now - 2 * DAY).toISOString().slice(0, 10)}`,
    );
    expect(v.coverage).toMatchObject({ tier: "flagged", vaultPct: 10, insiderOutsidePct: 7, totalSupply: 1_000_000_000, mintAuthorityRevoked: true, freezeAuthorityRevoked: false, dangerousExtensions: ["transferFeeConfig"] });
    expect(v.coverage?.insiderWallets).toEqual([
      { wallet: FOUNDER, pctOfSupply: 5, declared: true, linked: false, locked: false },
      { wallet: LINKED, pctOfSupply: 2, declared: false, linked: true, locked: false },
      { wallet: ESCROW, pctOfSupply: 25, declared: false, linked: false, locked: true },
    ]);
  });

  it("lists insider sells newest first with the 30 day count", () => {
    expect(v.insiderSells).toHaveLength(2);
    expect(v.insiderSells[0]).toEqual({ ts: now - 2 * DAY, wallet: LINKED, tokens: 10_000_000, pctOfSupply: 1, txSig: TX_SELL });
    expect(v.insiderSells[1]?.pctOfSupply).toBeNull();
    expect(v.insiderSellCount30d).toBe(1);
  });

  it("sums fees in SOL with the project's terms, accrued vs swept", () => {
    expect(v.fees.terms).toEqual({ volumeBps: 50, cashoutBps: 200, referralBps: 1000, discountBps: 1000, referred: false });
    expect(v.fees.grossSol).toBeCloseTo(0.09, 9);
    expect(v.fees.discountSol).toBeCloseTo(0.002, 9);
    expect(v.fees.referralSol).toBeCloseTo(0.0018, 9);
    expect(v.fees.netSol).toBeCloseTo(0.0862, 9);
    expect(v.fees.sweptSol).toBeCloseTo(0.05, 9);
    expect(v.fees.accruedSol).toBeCloseTo(0.0362, 9);
    expect(v.fees.byKindSol).toEqual({ volume: 0.07, cashout: 0.02 });
  });

  it("lists anchors newest day first", () => {
    expect(v.anchors.map((a) => a.day)).toEqual(["2026-10-30", "2026-10-29"]);
    expect(v.anchors[1]).toMatchObject({ entries: 12, hash: HASH, txSig: TX_ANCHOR });
    expect(v.anchors[0]?.txSig).toBeNull();
  });

  it("renders the pill with the reasons, the four new sections and demotes the defense counter", () => {
    const html = renderProjectPage(v);
    expect(html).toContain('class="badge b-flagged"');
    expect(html).toContain("Flagged by Tenfold");
    expect(html).toContain('title="Mint authority revoked\nFreeze authority still active: holders can be frozen\n1 insider sell in the last 30 days"');
    expect(html).toContain("<li>Freeze authority still active: holders can be frozen</li>");
    expect(html).toContain('<p class="statement">Tenfold FLAGGED:');
    expect(html).toContain("<h2>Supply coverage</h2>");
    expect(html).toContain(`https://solscan.io/account/${FOUNDER}`);
    expect(html).toContain(`https://solscan.io/account/${ESCROW}`);
    expect(html).toContain('<span class="tag">declared</span>');
    expect(html).toContain('<span class="tag">linked</span>');
    expect(html).toContain('<span class="tag lock">locked</span>');
    expect(html).toContain("25.0%");
    expect(html).toContain("Insider sells");
    expect(html).toContain(`https://solscan.io/tx/${TX_SELL}`);
    expect(html).toContain("<h2>Fees</h2>");
    expect(html).toContain("50 bps on the SOL leg");
    expect(html).toContain("<td>Net to Tenfold</td>");
    expect(html).toContain("<td>Accrued, not yet swept</td>");
    expect(html).toContain("<h2>Daily log anchors</h2>");
    expect(html).toContain("so nobody, Tenfold included, can edit the record after the fact");
    expect(html).toContain(`https://solscan.io/tx/${TX_ANCHOR}`);
    expect(html).toContain("not posted yet");
    expect(html).toContain(`title="${HASH}"`);
    expect(html).toContain("<td>Defense budget left</td>");
    expect(html).not.toContain('<div class="k">Defense budget left</div>');
    expect(html).not.toContain("<script");
  });

  it("falls back to beta with a pending statement before the first coverage check", () => {
    const { ledger: l2, cfg: c2 } = seed(now);
    const e = projectView(l2, c2, now);
    expect(e.tier).toBe("beta");
    expect(e.badge).toBe("managed");
    expect(e.coverage).toBeNull();
    expect(e.reasons).toEqual(["No coverage check yet"]);
    expect(e.badgeStatement).toMatch(/^Tenfold Managed, beta: vault cannot dump through the MM .*supply coverage not checked yet$/);
    expect(e.insiderSells).toEqual([]);
    expect(e.anchors).toEqual([]);
    expect(e.fees.grossSol).toBe(0);
    const html = renderProjectPage(e);
    expect(html).toContain("Managed by Tenfold, beta");
    expect(html).toContain("No coverage check yet");
    expect(html).toContain("No insider sell since onboarding.");
    expect(html).toContain("No anchor yet.");
    l2.close();
  });

  it("signs tier, insider outside %, 30 day sells and the last anchor tx", () => {
    const s = verifyView(ledger, c, now, SECRET);
    expect(s).toMatchObject({ tier: "flagged", badge: "flagged", insiderOutsidePct: 7, insiderSellCount30d: 1, lastAnchorTx: TX_ANCHOR });
    expect(verifySignature(s, SECRET)).toBe(true);
    expect(verifySignature({ ...s, tier: "gold" }, SECRET)).toBe(false);
    expect(trackRecord(ledger, now)[0]).toMatchObject({ id: "test", tier: "flagged", badge: "flagged" });
    expect(renderIndex(trackRecord(ledger, now))).toContain("Flagged by Tenfold");
  });
});

describe("verifyView", () => {
  const now = Date.now();
  const { ledger, cfg: c } = seed(now);
  afterAll(() => ledger.close());

  it("signs the canonical payload and verifies only with the same secret", () => {
    const v = verifyView(ledger, c, now, SECRET);
    expect(v.mint).toBe(MINT);
    expect(v.wallet).toBe(WALLET);
    expect(v.capUsedTodayPct).toBe(40);
    expect(v.vaultTokens).toBe(998_000);
    expect(v.lastTradeTs).toBe(now - 2 * HOUR);
    expect(v.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySignature(v, SECRET)).toBe(true);
    expect(verifySignature(v, "other-secret")).toBe(false);
    expect(verifySignature({ ...v, capUsedTodayPct: 0 }, SECRET)).toBe(false);
  });

  it("canonical JSON is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: [{ d: null, c: "x" }] })).toBe('{"a":[{"c":"x","d":null}],"b":1}');
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("trackRecord", () => {
  it("lists every project with status and 30 day trade count", () => {
    const now = Date.now();
    const { ledger } = seed(now);
    const paused = { ...cfg(), id: "paused", name: "Paused", paused: true, mint: OTHER_MINT };
    ledger.upsertProject(paused);
    const rows = trackRecord(ledger, now);
    expect(rows).toHaveLength(2);
    const t = rows.find((r) => r.id === "test");
    expect(t).toMatchObject({ name: "Test Token", badge: "managed", status: "active", trades30d: 3, vaultSol: 50.2 });
    expect(rows.find((r) => r.id === "paused")).toMatchObject({ status: "paused", trades30d: 0, vaultSol: 0 });
    ledger.close();
  });
});

describe("html", () => {
  const now = Date.now();
  const { ledger, cfg: c } = seed(now);
  afterAll(() => ledger.close());

  it("renders the project page with name, reason pills, Solscan links and paper tag", () => {
    const html = renderProjectPage(projectView(ledger, c, now));
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Test Token");
    expect(html).toContain("Managed by Tenfold");
    expect(html).toContain('class="pill r-DIST"');
    expect(html).toContain('class="pill r-DEF"');
    expect(html).toContain(`https://solscan.io/token/${MINT}`);
    expect(html).toContain(`https://solscan.io/account/${WALLET}`);
    expect(html).toContain(`https://solscan.io/tx/${TX}`);
    expect(html).toContain('<span class="tag">paper</span>');
    expect(html).toContain("Strategy, levels and sizes are never shown.");
    expect(html).toContain("/api/project/test");
    expect(html).toContain(`/verify/${MINT}`);
    expect(html).toContain("40.0%");
    expect(html).not.toContain("<script");
  });

  it("escapes untrusted strings", () => {
    const v = projectView(ledger, { ...c, name: "<img src=x onerror=alert(1)>" }, now);
    const html = renderProjectPage(v);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("renders the index", () => {
    const html = renderIndex(trackRecord(ledger, now));
    expect(html).toContain('href="/p/test"');
    expect(html).toContain("Test Token");
    expect(html).toContain("3 trades / 30d");
    expect(renderIndex([])).toContain("No projects yet.");
  });
});

describe("server", () => {
  let clock = Date.now();
  const { ledger, cfg: c } = seed(clock);
  const app = buildServer({ ledger, signingSecret: SECRET, now: () => clock });
  beforeAll(() => app.ready());
  afterAll(async () => {
    await app.close();
    ledger.close();
  });

  it("GET /p/:id returns the page, unknown id is 404", async () => {
    const ok = await app.inject({ method: "GET", url: "/p/test" });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("text/html");
    expect(ok.headers["access-control-allow-origin"]).toBe("*");
    expect(ok.body).toContain("Test Token");
    const missing = await app.inject({ method: "GET", url: "/p/nope" });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({ method: "GET", url: "/p/NOT_VALID" });
    expect(bad.statusCode).toBe(404);
  });

  it("GET / lists projects", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('href="/p/test"');
  });

  it("GET /api/project/:id and /api/projects return JSON", async () => {
    const res = await app.inject({ method: "GET", url: "/api/project/test" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const body = res.json<{ id: string; trades: unknown[]; today: { capUsedPct: number } }>();
    expect(body.id).toBe("test");
    expect(body.trades).toHaveLength(4);
    expect(body.today.capUsedPct).toBe(40);
    const list = await app.inject({ method: "GET", url: "/api/projects" });
    expect(list.json<unknown[]>()).toHaveLength(1);
    expect(list.json<{ tier: string }[]>()[0]).toMatchObject({ id: "test", tier: "beta", badge: "managed" });
    const missing = await app.inject({ method: "GET", url: "/api/project/nope" });
    expect(missing.statusCode).toBe(404);
  });

  it("GET /verify/:mint returns a signed view, unknown mint is 404", async () => {
    const res = await app.inject({ method: "GET", url: `/verify/${MINT}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<Parameters<typeof verifySignature>[0]>();
    expect(body.badge).toBe("managed");
    expect(body).toMatchObject({ tier: "beta", insiderOutsidePct: null, insiderSellCount30d: 0, lastAnchorTx: null });
    expect(verifySignature(body, SECRET)).toBe(true);
    expect((await app.inject({ method: "GET", url: `/verify/${OTHER_MINT}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/verify/not-a-key" })).statusCode).toBe(404);
  });

  it("GET /healthz and CORS preflight", async () => {
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    const opt = await app.inject({ method: "OPTIONS", url: "/api/project/test" });
    expect(opt.statusCode).toBe(204);
    expect(opt.headers["access-control-allow-methods"]).toContain("GET");
  });

  it("caches views for 5 s per project", async () => {
    fill(ledger, { side: "buy", reason: "REB", tokens: 100, sol: 0.02, ts: clock - 1000 });
    const cached = await app.inject({ method: "GET", url: "/api/project/test" });
    expect(cached.json<{ trades: unknown[] }>().trades).toHaveLength(4);
    clock += 6000;
    const fresh = await app.inject({ method: "GET", url: "/api/project/test" });
    expect(fresh.json<{ trades: unknown[] }>().trades).toHaveLength(5);
  });

  it("unused config is not exposed", async () => {
    const body = (await app.inject({ method: "GET", url: "/api/project/test" })).body;
    expect(body).not.toContain("levels");
    expect(body).not.toContain("clip");
    expect(body).not.toContain("targetSolShare");
    expect(c.strategy.clip.minSol).toBeGreaterThan(0);
  });
});
