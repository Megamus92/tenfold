import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_FEES, DEFAULT_RULES, DEFAULT_STRATEGY, Ledger, parseProjectConfig } from "@tenfold/core";
import type { FastifyInstance } from "fastify";
import { base58Decode, base58Encode, challengeMessage, verifyWalletSignature, ChallengeStore, SessionStore } from "./auth.js";
import { encodeQr, qrSvg } from "./qr.js";
import { buildProjectConfig, buildServer, feeTermsForReferral, type OnboardResponse } from "./server.js";

const MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const KNOWN_WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const MIN = 60_000;

/** An ed25519 wallet made with node:crypto only: base58 address plus a signer for the login message. */
interface TestWallet {
  address: string;
  sign: (message: string) => string;
}

function makeWallet(): TestWallet {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = (publicKey as KeyObject).export({ type: "spki", format: "der" }) as Buffer;
  const raw = spki.subarray(spki.length - 32);
  return {
    address: base58Encode(new Uint8Array(raw)),
    sign: (message: string) => base58Encode(new Uint8Array(cryptoSign(null, Buffer.from(message, "utf8"), privateKey))),
  };
}

describe("base58", () => {
  it("round-trips a Solana address", () => {
    const bytes = base58Decode(KNOWN_WALLET);
    expect(bytes.length).toBe(32);
    expect(base58Encode(bytes)).toBe(KNOWN_WALLET);
  });
  it("keeps leading zero bytes", () => {
    const bytes = new Uint8Array([0, 0, 1, 2, 3]);
    const s = base58Encode(bytes);
    expect(s.startsWith("11")).toBe(true);
    expect([...base58Decode(s)]).toEqual([...bytes]);
  });
  it("rejects invalid characters", () => {
    expect(() => base58Decode("0OIl")).toThrow();
  });
});

describe("wallet signatures", () => {
  it("verifies a signature by the right wallet and nothing else", () => {
    const w = makeWallet();
    const other = makeWallet();
    const msg = challengeMessage("ab".repeat(32));
    const sig = w.sign(msg);
    expect(verifyWalletSignature(w.address, msg, sig)).toBe(true);
    expect(verifyWalletSignature(other.address, msg, sig)).toBe(false);
    expect(verifyWalletSignature(w.address, msg + "x", sig)).toBe(false);
    expect(verifyWalletSignature(w.address, msg, sig.slice(0, -1) + (sig.endsWith("1") ? "2" : "1"))).toBe(false);
    expect(verifyWalletSignature(w.address, msg, "not base58 0OIl")).toBe(false);
    expect(verifyWalletSignature("short", msg, sig)).toBe(false);
  });

  it("challenges are single use and expire", () => {
    let t = 1_000_000;
    const store = new ChallengeStore(() => t);
    const c = store.issue();
    expect(c.message).toBe(`Tenfold onboarding ${c.challenge}`);
    expect(store.consume(c.challenge)).toBe(true);
    expect(store.consume(c.challenge)).toBe(false);
    const c2 = store.issue();
    t += 11 * MIN;
    expect(store.consume(c2.challenge)).toBe(false);
    expect(store.consume("zz")).toBe(false);
    expect(store.consume(undefined)).toBe(false);
  });

  it("sessions expire after an hour", () => {
    let t = 1_000_000;
    const store = new SessionStore(() => t);
    const s = store.create(KNOWN_WALLET, "c".repeat(64), "sig");
    expect(store.get(s.token)?.wallet).toBe(KNOWN_WALLET);
    expect(store.get(s.token)?.signature).toBe("sig");
    t += 61 * MIN;
    expect(store.get(s.token)).toBeUndefined();
    expect(store.get("nope")).toBeUndefined();
  });
});

describe("qr", () => {
  it("matches the reference symbol for HELLO WORLD at 1-M", () => {
    // Module matrix produced by the python `qrcode` library for version 1, level M, mask 0.
    const expected = [
      "111111100010101111111",
      "100000101110001000001",
      "101110100010101011101",
      "101110100010101011101",
      "101110101011101011101",
      "100000100111001000001",
      "111111101010101111111",
      "000000000000000000000",
      "101010100100100010010",
      "011110001001000010001",
      "000111111101001011000",
      "111101011001110101110",
      "010011110101001110101",
      "000000001010001000101",
      "111111100000100101100",
      "100000100110001101000",
      "101110101100101111111",
      "101110100011010100010",
      "101110101111011101001",
      "100000100001110001011",
      "111111101101011100001",
    ];
    const qr = encodeQr("HELLO WORLD", "M");
    expect(qr.version).toBe(1);
    expect(qr.mask).toBe(0);
    expect(qr.modules.map((r) => r.map((m) => (m ? "1" : "0")).join(""))).toEqual(expected);
  });

  it("fits a 44-character address in version 4 (byte mode) and draws the finder patterns", () => {
    const qr = encodeQr(KNOWN_WALLET);
    expect(qr.version).toBe(4);
    expect(qr.size).toBe(33);
    const finder = ["1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111"];
    const block = (x0: number, y0: number): string[] =>
      finder.map((_, dy) => qr.modules[y0 + dy].slice(x0, x0 + 7).map((m) => (m ? "1" : "0")).join(""));
    expect(block(0, 0)).toEqual(finder);
    expect(block(qr.size - 7, 0)).toEqual(finder);
    expect(block(0, qr.size - 7)).toEqual(finder);
    // Timing patterns alternate along row and column 6.
    for (let i = 8; i < qr.size - 8; i++) {
      expect(qr.modules[6][i]).toBe(i % 2 === 0);
      expect(qr.modules[i][6]).toBe(i % 2 === 0);
    }
  });

  it("renders an inline svg with a quiet zone", () => {
    const svg = qrSvg(KNOWN_WALLET, { pixels: 200 });
    expect(svg.startsWith("<svg xmlns=")).toBe(true);
    expect(svg).toContain('viewBox="0 0 41 41"');
    expect(svg).toContain(`aria-label="${KNOWN_WALLET}"`);
    expect(svg).toContain("<path d=\"M4 4h1v1h-1z");
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  it("refuses text that does not fit in version 40", () => {
    expect(() => encodeQr("x".repeat(3000), "L")).toThrow(/too long/);
  });
});

describe("buildProjectConfig", () => {
  const WALLET = KNOWN_WALLET;

  it("fills every default and validates", () => {
    const raw = buildProjectConfig({ id: "my-token", name: "My Token", mint: MINT }, WALLET, "abcdefgh", 1_700_000_000_000, [WALLET]);
    const cfg = parseProjectConfig(raw);
    expect(cfg.id).toBe("my-token");
    expect(cfg.decimals).toBe(6);
    expect(cfg.mode).toBe("paper");
    expect(cfg.rules).toEqual(DEFAULT_RULES);
    expect(cfg.strategy.defense).toEqual({ enabled: false, levels: [] });
    expect(cfg.strategy.distribution).toEqual({ enabled: false, pctOfVaultPerDay: 0.5, mode: "strength" });
    expect(cfg.strategy.clip.jitterPct).toBe(DEFAULT_STRATEGY.clip.jitterPct);
    expect(cfg.bindCode).toBe("abcdefgh");
    expect(cfg.fees).toEqual(DEFAULT_FEES);
    expect(cfg.marketing).toEqual({ mode: "off" });
    expect(cfg.declaredWallets).toEqual([WALLET]);
    expect(cfg.referral).toBeUndefined();
  });

  it("maps the form fields, enables defense when levels exist and clamps distribution to the cap", () => {
    const body = {
      id: "tok",
      name: "Tok",
      mint: MINT,
      decimals: "9",
      mode: "live",
      referral: KNOWN_WALLET,
      rules: { dailySellCapPct: 0.3, defenseBudgetSol: 20, maxDefenseSpendPerDaySol: 5, withdrawalDelayHours: 48, maxSlippageBps: 200 },
      strategy: {
        levels: [{ price: 0.0002, budgetSol: 10 }, { price: "0.00015", budgetSol: "10" }],
        distribution: { enabled: true, pctOfVaultPerDay: 0.9, mode: "twap", minPrice: 0.0001, strengthBoost: 3 },
        rebalance: { enabled: true, targetSolShare: 0.4, band: 0.2 },
        clip: { minSol: 0.1, maxSol: 1 },
      },
      marketing: { mode: "approve", xHandle: "@tok", telegramChannelId: "@tokchan", tone: "dry" },
    };
    const cfg = parseProjectConfig(buildProjectConfig(body, WALLET, "code1234", 1, [WALLET]));
    expect(cfg.decimals).toBe(9);
    expect(cfg.mode).toBe("live");
    expect(cfg.rules.withdrawalDelayHours).toBe(48);
    expect(cfg.rules.maxSlippageBps).toBe(200);
    expect(cfg.rules.maxOrdersPerHour).toBe(DEFAULT_RULES.maxOrdersPerHour);
    expect(cfg.strategy.defense.enabled).toBe(true);
    expect(cfg.strategy.defense.levels).toEqual([{ price: 0.0002, budgetSol: 10 }, { price: 0.00015, budgetSol: 10 }]);
    expect(cfg.strategy.distribution.pctOfVaultPerDay).toBe(0.3); // clamped to the cap by parseProjectConfig
    expect(cfg.strategy.distribution.mode).toBe("twap");
    expect(cfg.strategy.distribution.minPrice).toBe(0.0001);
    expect(cfg.strategy.distribution.strengthBoost).toBe(3);
    expect(cfg.strategy.rebalance).toEqual({ enabled: true, targetSolShare: 0.4, band: 0.2 });
    expect(cfg.strategy.clip).toEqual({ minSol: 0.1, maxSol: 1, jitterPct: DEFAULT_STRATEGY.clip.jitterPct });
    expect(cfg.marketing).toEqual({ mode: "approve", xHandle: "tok", telegramChannelId: "@tokchan", tone: "dry" });
    expect(cfg.referral).toBe(KNOWN_WALLET);
    expect(cfg.fees?.referrerWallet).toBe(KNOWN_WALLET);
  });

  it("keeps a non-wallet referral code without a referrer wallet", () => {
    expect(feeTermsForReferral("FRIEND-10")).toEqual(DEFAULT_FEES);
    expect(feeTermsForReferral(undefined)).toEqual(DEFAULT_FEES);
  });

  it("surfaces schema errors through parseProjectConfig", () => {
    expect(() => parseProjectConfig(buildProjectConfig({ id: "ok", name: "x", mint: "nope" }, WALLET, "code1234", 1, []))).toThrow();
    expect(() =>
      parseProjectConfig(buildProjectConfig({ id: "ok", name: "x", mint: MINT, strategy: { clip: { minSol: 2, maxSol: 1 } } }, WALLET, "code1234", 1, [])),
    ).toThrow(/clip/);
  });
});

describe("server", () => {
  let dir: string;
  let keystoreDir: string;
  let ledger: Ledger;
  let app: FastifyInstance;
  let noKeyApp: FastifyInstance;
  let t = 1_700_000_000_000;
  const now = (): number => t;
  const founder = makeWallet();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "tenfold-onboard-"));
    keystoreDir = join(dir, "keys");
    process.env.TENFOLD_PROJECTS_DIR = join(dir, "projects");
    ledger = new Ledger(":memory:");
    app = buildServer({ ledger, keystoreDir, keystorePassword: "test-password", proofBaseUrl: "https://proof.test/", now });
    noKeyApp = buildServer({ ledger, keystoreDir, keystorePassword: "", proofBaseUrl: "https://proof.test", now });
    await app.ready();
    await noKeyApp.ready();
  });

  afterAll(async () => {
    await app.close();
    await noKeyApp.close();
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TENFOLD_PROJECTS_DIR;
  });

  async function login(server: FastifyInstance, w: TestWallet): Promise<string> {
    const c = (await server.inject({ method: "GET", url: "/api/challenge" })).json<{ challenge: string; message: string }>();
    const res = await server.inject({
      method: "POST",
      url: "/api/session",
      payload: { wallet: w.address, challenge: c.challenge, signature: w.sign(c.message) },
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ token: string }>().token;
  }

  async function signedTeamWallet(server: FastifyInstance, w: TestWallet, label = "dev"): Promise<{ wallet: string; label: string; challenge: string; signature: string }> {
    const c = (await server.inject({ method: "GET", url: "/api/challenge" })).json<{ challenge: string; message: string }>();
    return { wallet: w.address, label, challenge: c.challenge, signature: w.sign(c.message) };
  }

  function body(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id,
      name: "Test Token",
      mint: MINT,
      decimals: 6,
      mode: "paper",
      rules: { dailySellCapPct: 0.5, defenseBudgetSol: 10, maxDefenseSpendPerDaySol: 4, withdrawalDelayHours: 24, maxSlippageBps: 150 },
      strategy: {
        levels: [{ price: 0.0002, budgetSol: 5 }],
        distribution: { enabled: true, pctOfVaultPerDay: 0.3, mode: "strength", strengthBoost: 2 },
        rebalance: { enabled: false, targetSolShare: 0.3, band: 0.1 },
        clip: { minSol: 0.05, maxSol: 0.5 },
      },
      ...extra,
    };
  }

  it("serves the self-contained page", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const html = res.body;
    expect(html).toContain("<title>Tenfold onboarding</title>");
    expect(html).toContain('id="connect"');
    expect(html).toContain('id="qr"');
    expect(html).toContain("window.solana");
    expect(html).toContain(`"volumeBps":${DEFAULT_FEES.volumeBps}`);
    expect(html).toContain('"proofBaseUrl":"https://proof.test"');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).not.toContain("</script>\n<script>${");
  });

  it("issues challenges and exchanges a valid signature for a session", async () => {
    const c = (await app.inject({ method: "GET", url: "/api/challenge" })).json<{ challenge: string; message: string; expiresAt: number }>();
    expect(c.challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(c.message).toBe(`Tenfold onboarding ${c.challenge}`);
    expect(c.expiresAt).toBe(t + 10 * MIN);

    const good = await app.inject({ method: "POST", url: "/api/session", payload: { wallet: founder.address, challenge: c.challenge, signature: founder.sign(c.message) } });
    expect(good.statusCode).toBe(200);
    const s = good.json<{ token: string; wallet: string; expiresAt: number }>();
    expect(s.wallet).toBe(founder.address);
    expect(s.expiresAt).toBe(t + 60 * MIN);

    const me = await app.inject({ method: "GET", url: "/api/session", headers: { authorization: `Bearer ${s.token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ wallet: founder.address });

    // Replay of a consumed challenge is refused.
    const replay = await app.inject({ method: "POST", url: "/api/session", payload: { wallet: founder.address, challenge: c.challenge, signature: founder.sign(c.message) } });
    expect(replay.statusCode).toBe(400);
  });

  it("refuses a signature from another wallet, a tampered message and an expired challenge", async () => {
    const other = makeWallet();
    const c1 = (await app.inject({ method: "GET", url: "/api/challenge" })).json<{ challenge: string; message: string }>();
    const wrongSigner = await app.inject({ method: "POST", url: "/api/session", payload: { wallet: founder.address, challenge: c1.challenge, signature: other.sign(c1.message) } });
    expect(wrongSigner.statusCode).toBe(401);

    const c2 = (await app.inject({ method: "GET", url: "/api/challenge" })).json<{ challenge: string; message: string }>();
    const tampered = await app.inject({ method: "POST", url: "/api/session", payload: { wallet: founder.address, challenge: c2.challenge, signature: founder.sign("Tenfold onboarding " + "0".repeat(64)) } });
    expect(tampered.statusCode).toBe(401);

    const c3 = (await app.inject({ method: "GET", url: "/api/challenge" })).json<{ challenge: string; message: string }>();
    t += 11 * MIN;
    const expired = await app.inject({ method: "POST", url: "/api/session", payload: { wallet: founder.address, challenge: c3.challenge, signature: founder.sign(c3.message) } });
    expect(expired.statusCode).toBe(400);
    expect(expired.json<{ error: string }>().error).toMatch(/expired/);

    const malformed = await app.inject({ method: "POST", url: "/api/session", payload: { wallet: "nope", challenge: "x", signature: "y" } });
    expect(malformed.statusCode).toBe(400);
  });

  it("requires a session to create a project", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects", payload: body("nosession") });
    expect(res.statusCode).toBe(401);
    const bad = await app.inject({ method: "POST", url: "/api/projects", payload: body("nosession"), headers: { authorization: "Bearer nottherighttoken1234" } });
    expect(bad.statusCode).toBe(401);
  });

  it("refuses to create a project when the keystore password is missing", async () => {
    const token = await login(noKeyApp, founder);
    const res = await noKeyApp.inject({ method: "POST", url: "/api/projects", payload: body("nokey"), headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: string }>().error).toContain("TENFOLD_KEYSTORE_PASSWORD");
    expect(existsSync(join(process.env.TENFOLD_PROJECTS_DIR as string, "nokey.json"))).toBe(false);
    const health = await noKeyApp.inject({ method: "GET", url: "/healthz" });
    expect(health.json()).toMatchObject({ ok: true, walletsEnabled: false });
  });

  it("creates the wallet, the project file, the ledger rows and the declared wallets", async () => {
    const token = await login(app, founder);
    const dev = makeWallet();
    const signedDev = await signedTeamWallet(app, dev, "dev");
    const unsigned = makeWallet();
    const payload = body("test-token", {
      referral: KNOWN_WALLET,
      teamWallets: [signedDev, { wallet: unsigned.address, label: "treasury" }, { wallet: founder.address }],
      marketing: { mode: "approve", xHandle: "@testtoken", tone: "calm" },
    });
    const res = await app.inject({ method: "POST", url: "/api/projects", payload, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(201);
    const r = res.json<OnboardResponse>();
    expect(r.id).toBe("test-token");
    expect(r.walletPubkey).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(r.walletPubkey).not.toBe(founder.address);
    expect(r.bindCode).toMatch(/^[A-Za-z0-9_-]{7}$/);
    expect(r.proofUrl).toBe("https://proof.test/p/test-token");
    expect(r.nextSteps.length).toBeGreaterThanOrEqual(4);
    expect(r.nextSteps.join("\n")).toContain(`/start test-token ${r.bindCode}`);
    expect(r.nextSteps.join("\n")).toContain(r.walletPubkey);
    expect(r.qrSvg).toContain("<svg");
    expect(r.qrSvg).toContain(r.walletPubkey);
    expect(r.declaredWallets).toEqual([
      { wallet: founder.address, label: "founder", signed: true },
      { wallet: dev.address, label: "dev", signed: true },
      { wallet: unsigned.address, label: "treasury", signed: false },
    ]);

    // Keystore: one encrypted file named after the pubkey, labelled with the project id, no plaintext key.
    const keyFile = join(keystoreDir, `${r.walletPubkey}.json`);
    expect(existsSync(keyFile)).toBe(true);
    const ks = JSON.parse(readFileSync(keyFile, "utf8")) as { pubkey: string; label: string; cipher: string };
    expect(ks.pubkey).toBe(r.walletPubkey);
    expect(ks.label).toBe("test-token");
    expect(ks.cipher).toBe("aes-256-gcm");

    // Project file on disk, as the engine and the agent read it.
    const file = join(process.env.TENFOLD_PROJECTS_DIR as string, "test-token.json");
    expect(existsSync(file)).toBe(true);
    const cfg = parseProjectConfig(JSON.parse(readFileSync(file, "utf8")));
    expect(cfg.walletPubkey).toBe(r.walletPubkey);
    expect(cfg.bindCode).toBe(r.bindCode);
    expect(cfg.mode).toBe("paper");
    expect(cfg.referral).toBe(KNOWN_WALLET);
    expect(cfg.fees).toEqual({ ...DEFAULT_FEES, referrerWallet: KNOWN_WALLET });
    expect(cfg.marketing).toEqual({ mode: "approve", xHandle: "testtoken", tone: "calm" });
    expect(cfg.strategy.defense).toEqual({ enabled: true, levels: [{ price: 0.0002, budgetSol: 5 }] });
    expect(cfg.strategy.distribution.strengthBoost).toBe(2);
    expect(cfg.declaredWallets).toEqual([founder.address, dev.address, unsigned.address]);
    expect(cfg.createdAt).toBe(t);
    expect(cfg.telegram).toBeUndefined();

    // Ledger: project row and declared wallets with their signatures.
    expect(ledger.getProject("test-token")?.walletPubkey).toBe(r.walletPubkey);
    // Rows share one declared_at millisecond, so compare as a set.
    const declared = ledger.listDeclaredWallets("test-token");
    const byWallet = (a: { wallet: string }, b: { wallet: string }): number => a.wallet.localeCompare(b.wallet);
    expect(declared.map((d) => ({ wallet: d.wallet, label: d.label, signed: Boolean(d.signature) })).sort(byWallet)).toEqual(
      [
        { wallet: founder.address, label: "founder", signed: true },
        { wallet: dev.address, label: "dev", signed: true },
        { wallet: unsigned.address, label: "treasury", signed: false },
      ].sort(byWallet),
    );
    const devRow = declared.find((d) => d.wallet === dev.address);
    expect(devRow?.signature).toBe(signedDev.signature);
    // The event keeps challenge + signature, so each signed declaration can be re-verified from the ledger alone.
    const ev = ledger.listEvents("test-token", { types: ["config_changed"] });
    expect(ev.length).toBe(1);
    expect(ev[0].data).toMatchObject({ source: "onboard", founder: founder.address });
    const recorded = (ev[0].data as { declaredWallets: { wallet: string; signed: boolean; challenge?: string; signature?: string }[] }).declaredWallets;
    for (const d of recorded.filter((x) => x.signed)) {
      expect(verifyWalletSignature(d.wallet, challengeMessage(d.challenge as string), d.signature as string)).toBe(true);
    }
    expect(recorded.filter((x) => x.signed).map((x) => x.wallet)).toEqual([founder.address, dev.address]);

    // The team wallet's challenge was consumed: reusing the same signed declaration is refused.
    const again = await app.inject({ method: "POST", url: "/api/projects", payload: body("test-token-2", { teamWallets: [signedDev] }), headers: { authorization: `Bearer ${token}` } });
    expect(again.statusCode).toBe(400);
    expect(again.json<{ error: string }>().error).toMatch(/challenge/);
    expect(existsSync(join(process.env.TENFOLD_PROJECTS_DIR as string, "test-token-2.json"))).toBe(false);
  });

  it("refuses a duplicate id and a bad team signature, and writes nothing on validation errors", async () => {
    const token = await login(app, founder);
    const before = readdirSync(keystoreDir).length;

    const dup = await app.inject({ method: "POST", url: "/api/projects", payload: body("test-token"), headers: { authorization: `Bearer ${token}` } });
    expect(dup.statusCode).toBe(409);

    const avail = await app.inject({ method: "GET", url: "/api/projects/test-token/available" });
    expect(avail.json()).toEqual({ available: false });
    const free = await app.inject({ method: "GET", url: "/api/projects/fresh-id/available" });
    expect(free.json()).toEqual({ available: true });
    const badId = await app.inject({ method: "GET", url: "/api/projects/Bad_ID/available" });
    expect(badId.json<{ available: boolean }>().available).toBe(false);

    const forged = await signedTeamWallet(app, makeWallet());
    forged.wallet = makeWallet().address; // signature by another key
    const bad = await app.inject({ method: "POST", url: "/api/projects", payload: body("forged", { teamWallets: [forged] }), headers: { authorization: `Bearer ${token}` } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: string }>().error).toMatch(/does not verify/);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: body("invalid", { strategy: { levels: [], distribution: { enabled: false }, rebalance: { enabled: false }, clip: { minSol: 2, maxSol: 1 } } }),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: string }>().error).toMatch(/clip/);

    const badMint = await app.inject({ method: "POST", url: "/api/projects", payload: body("badmint", { mint: "xyz" }), headers: { authorization: `Bearer ${token}` } });
    expect(badMint.statusCode).toBe(400);
    expect(badMint.json<{ details: string[] }>().details.join(" ")).toMatch(/mint/);

    const badIdPost = await app.inject({ method: "POST", url: "/api/projects", payload: body("Bad Id"), headers: { authorization: `Bearer ${token}` } });
    expect(badIdPost.statusCode).toBe(400);

    expect(readdirSync(keystoreDir).length).toBe(before);
    expect(readdirSync(process.env.TENFOLD_PROJECTS_DIR as string)).toEqual(["test-token.json"]);
    expect(ledger.getProject("forged")).toBeUndefined();
  });

  it("logs the founder out after an hour", async () => {
    const token = await login(app, founder);
    t += 61 * MIN;
    const res = await app.inject({ method: "POST", url: "/api/projects", payload: body("late"), headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });
});
