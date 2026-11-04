/**
 * The one-line badge statement shown by the trader bot and the proof page. Plain English, no jargon,
 * built only from the stored coverage and the project's public rules.
 */
import type { BadgeTier, Coverage, ProjectConfig } from "@tenfold/core";

/** Short label per tier, as the pill reads it. */
export const TIER_LABEL: Record<BadgeTier, string> = {
  gold: "Tenfold Gold",
  managed: "Managed by Tenfold",
  beta: "Managed by Tenfold, beta",
  flagged: "Flagged by Tenfold",
};

/** Statement prefix per tier. */
const STATEMENT_HEAD: Record<BadgeTier, string> = {
  gold: "Tenfold Managed, gold",
  managed: "Tenfold Managed",
  beta: "Tenfold Managed, beta",
  flagged: "Tenfold FLAGGED",
};

/** Percent with no trailing zeros, at most one decimal. */
function pct(n: number): string {
  const s = n.toFixed(1);
  return `${s.endsWith(".0") ? s.slice(0, -2) : s}%`;
}

/** One sentence on what the badge means, for tokens Tenfold does not manage. */
export const BADGE_MEANING =
  "A Tenfold badge means the team vault trades only through Tenfold, under a public daily sell cap and withdrawal delay, with every trade and insider wallet shown on a public proof page.";

/** The "vault cannot dump" clause from the project's public rules. */
function capClause(cfg: ProjectConfig): string {
  return `vault cannot dump through the MM (${pct(cfg.rules.dailySellCapPct)} of vault tokens per day, ${cfg.rules.withdrawalDelayHours} h withdrawal delay)`;
}

/** Statement for a project whose first coverage check has not run yet. */
export function pendingBadgeStatement(cfg: ProjectConfig): string {
  return `${STATEMENT_HEAD.beta}: ${capClause(cfg)}; supply coverage not checked yet`;
}

/**
 * E.g. "Tenfold Managed, beta: vault cannot dump through the MM (0.5% of vault tokens per day, 24 h withdrawal delay);
 * 42% of supply held by insiders outside the vault; last insider sell: none".
 */
export function badgeStatement(coverage: Coverage, cfg: ProjectConfig, opts: { lastSellTs?: number } = {}): string {
  const d = coverage.data;
  const parts: string[] = [];
  parts.push(coverage.tier === "flagged" ? `an insider wallet sold since onboarding (${d.insiderSellCount} sell${d.insiderSellCount === 1 ? "" : "s"})` : capClause(cfg));
  parts.push(`${pct(d.insiderOutsidePct)} of supply held by insiders outside the vault`);
  if (d.insiderSellCount === 0) parts.push("last insider sell: none");
  else if (opts.lastSellTs !== undefined) parts.push(`last insider sell: ${new Date(opts.lastSellTs).toISOString().slice(0, 10)}`);
  else parts.push(`insider sells since onboarding: ${d.insiderSellCount}`);
  return `${STATEMENT_HEAD[coverage.tier]}: ${parts.join("; ")}`;
}
