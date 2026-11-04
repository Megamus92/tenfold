/**
 * Badge tier rules. Pure: takes the facts the check gathered and returns the tier plus the CoverageData
 * with one reason line per check, passed or failed, so the proof page can always show "why".
 *
 *  flagged  an insider wallet (declared or linked) sold in the last 30 days
 *  beta     paper mode, or no audited on-chain vault yet (nothing is enforced on-chain)
 *  gold     live on-chain vault, mint and freeze authority revoked, LP secured, no dangerous extension,
 *           at most 1% of supply held by insiders outside the vault and public locks
 *  managed  everything else
 */
import type { BadgeTier, CoverageData, Mode } from "@tenfold/core";

/** Until the audited vault program is live no project can rank above this tier. */
export const MAX_TIER_WITHOUT_VAULT: BadgeTier = "managed";

/** Insider supply outside the vault and public locks that gold tolerates, in % of supply. */
export const GOLD_MAX_INSIDER_OUTSIDE_PCT = 1;

/** Window of insider sells that flags a project, ms. */
export const FLAG_WINDOW_MS = 30 * 86_400_000;

/** Public lockers recognised by owner program id; balances held by them count as locked. */
export const LOCKER_PROGRAMS: ReadonlyMap<string, string> = new Map([
  ["strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUyaFaDHk", "Streamflow"],
  ["LocpQgucEQHbqNABEYvBvwoxCy1LAbsfTAU1HXDVBoj", "Jupiter Lock"],
]);

/** Token-2022 extensions that can hurt holders, matched case-insensitively on the normalised name. */
export const DANGEROUS_EXTENSIONS: readonly string[] = ["transferfee", "transferhook", "permanentdelegate"];

/** Rank for tier comparisons: flagged is the floor, gold the ceiling. */
const RANK: Record<BadgeTier, number> = { flagged: 0, beta: 1, managed: 2, gold: 3 };

export interface TierInput {
  mode: Mode;
  /** True once the project's funds sit in the audited on-chain vault program. */
  onChainVault: boolean;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  lpSecured: boolean;
  /** One line on how LP security was decided, shown as the LP reason. */
  lpReason?: string;
  /** Raw extension names from the mint; the dangerous ones are filtered here. */
  extensions: string[];
  totalSupply: bigint;
  vaultPct: number;
  insiderWallets: CoverageData["insiderWallets"];
  insiderOutsidePct: number;
  /** Insider sells since onboarding. */
  insiderSellCount: number;
  /** Insider sells inside FLAG_WINDOW_MS. */
  insiderSellCount30d: number;
  lastInsiderSellTs?: number;
}

/** Normalise an extension name for matching: lower case, letters and digits only. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The subset of `extensions` that can hurt holders, original spelling kept. */
export function dangerousExtensionsOf(extensions: string[]): string[] {
  return extensions.filter((e) => DANGEROUS_EXTENSIONS.some((d) => norm(e).includes(d)));
}

/** Lower of two tiers by rank. */
export function minTier(a: BadgeTier, b: BadgeTier): BadgeTier {
  return RANK[a] <= RANK[b] ? a : b;
}

/** Percent with one decimal for reason lines. */
function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

/** Apply the tier rules to the gathered facts. */
export function computeTier(input: TierInput): { tier: BadgeTier; data: CoverageData } {
  const reasons: string[] = [];
  const dangerous = dangerousExtensionsOf(input.extensions);
  const flagged = input.insiderSellCount30d > 0;

  if (input.mode === "paper") reasons.push("Paper mode: fills are simulated, badge is beta");
  reasons.push(
    input.onChainVault
      ? "On-chain vault live: cap and withdrawal delay enforced by the program"
      : `No on-chain vault yet: cap and withdrawal delay enforced off-chain by the engine, tier capped at ${MAX_TIER_WITHOUT_VAULT}`,
  );
  reasons.push(input.mintAuthorityRevoked ? "Mint authority revoked" : "Mint authority still active: supply can be inflated");
  reasons.push(input.freezeAuthorityRevoked ? "Freeze authority revoked" : "Freeze authority still active: holders can be frozen");
  reasons.push(input.lpSecured ? `LP secured${input.lpReason ? ` (${input.lpReason})` : ""}` : input.lpReason ?? "LP status unknown");
  reasons.push(dangerous.length === 0 ? "No dangerous Token-2022 extension" : `Dangerous extensions: ${dangerous.join(", ")}`);
  reasons.push(`Vault holds ${pct(input.vaultPct)} of supply`);
  reasons.push(
    input.insiderOutsidePct <= GOLD_MAX_INSIDER_OUTSIDE_PCT
      ? `Insider supply outside the vault and locks: ${pct(input.insiderOutsidePct)}`
      : `Insider supply outside the vault and locks: ${pct(input.insiderOutsidePct)} (gold needs at most ${GOLD_MAX_INSIDER_OUTSIDE_PCT}%)`,
  );
  if (flagged) {
    const last = input.lastInsiderSellTs !== undefined ? `, last on ${new Date(input.lastInsiderSellTs).toISOString().slice(0, 10)}` : "";
    reasons.push(`${input.insiderSellCount30d} insider sell${input.insiderSellCount30d === 1 ? "" : "s"} in the last 30 days${last}`);
  } else {
    reasons.push(
      input.insiderSellCount === 0 ? "No insider sell since onboarding" : `No insider sell in the last 30 days (${input.insiderSellCount} since onboarding)`,
    );
  }

  let tier: BadgeTier;
  if (flagged) tier = "flagged";
  else if (input.mode === "paper" || !input.onChainVault) tier = "beta";
  else {
    const goldChecks =
      input.mintAuthorityRevoked &&
      input.freezeAuthorityRevoked &&
      input.lpSecured &&
      dangerous.length === 0 &&
      input.insiderOutsidePct <= GOLD_MAX_INSIDER_OUTSIDE_PCT;
    tier = goldChecks ? "gold" : "managed";
  }
  if (!input.onChainVault) tier = minTier(tier, MAX_TIER_WITHOUT_VAULT);

  const data: CoverageData = {
    mintAuthorityRevoked: input.mintAuthorityRevoked,
    freezeAuthorityRevoked: input.freezeAuthorityRevoked,
    lpSecured: input.lpSecured,
    dangerousExtensions: dangerous,
    totalSupply: input.totalSupply.toString(),
    insiderWallets: input.insiderWallets,
    insiderOutsidePct: input.insiderOutsidePct,
    vaultPct: input.vaultPct,
    insiderSellCount: input.insiderSellCount,
    reasons,
  };
  return { tier, data };
}
