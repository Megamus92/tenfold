/**
 * Pure view builders over the Ledger. Everything the proof page and the screener API show is produced here,
 * as plain JSON (display units: tokens as numbers using the project's decimals, SOL as numbers, never bigint),
 * so the views can be tested without HTTP and cached by the server as opaque values.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  baseToTokens,
  dailyCapAmount,
  defenseBudgetRemainingLamports,
  feeTermsFor,
  lamportsToSol,
  type BadgeTier,
  type Coverage,
  type DailyReport,
  type Fill,
  type Ledger,
  type ProjectConfig,
  type ReasonCode,
  type Side,
  type Snapshot,
} from "@tenfold/core";
import { badgeStatement, pendingBadgeStatement } from "@tenfold/coverage";

const DAY = 86_400_000;
const WINDOW_30D = 30 * DAY;
const TRADES_LIMIT = 200;
const INSIDER_SELLS_LIMIT = 30;
const ANCHORS_LIMIT = 60;
/** Large enough to read every fill or snapshot of a window in one query. */
const ALL = 1_000_000;
const REASONS: readonly ReasonCode[] = ["DEF", "DIST", "REB", "LP", "MANUAL"];

/** Badge family shown on the pill: 'beta' and 'managed' tiers both wear the "Managed by Tenfold" badge. */
export type Badge = "managed" | "gold" | "flagged";

/** Tier -> badge family. */
export function badgeOf(tier: BadgeTier): Badge {
  return tier === "gold" || tier === "flagged" ? tier : "managed";
}

/** Tier before the first coverage check: nothing is verified on-chain yet. */
const PENDING_TIER: BadgeTier = "beta";

export interface RulesView {
  dailySellCapPct: number;
  defenseBudgetSol: number;
  maxDefenseSpendPerDaySol: number;
  withdrawalDelayHours: 24 | 48;
}

export interface TodayView {
  capTokens: number;
  soldTokens: number;
  capUsedPct: number;
  defenseSpentSol: number;
  defenseBudgetLeftSol: number;
}

export interface VaultView {
  tokens: number;
  sol: number;
  price: number;
  valueSol: number;
}

export interface DepositView {
  ts: number;
  kind: "token" | "sol";
  amount: number;
  txSig: string | null;
  note: string | null;
}

export interface TradeView {
  ts: number;
  side: Side;
  reason: ReasonCode;
  tokens: number;
  sol: number;
  price: number;
  txSig: string | null;
  paper: boolean;
}

export type VolumeByReason = Record<ReasonCode, number>;

export interface VaultShareView {
  /** Vault SOL volume as a % of the summed snapshot buy+sell flow; null when no market flow was recorded. */
  pct: number | null;
  label: "estimate";
}

export interface PnlView {
  proceedsSol30d: number;
  defenseSpentSol30d: number;
  feesSol30d: number;
  distributionVsTokenBps: number | null;
}

export interface ReportView {
  from: number;
  to: number;
  fills: number;
  byReason: Record<string, number>;
  soldTokens: number;
  soldProceedsSol: number;
  boughtTokens: number;
  boughtCostSol: number;
  defenseSol: number;
  feesSol: number;
  priceOpen: number | null;
  priceClose: number | null;
  tokenVwap: number | null;
  distributionVwap: number | null;
  distributionVsTokenBps: number | null;
  vaultTokens: number | null;
  vaultSol: number | null;
}

export interface InsiderWalletView {
  wallet: string;
  pctOfSupply: number;
  /** Declared by the founder at onboarding. */
  declared: boolean;
  /** Found by following funding links from the declared wallets. */
  linked: boolean;
  /** Balance sits in a public locker (Streamflow, Jupiter Lock). */
  locked: boolean;
}

export interface CoverageView {
  ts: number;
  tier: BadgeTier;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  lpSecured: boolean;
  dangerousExtensions: string[];
  /** Whole tokens. */
  totalSupply: number;
  vaultPct: number;
  insiderOutsidePct: number;
  insiderSellCount: number;
  insiderWallets: InsiderWalletView[];
  reasons: string[];
}

export interface InsiderSellView {
  ts: number;
  wallet: string;
  tokens: number;
  pctOfSupply: number | null;
  txSig: string;
}

export interface FeeTermsView {
  volumeBps: number;
  cashoutBps: number;
  referralBps: number;
  discountBps: number;
  referred: boolean;
}

export interface FeesView {
  terms: FeeTermsView;
  grossSol: number;
  discountSol: number;
  referralSol: number;
  /** What Tenfold keeps after discount and referral. */
  netSol: number;
  sweptSol: number;
  accruedSol: number;
  byKindSol: Record<string, number>;
}

export interface AnchorView {
  day: string;
  entries: number;
  hash: string;
  txSig: string | null;
  ts: number;
}

export interface ProjectView {
  id: string;
  name: string;
  mint: string;
  wallet: string;
  mode: ProjectConfig["mode"];
  badge: Badge;
  tier: BadgeTier;
  /** One plain-English line on what the badge means for this project. */
  badgeStatement: string;
  /** Why the tier is what it is, one line per check; a single line before the first check. */
  reasons: string[];
  rules: RulesView;
  today: TodayView;
  vault: VaultView;
  /** null until the first coverage check. */
  coverage: CoverageView | null;
  insiderSells: InsiderSellView[];
  insiderSellCount30d: number;
  fees: FeesView;
  anchors: AnchorView[];
  deposits: DepositView[];
  trades: TradeView[];
  volumeByReason30d: VolumeByReason;
  vaultShareOfVolume30d: VaultShareView;
  pnl: PnlView;
  report: ReportView;
  lastSnapshotTs: number | null;
  asOf: number;
}

export interface VerifyPayload {
  mint: string;
  wallet: string;
  badge: Badge;
  tier: BadgeTier;
  dailySellCapPct: number;
  withdrawalDelayHours: 24 | 48;
  capUsedTodayPct: number;
  vaultTokens: number;
  vaultSol: number;
  /** null until the first coverage check. */
  insiderOutsidePct: number | null;
  insiderSellCount30d: number;
  /** Memo transaction of the most recent daily log anchor, null when none was posted yet. */
  lastAnchorTx: string | null;
  lastTradeTs: number | null;
  asOf: number;
}

export interface VerifyView extends VerifyPayload {
  /** HMAC-SHA256 hex over canonicalJson(payload). Becomes an Ed25519 signature by the vault authority once on-chain. */
  signature: string;
}

export interface TrackRecordEntry {
  id: string;
  name: string;
  badge: Badge;
  tier: BadgeTier;
  since: number;
  status: "active" | "paused";
  trades30d: number;
  vaultSol: number;
}

/** Round to `dp` decimals without string conversion. */
function round(n: number, dp: number): number {
  const k = 10 ** dp;
  return Math.round(n * k) / k;
}

/** SOL side of a fill in lamports: sells receive SOL, buys spend it. */
function fillLamports(f: Fill): bigint {
  return f.side === "sell" ? f.outAmount : f.inAmount;
}

/** Token side of a fill in base units: sells spend tokens, buys receive them. */
function fillTokenBase(f: Fill): bigint {
  return f.side === "sell" ? f.inAmount : f.outAmount;
}

/** A zero snapshot so the cap math still works before the engine has written one. */
function emptySnapshot(projectId: string, ts: number): Snapshot {
  return { projectId, ts, price: 0, buyFlow5mSol: 0, sellFlow5mSol: 0, vaultTokens: 0n, vaultLamports: 0n };
}

/** Fill -> display row. */
function toTrade(f: Fill, decimals: number): TradeView {
  return {
    ts: f.ts,
    side: f.side,
    reason: f.reason,
    tokens: baseToTokens(fillTokenBase(f), decimals),
    sol: lamportsToSol(fillLamports(f)),
    price: f.price,
    txSig: f.txSig ?? null,
    paper: f.paper,
  };
}

/** DailyReport (bigint) -> display units. */
function toReportView(r: DailyReport, decimals: number): ReportView {
  return {
    from: r.from,
    to: r.to,
    fills: r.fills,
    byReason: r.byReason,
    soldTokens: baseToTokens(r.soldTokens, decimals),
    soldProceedsSol: lamportsToSol(r.soldProceedsLamports),
    boughtTokens: baseToTokens(r.boughtTokens, decimals),
    boughtCostSol: lamportsToSol(r.boughtCostLamports),
    defenseSol: lamportsToSol(r.defenseLamports),
    feesSol: lamportsToSol(r.feesLamports),
    priceOpen: r.priceOpen ?? null,
    priceClose: r.priceClose ?? null,
    tokenVwap: r.tokenVwap ?? null,
    distributionVwap: r.distributionVwap ?? null,
    distributionVsTokenBps: r.distributionVsTokenBps ?? null,
    vaultTokens: r.vaultTokens !== undefined ? baseToTokens(r.vaultTokens, decimals) : null,
    vaultSol: r.vaultLamports !== undefined ? lamportsToSol(r.vaultLamports) : null,
  };
}

/** Stored coverage -> display units; the vault wallet never appears as an insider. */
function toCoverageView(c: Coverage, decimals: number): CoverageView {
  return {
    ts: c.ts,
    tier: c.tier,
    mintAuthorityRevoked: c.data.mintAuthorityRevoked,
    freezeAuthorityRevoked: c.data.freezeAuthorityRevoked,
    lpSecured: c.data.lpSecured,
    dangerousExtensions: c.data.dangerousExtensions,
    totalSupply: baseToTokens(BigInt(c.data.totalSupply), decimals),
    vaultPct: c.data.vaultPct,
    insiderOutsidePct: c.data.insiderOutsidePct,
    insiderSellCount: c.data.insiderSellCount,
    insiderWallets: c.data.insiderWallets.map((w) => ({ wallet: w.wallet, pctOfSupply: w.pctOfSupply, declared: w.declared, linked: !w.declared && !w.locked, locked: w.locked })),
    reasons: c.data.reasons,
  };
}

/** Fee totals in SOL with the project's terms. */
function toFeesView(ledger: Ledger, cfg: ProjectConfig): FeesView {
  const s = ledger.feeSummary(cfg.id);
  const t = feeTermsFor(cfg);
  return {
    terms: { volumeBps: t.volumeBps, cashoutBps: t.cashoutBps, referralBps: t.referralBps, discountBps: t.discountBps, referred: Boolean(t.referrerWallet) },
    grossSol: lamportsToSol(s.grossLamports),
    discountSol: lamportsToSol(s.discountLamports),
    referralSol: lamportsToSol(s.referralLamports),
    netSol: lamportsToSol(s.netLamports),
    sweptSol: lamportsToSol(s.sweptLamports),
    accruedSol: lamportsToSol(s.accruedLamports),
    byKindSol: Object.fromEntries(Object.entries(s.byKind).map(([k, v]) => [k, lamportsToSol(v)])),
  };
}

/** Latest coverage, the statement and the tier, read from the ledger. */
function badgeState(ledger: Ledger, cfg: ProjectConfig): { tier: BadgeTier; statement: string; reasons: string[]; coverage: Coverage | undefined } {
  const coverage = ledger.latestCoverage(cfg.id);
  if (!coverage) return { tier: PENDING_TIER, statement: pendingBadgeStatement(cfg), reasons: ["No coverage check yet"], coverage };
  const lastSell = ledger.listInsiderSells(cfg.id, 0, 1)[0];
  return { tier: coverage.tier, statement: badgeStatement(coverage, cfg, { lastSellTs: lastSell?.ts }), reasons: coverage.data.reasons, coverage };
}

/** The full public view of one project, read entirely from the ledger as of `now`. */
export function projectView(ledger: Ledger, cfg: ProjectConfig, now = Date.now()): ProjectView {
  const d = cfg.decimals;
  const latest = ledger.snapshotAt(cfg.id, now);
  const snapshot = latest ?? emptySnapshot(cfg.id, now);
  const rolling = ledger.rollingState(cfg.id, now);

  const capTokens = baseToTokens(dailyCapAmount(cfg, snapshot, rolling), d);
  const soldTokens = baseToTokens(rolling.soldLast24h, d);
  const today: TodayView = {
    capTokens,
    soldTokens,
    capUsedPct: capTokens > 0 ? round((soldTokens / capTokens) * 100, 1) : 0,
    defenseSpentSol: lamportsToSol(rolling.defenseSpentLast24hLamports),
    defenseBudgetLeftSol: lamportsToSol(defenseBudgetRemainingLamports(cfg, rolling)),
  };

  const vaultTokens = baseToTokens(snapshot.vaultTokens, d);
  const vaultSol = lamportsToSol(snapshot.vaultLamports);
  const vault: VaultView = { tokens: vaultTokens, sol: vaultSol, price: snapshot.price, valueSol: vaultTokens * snapshot.price + vaultSol };

  const since30d = now - WINDOW_30D;
  const fills30d = ledger.listFills(cfg.id, { since: since30d, until: now, limit: ALL });
  const byReasonLamports: Record<ReasonCode, bigint> = { DEF: 0n, DIST: 0n, REB: 0n, LP: 0n, MANUAL: 0n };
  let proceeds = 0n;
  let defense = 0n;
  let fees = 0n;
  for (const f of fills30d) {
    byReasonLamports[f.reason] += fillLamports(f);
    fees += f.feeLamports;
    if (f.side === "sell") proceeds += f.outAmount;
    else if (f.reason === "DEF") defense += f.inAmount;
  }
  const volumeByReason30d = Object.fromEntries(REASONS.map((r) => [r, lamportsToSol(byReasonLamports[r])])) as VolumeByReason;
  const vaultVolumeLamports = REASONS.reduce((acc, r) => acc + byReasonLamports[r], 0n);

  let marketFlowSol = 0;
  for (const s of ledger.snapshotsSince(cfg.id, since30d, ALL)) {
    if (s.ts <= now) marketFlowSol += s.buyFlow5mSol + s.sellFlow5mSol;
  }
  const vaultShareOfVolume30d: VaultShareView = {
    pct: marketFlowSol > 0 ? round((lamportsToSol(vaultVolumeLamports) / marketFlowSol) * 100, 1) : null,
    label: "estimate",
  };

  const report = toReportView(ledger.dailyReport(cfg.id, now), d);
  const pnl: PnlView = {
    proceedsSol30d: lamportsToSol(proceeds),
    defenseSpentSol30d: lamportsToSol(defense),
    feesSol30d: lamportsToSol(fees),
    distributionVsTokenBps: report.distributionVsTokenBps,
  };

  const trades = ledger.listFills(cfg.id, { until: now, limit: TRADES_LIMIT }).map((f) => toTrade(f, d));
  const deposits: DepositView[] = ledger.listDeposits(cfg.id).map((dep) => ({
    ts: dep.ts,
    kind: dep.kind,
    amount: dep.kind === "sol" ? lamportsToSol(dep.amount) : baseToTokens(dep.amount, d),
    txSig: dep.txSig ?? null,
    note: dep.note ?? null,
  }));

  const badge = badgeState(ledger, cfg);
  const insiderSells: InsiderSellView[] = ledger.listInsiderSells(cfg.id, 0, INSIDER_SELLS_LIMIT).map((s) => ({
    ts: s.ts,
    wallet: s.wallet,
    tokens: baseToTokens(s.amount, d),
    pctOfSupply: s.pctOfSupply ?? null,
    txSig: s.txSig,
  }));
  const insiderSellCount30d = ledger.listInsiderSells(cfg.id, since30d, ALL).filter((s) => s.ts <= now).length;
  const anchors: AnchorView[] = ledger.listAnchors(cfg.id, ANCHORS_LIMIT).map((a) => ({ day: a.day, entries: a.entries, hash: a.hash, txSig: a.txSig ?? null, ts: a.ts }));

  return {
    id: cfg.id,
    name: cfg.name,
    mint: cfg.mint,
    wallet: cfg.walletPubkey,
    mode: cfg.mode,
    badge: badgeOf(badge.tier),
    tier: badge.tier,
    badgeStatement: badge.statement,
    reasons: badge.reasons,
    rules: {
      dailySellCapPct: cfg.rules.dailySellCapPct,
      defenseBudgetSol: cfg.rules.defenseBudgetSol,
      maxDefenseSpendPerDaySol: cfg.rules.maxDefenseSpendPerDaySol,
      withdrawalDelayHours: cfg.rules.withdrawalDelayHours,
    },
    today,
    vault,
    coverage: badge.coverage ? toCoverageView(badge.coverage, d) : null,
    insiderSells,
    insiderSellCount30d,
    fees: toFeesView(ledger, cfg),
    anchors,
    deposits,
    trades,
    volumeByReason30d,
    vaultShareOfVolume30d,
    pnl,
    report,
    lastSnapshotTs: latest?.ts ?? null,
    asOf: now,
  };
}

/** Deterministic JSON: object keys sorted recursively, undefined dropped, so signatures survive re-serialization. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** HMAC-SHA256 hex of the canonical payload. To be replaced by an Ed25519 signature from the vault authority once on-chain. */
export function signPayload(payload: VerifyPayload, secret: string): string {
  return createHmac("sha256", secret).update(canonicalJson(payload)).digest("hex");
}

/** Recompute the signature of a verify view and compare in constant time. */
export function verifySignature(view: VerifyView, secret: string): boolean {
  const { signature, ...payload } = view;
  const expected = Buffer.from(signPayload(payload, secret), "hex");
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The minimal signed object a screener consumes to confirm the badge and the live limits. */
export function verifyView(ledger: Ledger, cfg: ProjectConfig, now: number, secret: string): VerifyView {
  const v = projectView(ledger, cfg, now);
  const payload: VerifyPayload = {
    mint: v.mint,
    wallet: v.wallet,
    badge: v.badge,
    tier: v.tier,
    dailySellCapPct: v.rules.dailySellCapPct,
    withdrawalDelayHours: v.rules.withdrawalDelayHours,
    capUsedTodayPct: v.today.capUsedPct,
    vaultTokens: v.vault.tokens,
    vaultSol: v.vault.sol,
    insiderOutsidePct: v.coverage?.insiderOutsidePct ?? null,
    insiderSellCount30d: v.insiderSellCount30d,
    lastAnchorTx: v.anchors.find((a) => a.txSig !== null)?.txSig ?? null,
    lastTradeTs: v.trades[0]?.ts ?? null,
    asOf: now,
  };
  return { ...payload, signature: signPayload(payload, secret) };
}

/** One row per project for the index page and /api/projects. */
export function trackRecord(ledger: Ledger, now = Date.now()): TrackRecordEntry[] {
  return ledger.listProjects().map((cfg) => {
    const snap = ledger.snapshotAt(cfg.id, now);
    const tier = ledger.latestCoverage(cfg.id)?.tier ?? PENDING_TIER;
    return {
      id: cfg.id,
      name: cfg.name,
      badge: badgeOf(tier),
      tier,
      since: cfg.createdAt,
      status: cfg.paused ? "paused" : "active",
      trades30d: ledger.listFills(cfg.id, { since: now - WINDOW_30D, until: now, limit: ALL }).length,
      vaultSol: snap ? lamportsToSol(snap.vaultLamports) : 0,
    };
  });
}
