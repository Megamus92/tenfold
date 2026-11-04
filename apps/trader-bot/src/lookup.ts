/**
 * Read-only lookup of one mint in the ledger: the project, its latest coverage and today's cap usage,
 * as plain display values. Never writes a row.
 */
import { dailyCapAmount, loadAllProjects, type BadgeTier, type Ledger, type Mode, type ProjectConfig, type Snapshot } from "@tenfold/core";
import { badgeStatement, pendingBadgeStatement } from "@tenfold/coverage";

const DAY = 86_400_000;

export interface LookupView {
  id: string;
  name: string;
  mint: string;
  mode: Mode;
  paused: boolean;
  tier: BadgeTier;
  /** The one-line badge statement. */
  statement: string;
  dailySellCapPct: number;
  withdrawalDelayHours: 24 | 48;
  capUsedTodayPct: number;
  /** null until the first coverage check. */
  vaultPct: number | null;
  insiderOutsidePct: number | null;
  insiderSells7d: number;
  reasons: string[];
  coverageTs: number | null;
}

/** Project for a mint: the ledger first, the project files on disk as a fallback (read-only either way). */
export function findProject(ledger: Ledger, mint: string): ProjectConfig | undefined {
  const fromLedger = ledger.listProjects().find((p) => p.mint === mint);
  if (fromLedger) return fromLedger;
  try {
    return loadAllProjects().find((p) => p.mint === mint);
  } catch {
    return undefined;
  }
}

/** Percent of today's cap already sold, one decimal, exact bigint division. */
function capUsedPct(cfg: ProjectConfig, ledger: Ledger, now: number): number {
  const snap: Snapshot = ledger.snapshotAt(cfg.id, now) ?? { projectId: cfg.id, ts: now, price: 0, buyFlow5mSol: 0, sellFlow5mSol: 0, vaultTokens: 0n, vaultLamports: 0n };
  const rolling = ledger.rollingState(cfg.id, now);
  const cap = dailyCapAmount(cfg, snap, rolling);
  if (cap <= 0n) return 0;
  return Math.min(100, Number((rolling.soldLast24h * 1000n) / cap) / 10);
}

/** The view for a mint, or undefined when Tenfold does not manage it. */
export function lookupMint(ledger: Ledger, mint: string, now = Date.now()): LookupView | undefined {
  const cfg = findProject(ledger, mint);
  if (!cfg) return undefined;
  const cov = ledger.latestCoverage(cfg.id);
  const lastSell = ledger.listInsiderSells(cfg.id, 0, 1)[0];
  const statement = cov ? badgeStatement(cov, cfg, { lastSellTs: lastSell?.ts }) : pendingBadgeStatement(cfg);
  return {
    id: cfg.id,
    name: cfg.name,
    mint: cfg.mint,
    mode: cfg.mode,
    paused: cfg.paused,
    tier: cov?.tier ?? "beta",
    statement,
    dailySellCapPct: cfg.rules.dailySellCapPct,
    withdrawalDelayHours: cfg.rules.withdrawalDelayHours,
    capUsedTodayPct: capUsedPct(cfg, ledger, now),
    vaultPct: cov?.data.vaultPct ?? null,
    insiderOutsidePct: cov?.data.insiderOutsidePct ?? null,
    insiderSells7d: ledger.listInsiderSells(cfg.id, now - 7 * DAY, 10_000).length,
    reasons: cov?.data.reasons ?? [],
    coverageTs: cov?.ts ?? null,
  };
}
