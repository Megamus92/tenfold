import { z } from "zod";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { FeeTerms, ProjectConfig } from "./types.js";

const pubkey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a base58 public key");

export const VaultRulesSchema = z.object({
  dailySellCapPct: z.number().min(0).max(100),
  defenseBudgetSol: z.number().min(0),
  maxDefenseSpendPerDaySol: z.number().min(0),
  withdrawalDelayHours: z.union([z.literal(24), z.literal(48)]),
  maxSlippageBps: z.number().int().min(1).max(5000),
  maxOrdersPerHour: z.number().int().min(1).max(600),
  circuitBreakerMovePct: z.number().min(1).max(100),
});

export const StrategyConfigSchema = z.object({
  defense: z.object({
    enabled: z.boolean(),
    levels: z.array(z.object({ price: z.number().positive(), budgetSol: z.number().min(0), pinned: z.boolean().optional(), placedAt: z.number().optional(), rank: z.number().int().min(0).optional() })),
    maxDistanceBelowPct: z.number().min(1).max(90).optional(),
  }),
  distribution: z.object({
    enabled: z.boolean(),
    pctOfVaultPerDay: z.number().min(0).max(100),
    mode: z.enum(["strength", "twap"]),
    minPrice: z.number().positive().optional(),
    strengthBoost: z.number().min(1).max(10).optional(),
  }),
  rebalance: z.object({
    enabled: z.boolean(),
    targetSolShare: z.number().min(0).max(1),
    band: z.number().min(0).max(0.5),
  }),
  clip: z.object({
    minSol: z.number().positive(),
    maxSol: z.number().positive(),
    jitterPct: z.number().min(0).max(1),
  }),
});

export const MandateSchema = z.object({
  profile: z.enum(["protect", "balanced", "distribute"]),
  autonomy: z.enum(["auto", "ask"]).default("auto"),
  horizonDays: z.number().min(1).max(365).optional(),
  distributePct: z.number().min(0).max(100).optional(),
  alertFloor: z.number().positive().optional(),
  startedAt: z.number(),
  startTokens: z.string().regex(/^\d+$/).optional(),
  acceptedSlowPace: z.boolean().optional(),
});

export const ProjectConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(1).max(80),
  mint: pubkey,
  decimals: z.number().int().min(0).max(12),
  walletPubkey: pubkey,
  mode: z.enum(["paper", "live"]),
  rules: VaultRulesSchema,
  strategy: StrategyConfigSchema,
  telegram: z.object({ chatId: z.string(), allowedUserIds: z.array(z.string()).optional() }).optional(),
  bindCode: z.string().min(4).max(64).optional(),
  referral: z.string().optional(),
  fees: z
    .object({
      volumeBps: z.number().int().min(0).max(500),
      cashoutBps: z.number().int().min(0).max(1000),
      referralBps: z.number().int().min(0).max(5000),
      discountBps: z.number().int().min(0).max(5000),
      referrerWallet: pubkey.optional(),
    })
    .optional(),
  marketing: z
    .object({
      mode: z.enum(["off", "approve", "auto"]),
      xHandle: z.string().max(32).optional(),
      telegramChannelId: z.string().optional(),
      tone: z.string().max(200).optional(),
    })
    .optional(),
  declaredWallets: z.array(pubkey).max(50).optional(),
  mandate: MandateSchema.optional(),
  createdAt: z.number(),
  paused: z.boolean().default(false),
});

/** Global fee defaults, overridable per project at onboarding. */
export const DEFAULT_FEES = {
  volumeBps: Number(process.env.TENFOLD_FEE_VOLUME_BPS ?? "50"),
  cashoutBps: Number(process.env.TENFOLD_FEE_CASHOUT_BPS ?? "200"),
  referralBps: Number(process.env.TENFOLD_REFERRAL_BPS ?? "1000"),
  discountBps: Number(process.env.TENFOLD_REFERRED_DISCOUNT_BPS ?? "1000"),
};

/** Effective fee terms for a project: its own, else the global defaults. */
export function feeTermsFor(cfg: ProjectConfig): Required<Omit<FeeTerms, "referrerWallet">> & { referrerWallet?: string } {
  return { ...DEFAULT_FEES, ...(cfg.fees ?? {}) };
}

/**
 * Fee on one SOL amount: gross = base x volumeBps; discount applies when the project was referred;
 * the referral share is carved out of what remains. All integer bigint math, rounding down.
 */
export function computeFee(baseLamports: bigint, terms: ReturnType<typeof feeTermsFor>, kind: "volume" | "cashout"): {
  grossLamports: bigint;
  discountLamports: bigint;
  referralLamports: bigint;
  netLamports: bigint;
} {
  const base = baseLamports > 0n ? baseLamports : 0n;
  const bps = clampBps(kind === "volume" ? terms.volumeBps : terms.cashoutBps);
  const gross = (base * bps) / 10_000n;
  const referred = Boolean(terms.referrerWallet);
  const discount = referred ? (gross * clampBps(terms.discountBps)) / 10_000n : 0n;
  const afterDiscount = gross - discount;
  const referral = referred ? (afterDiscount * clampBps(terms.referralBps)) / 10_000n : 0n;
  return { grossLamports: gross, discountLamports: discount, referralLamports: referral, netLamports: afterDiscount - referral };
}

/**
 * A basis-point rate as a bigint in [0, 10000]. Project terms are schema-checked, but the global defaults come from
 * the environment unchecked; a rate above 100%, negative or NaN must never turn into a negative net or a referral
 * share larger than the fee.
 */
function clampBps(bps: number): bigint {
  if (!Number.isFinite(bps) || bps <= 0) return 0n;
  return BigInt(Math.min(10_000, Math.trunc(bps)));
}

export const DEFAULT_RULES = {
  dailySellCapPct: 0.5,
  defenseBudgetSol: 0,
  maxDefenseSpendPerDaySol: 0,
  withdrawalDelayHours: 24 as const,
  maxSlippageBps: 150,
  maxOrdersPerHour: 60,
  circuitBreakerMovePct: 35,
};

export const DEFAULT_STRATEGY = {
  defense: { enabled: false, levels: [] },
  distribution: { enabled: false, pctOfVaultPerDay: 0.5, mode: "strength" as const },
  rebalance: { enabled: false, targetSolShare: 0.3, band: 0.1 },
  clip: { minSol: 0.05, maxSol: 0.5, jitterPct: 0.35 },
};

export function parseProjectConfig(raw: unknown): ProjectConfig {
  const parsed = ProjectConfigSchema.parse(raw);
  // Strategy targets can never exceed the rule cap.
  if (parsed.strategy.distribution.pctOfVaultPerDay > parsed.rules.dailySellCapPct) {
    parsed.strategy.distribution.pctOfVaultPerDay = parsed.rules.dailySellCapPct;
  }
  if (parsed.strategy.clip.minSol > parsed.strategy.clip.maxSol) {
    throw new Error("clip.minSol must be <= clip.maxSol");
  }
  // A zero band makes rebalance flip-flop on price noise (volume for its own sake); require a real band when enabled.
  if (parsed.strategy.rebalance.enabled && parsed.strategy.rebalance.band <= 0) {
    throw new Error("rebalance.band must be > 0 when rebalance is enabled");
  }
  return parsed;
}

export function projectsDir(): string {
  return process.env.TENFOLD_PROJECTS_DIR ?? join(process.cwd(), "projects");
}

export function loadProject(id: string): ProjectConfig {
  const file = join(projectsDir(), `${id}.json`);
  return parseProjectConfig(JSON.parse(readFileSync(file, "utf8")));
}

export function loadAllProjects(): ProjectConfig[] {
  const dir = projectsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .map((f) => parseProjectConfig(JSON.parse(readFileSync(join(dir, f), "utf8"))));
}

/** Atomic write: the agent and the engine both save project files, and neither may ever read a half-written one. */
export function saveProject(cfg: ProjectConfig): void {
  const dir = projectsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const validated = parseProjectConfig(cfg);
  const file = join(dir, `${validated.id}.json`);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(validated, null, 2) + "\n");
  renameSync(tmp, file);
}

export interface Env {
  rpcUrl: string;
  dbPath: string;
  keystoreDir: string;
  keystorePassword: string;
  jitoUrl?: string;
  jitoTipLamports: bigint;
  priorityFeeMicroLamports: number;
  telegramBotToken?: string;
  anthropicApiKey?: string;
  anthropicModel: string;
  proofPort: number;
  proofBaseUrl: string;
  proofSigningSecret: string;
  /** Wallet that receives Tenfold fees when accrued fees are swept. Empty = sweeps are skipped (paper/beta). */
  feeWallet?: string;
  /** X API v2 credentials for the marketing module (OAuth 1.0a user context). */
  xApiKey?: string;
  xApiSecret?: string;
  xAccessToken?: string;
  xAccessSecret?: string;
  /** Public trader bot (the /tenfold lookup bot), separate token from the founder agent bot. */
  traderBotToken?: string;
  /** Web onboarding server. */
  onboardPort: number;
  onboardBaseUrl: string;
}

export function loadEnv(): Env {
  const e = process.env;
  return {
    rpcUrl: e.TENFOLD_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    dbPath: e.TENFOLD_DB_PATH ?? join(process.cwd(), "data", "tenfold.sqlite"),
    keystoreDir: e.TENFOLD_KEYSTORE_DIR ?? join(process.cwd(), "data", "keys"),
    keystorePassword: e.TENFOLD_KEYSTORE_PASSWORD ?? "",
    jitoUrl: e.TENFOLD_JITO_URL || undefined,
    jitoTipLamports: BigInt(e.TENFOLD_JITO_TIP_LAMPORTS ?? "100000"),
    priorityFeeMicroLamports: Number(e.TENFOLD_PRIORITY_FEE_MICROLAMPORTS ?? "50000"),
    telegramBotToken: e.TENFOLD_TELEGRAM_BOT_TOKEN || undefined,
    anthropicApiKey: e.ANTHROPIC_API_KEY || undefined,
    anthropicModel: e.TENFOLD_ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
    proofPort: Number(e.TENFOLD_PROOF_PORT ?? "8787"),
    proofBaseUrl: e.TENFOLD_PROOF_BASE_URL ?? "http://localhost:8787",
    proofSigningSecret: e.TENFOLD_PROOF_SIGNING_SECRET ?? "",
    feeWallet: e.TENFOLD_FEE_WALLET || undefined,
    xApiKey: e.TENFOLD_X_API_KEY || undefined,
    xApiSecret: e.TENFOLD_X_API_SECRET || undefined,
    xAccessToken: e.TENFOLD_X_ACCESS_TOKEN || undefined,
    xAccessSecret: e.TENFOLD_X_ACCESS_SECRET || undefined,
    traderBotToken: e.TENFOLD_TRADER_BOT_TOKEN || undefined,
    onboardPort: Number(e.TENFOLD_ONBOARD_PORT ?? "8788"),
    onboardBaseUrl: e.TENFOLD_ONBOARD_BASE_URL ?? "http://localhost:8788",
  };
}
