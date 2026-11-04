/**
 * Fastify server for web onboarding: the founder signs in with his wallet, fills the four-step form, and one
 * POST creates the execution wallet, the project file, the ledger rows and the Telegram bind code.
 *
 * This is the only process besides the engine that touches the keystore, and it only ever encrypts a fresh key;
 * nothing here can decrypt or sign. Same-origin API, no CORS on purpose.
 */
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_FEES,
  DEFAULT_RULES,
  DEFAULT_STRATEGY,
  logger,
  parseProjectConfig,
  projectsDir,
  saveProject,
  type Ledger,
  type ProjectConfig,
} from "@tenfold/core";
import { createWallet } from "@tenfold/exec";
import { ChallengeStore, PUBKEY_RE, SessionStore, bearerToken, challengeMessage, verifyWalletSignature, type Session } from "./auth.js";
import { renderOnboardPage } from "./html.js";
import { qrSvg } from "./qr.js";

export interface ServerOptions {
  ledger: Ledger;
  /** Where new execution wallets are written (encrypted). */
  keystoreDir: string;
  /** Empty = project creation is refused with a clear error. */
  keystorePassword: string;
  /** Base URL of the proof page, for the link on the confirmation screen. */
  proofBaseUrl: string;
  /** Clock, overridable for tests. */
  now?: () => number;
}

const PROJECT_ID_RE = /^[a-z0-9-]{2,40}$/;

/** What the browser posts to /api/projects. Loosely typed on purpose: parseProjectConfig is the real validator. */
export interface OnboardRequest {
  name: string;
  id: string;
  mint: string;
  decimals: number;
  mode: "paper" | "live";
  referral?: string;
  rules: {
    dailySellCapPct: number;
    defenseBudgetSol: number;
    maxDefenseSpendPerDaySol: number;
    withdrawalDelayHours: 24 | 48;
    maxSlippageBps: number;
  };
  strategy: {
    levels: { price: number; budgetSol: number }[];
    distribution: { enabled: boolean; pctOfVaultPerDay: number; mode: "strength" | "twap"; minPrice?: number; strengthBoost?: number };
    rebalance: { enabled: boolean; targetSolShare: number; band: number };
    clip: { minSol: number; maxSol: number };
  };
  teamWallets?: { wallet: string; label?: string; challenge?: string; signature?: string }[];
  marketing?: { mode: "off" | "approve" | "auto"; xHandle?: string; telegramChannelId?: string; tone?: string };
}

export interface OnboardResponse {
  id: string;
  walletPubkey: string;
  bindCode: string;
  proofUrl: string;
  nextSteps: string[];
  /** Inline SVG of the deposit address, for the confirmation screen. */
  qrSvg: string;
  declaredWallets: { wallet: string; label: string; signed: boolean }[];
}

/** 400-style error body. */
class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: string[],
  ) {
    super(message);
  }
}

// ---- small coercion helpers (the browser sends JSON; be forgiving on number strings, strict on everything else) ----

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function str(v: unknown, max = 200): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" || t.length > max ? undefined : t;
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function pick<T>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

/** Fee terms pinned at onboarding: the global defaults, plus the referrer wallet when the code is one. */
export function feeTermsForReferral(referral: string | undefined): ProjectConfig["fees"] {
  const terms: NonNullable<ProjectConfig["fees"]> = { ...DEFAULT_FEES };
  if (referral && PUBKEY_RE.test(referral)) terms.referrerWallet = referral;
  return terms;
}

/**
 * Turn the browser payload into a ProjectConfig candidate (validated by parseProjectConfig by the caller).
 * Exported for tests. Everything the form does not know about comes from the core defaults.
 */
export function buildProjectConfig(body: unknown, walletPubkey: string, bindCode: string, createdAt: number, declaredWallets: string[]): unknown {
  const b = obj(body);
  const rules = obj(b.rules);
  const strat = obj(b.strategy);
  const dist = obj(strat.distribution);
  const reb = obj(strat.rebalance);
  const clip = obj(strat.clip);
  const mk = obj(b.marketing);
  const referral = str(b.referral, 64);

  const levels = (Array.isArray(strat.levels) ? strat.levels : [])
    .map((l) => ({ price: num(obj(l).price), budgetSol: num(obj(l).budgetSol) }))
    .filter((l) => l.price !== undefined || l.budgetSol !== undefined);

  const distribution: Record<string, unknown> = {
    enabled: dist.enabled === true,
    pctOfVaultPerDay: num(dist.pctOfVaultPerDay) ?? DEFAULT_STRATEGY.distribution.pctOfVaultPerDay,
    mode: pick(dist.mode, ["strength", "twap"] as const, DEFAULT_STRATEGY.distribution.mode),
  };
  const minPrice = num(dist.minPrice);
  if (minPrice !== undefined && minPrice > 0) distribution.minPrice = minPrice;
  const boost = num(dist.strengthBoost);
  if (boost !== undefined && boost > 1) distribution.strengthBoost = boost;

  const marketingMode = pick(mk.mode, ["off", "approve", "auto"] as const, "off");
  const marketing: Record<string, unknown> = { mode: marketingMode };
  const xHandle = str(mk.xHandle, 32);
  if (xHandle) marketing.xHandle = xHandle.replace(/^@/, "");
  const tg = str(mk.telegramChannelId, 64);
  if (tg) marketing.telegramChannelId = tg;
  const tone = str(mk.tone, 200);
  if (tone) marketing.tone = tone;

  const cfg: Record<string, unknown> = {
    id: str(b.id, 40),
    name: str(b.name, 80) ?? str(b.id, 40),
    mint: str(b.mint, 44),
    decimals: num(b.decimals) ?? 6,
    walletPubkey,
    mode: pick(b.mode, ["paper", "live"] as const, "paper"),
    rules: {
      ...DEFAULT_RULES,
      dailySellCapPct: num(rules.dailySellCapPct) ?? DEFAULT_RULES.dailySellCapPct,
      defenseBudgetSol: num(rules.defenseBudgetSol) ?? DEFAULT_RULES.defenseBudgetSol,
      maxDefenseSpendPerDaySol: num(rules.maxDefenseSpendPerDaySol) ?? num(rules.defenseBudgetSol) ?? DEFAULT_RULES.maxDefenseSpendPerDaySol,
      withdrawalDelayHours: num(rules.withdrawalDelayHours) === 48 ? 48 : 24,
      maxSlippageBps: num(rules.maxSlippageBps) ?? DEFAULT_RULES.maxSlippageBps,
    },
    strategy: {
      defense: { enabled: levels.length > 0, levels },
      distribution,
      rebalance: {
        enabled: reb.enabled === true,
        targetSolShare: num(reb.targetSolShare) ?? DEFAULT_STRATEGY.rebalance.targetSolShare,
        band: num(reb.band) ?? DEFAULT_STRATEGY.rebalance.band,
      },
      clip: {
        minSol: num(clip.minSol) ?? DEFAULT_STRATEGY.clip.minSol,
        maxSol: num(clip.maxSol) ?? DEFAULT_STRATEGY.clip.maxSol,
        jitterPct: DEFAULT_STRATEGY.clip.jitterPct,
      },
    },
    bindCode,
    fees: feeTermsForReferral(referral),
    marketing,
    declaredWallets,
    createdAt,
    paused: false,
  };
  if (referral) cfg.referral = referral;
  return cfg;
}

/** Zod's error shape, without importing zod here. */
function zodIssues(e: unknown): string[] | undefined {
  if (!(e instanceof Error) || e.name !== "ZodError") return undefined;
  const issues = (e as unknown as { issues?: { path: (string | number)[]; message: string }[] }).issues;
  if (!Array.isArray(issues)) return undefined;
  return issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`);
}

function sendError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof RequestError) return reply.code(e.status).send({ error: e.message, ...(e.details ? { details: e.details } : {}) });
  const issues = zodIssues(e);
  if (issues) return reply.code(400).send({ error: "invalid project configuration", details: issues });
  logger.error("onboard: request failed", { err: e instanceof Error ? e.message : String(e) });
  return reply.code(500).send({ error: "internal error" });
}

/** Build the Fastify app (not listening) so tests can use `inject`. */
export function buildServer(opts: ServerOptions): FastifyInstance {
  const { ledger } = opts;
  const now = opts.now ?? (() => Date.now());
  const challenges = new ChallengeStore(now);
  const sessions = new SessionStore(now);
  const page = renderOnboardPage({
    fees: DEFAULT_FEES,
    rules: DEFAULT_RULES,
    strategy: DEFAULT_STRATEGY,
    proofBaseUrl: opts.proofBaseUrl,
    walletsEnabled: Boolean(opts.keystorePassword),
  });

  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

  app.addHook("onRequest", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
  });

  app.addHook("onResponse", async (req, reply) => {
    logger.debug("onboard request", { method: req.method, url: req.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) });
  });

  function requireSession(req: { headers: { authorization?: string } }): Session {
    const s = sessions.get(bearerToken(req.headers.authorization));
    if (!s) throw new RequestError(401, "sign in with your wallet first (session missing or expired)");
    return s;
  }

  /** parseProjectConfig throws zod errors and plain Errors (cross-field checks); both are the caller's fault. */
  function validate(raw: unknown): ProjectConfig {
    try {
      return parseProjectConfig(raw);
    } catch (e) {
      if (zodIssues(e)) throw e;
      throw new RequestError(400, e instanceof Error ? e.message : "invalid project configuration");
    }
  }

  function projectExists(id: string): boolean {
    return existsSync(join(projectsDir(), `${id}.json`)) || ledger.getProject(id) !== undefined;
  }

  app.get("/healthz", async () => ({ ok: true, ts: now(), walletsEnabled: Boolean(opts.keystorePassword) }));

  app.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(page));

  /** A fresh challenge. The wallet signs challengeMessage(challenge) as UTF-8 text. */
  app.get("/api/challenge", async () => challenges.issue());

  /** Exchange a signed challenge for a session token. */
  app.post<{ Body: { wallet?: unknown; challenge?: unknown; signature?: unknown } }>("/api/session", async (req, reply) => {
    try {
      const b = obj(req.body);
      const wallet = str(b.wallet, 44);
      const signature = str(b.signature, 96);
      if (!wallet || !PUBKEY_RE.test(wallet)) throw new RequestError(400, "wallet must be a base58 public key");
      if (!signature) throw new RequestError(400, "signature (base58) is required");
      if (!challenges.consume(b.challenge)) throw new RequestError(400, "unknown or expired challenge; request a new one");
      if (!verifyWalletSignature(wallet, challengeMessage(b.challenge as string), signature)) {
        throw new RequestError(401, "signature does not match the wallet");
      }
      const s = sessions.create(wallet, b.challenge as string, signature);
      return reply.send({ token: s.token, wallet: s.wallet, expiresAt: s.expiresAt });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  /** Who am I: lets the page restore a session after a reload. */
  app.get("/api/session", async (req, reply) => {
    try {
      const { wallet } = requireSession(req);
      return reply.send({ wallet });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  /** Live id check while typing. Public: ids are public on the proof page anyway. */
  app.get<{ Params: { id: string } }>("/api/projects/:id/available", async (req, reply) => {
    const id = req.params.id;
    if (!PROJECT_ID_RE.test(id)) return reply.send({ available: false, reason: "2 to 40 lowercase letters, digits or dashes" });
    return reply.send({ available: !projectExists(id) });
  });

  app.post<{ Body: unknown }>("/api/projects", async (req, reply) => {
    try {
      const session = requireSession(req);
      const founder = session.wallet;
      if (!opts.keystorePassword) {
        throw new RequestError(503, "TENFOLD_KEYSTORE_PASSWORD is not set on the onboarding server, so no execution wallet can be created. Set it and restart.");
      }
      const b = obj(req.body);
      const id = str(b.id, 40);
      if (!id || !PROJECT_ID_RE.test(id)) throw new RequestError(400, "id must be 2 to 40 lowercase letters, digits or dashes");
      if (projectExists(id)) throw new RequestError(409, `a project with id "${id}" already exists`);

      // Team wallets: the founder is declared from his session; others are declared signed (verified here) or unsigned.
      const declared = new Map<string, { label: string; signature?: string; challenge?: string }>();
      declared.set(founder, { label: "founder", signature: session.signature, challenge: session.challenge });
      const team = Array.isArray(b.teamWallets) ? b.teamWallets : [];
      if (team.length > 49) throw new RequestError(400, "at most 49 team wallets");
      for (const raw of team) {
        const t = obj(raw);
        const wallet = str(t.wallet, 44);
        if (!wallet || !PUBKEY_RE.test(wallet)) throw new RequestError(400, `team wallet "${String(t.wallet ?? "")}" is not a base58 public key`);
        if (wallet === founder || declared.has(wallet)) continue;
        const label = str(t.label, 40) ?? "team";
        const signature = str(t.signature, 96);
        if (signature) {
          if (!challenges.consume(t.challenge)) {
            throw new RequestError(400, `the signature for ${wallet} uses an unknown or expired challenge; sign it again or add it unsigned`);
          }
          if (!verifyWalletSignature(wallet, challengeMessage(t.challenge as string), signature)) {
            throw new RequestError(400, `the signature for ${wallet} does not verify; sign it again or add it unsigned`);
          }
          declared.set(wallet, { label, signature, challenge: t.challenge as string });
        } else {
          declared.set(wallet, { label });
        }
      }

      // Validate the whole configuration before creating anything on disk (the founder wallet stands in for the
      // execution wallet so the schema can run).
      const bindCode = randomBytes(5).toString("base64url");
      const createdAt = now();
      const wallets = [...declared.keys()];
      validate(buildProjectConfig(b, founder, bindCode, createdAt, wallets));

      const walletPubkey = createWallet(opts.keystoreDir, opts.keystorePassword, id);
      const cfg = validate(buildProjectConfig(b, walletPubkey, bindCode, createdAt, wallets));
      saveProject(cfg);
      ledger.upsertProject(cfg);
      for (const [w, d] of declared) ledger.declareWallet(id, w, d.label, d.signature);
      // Challenges are kept next to the signatures so every declaration stays verifiable from the ledger alone.
      ledger.insertEvent({
        type: "config_changed",
        projectId: id,
        ts: createdAt,
        data: {
          source: "onboard",
          founder,
          declaredWallets: [...declared].map(([w, d]) => ({ wallet: w, label: d.label, signed: Boolean(d.signature), challenge: d.challenge, signature: d.signature })),
        },
      });
      logger.info("onboard: project created", { project: id, mode: cfg.mode, mint: cfg.mint, wallet: walletPubkey, founder, declared: wallets.length });

      const proofUrl = `${opts.proofBaseUrl.replace(/\/+$/, "")}/p/${id}`;
      const res: OnboardResponse = {
        id,
        walletPubkey,
        bindCode,
        proofUrl,
        nextSteps: nextSteps(cfg, walletPubkey, bindCode, proofUrl),
        qrSvg: qrSvg(walletPubkey, { title: `Deposit address ${walletPubkey}` }),
        declaredWallets: [...declared].map(([w, d]) => ({ wallet: w, label: d.label, signed: Boolean(d.signature) })),
      };
      return reply.code(201).send(res);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.setNotFoundHandler(async (req, reply) => {
    if (req.headers.accept?.includes("text/html")) return reply.redirect("/");
    return reply.code(404).send({ error: "not found" });
  });

  return app;
}

function nextSteps(cfg: ProjectConfig, wallet: string, bindCode: string, proofUrl: string): string[] {
  const steps = [
    `Send the ${cfg.name} tokens and the SOL Tenfold should manage to the deposit address ${wallet}. Start small; you can top up any time.`,
    `Open a private Telegram chat with the Tenfold bot and send: /start ${cfg.id} ${bindCode}. The bind code is shown once; whoever has it controls the project.`,
    cfg.mode === "paper"
      ? "The engine picks the project up within a minute. Paper mode: real prices, simulated fills, nothing leaves the wallet until you switch to live."
      : "The engine picks the project up within a minute and trades for real. Keep the beta vault small (under 100 SOL and 5% of supply) and watch the first hour.",
    `Your proof page is ${proofUrl}. It shows every order, fill and rule publicly; share it with your holders.`,
  ];
  if (cfg.strategy.defense.levels.length === 0 && !cfg.strategy.distribution.enabled && !cfg.strategy.rebalance.enabled) {
    steps.push("No strategy is enabled yet: ask the bot on Telegram, for example \"defend 0.0002 with 10 SOL\" or \"distribute 0.3% a day into strength\".");
  }
  return steps;
}
