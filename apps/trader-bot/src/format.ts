/** Telegram replies of the trader bot, plain text (no parse mode, so nothing needs escaping). */
import { BADGE_MEANING, TIER_LABEL } from "@tenfold/coverage";
import type { LookupView } from "./lookup.js";

const SOLSCAN = "https://solscan.io";

/** Percent with up to one decimal, no trailing zero. */
export function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "n/a";
  const s = n.toFixed(1);
  return `${s.endsWith(".0") ? s.slice(0, -2) : s}%`;
}

/** Unix ms as a short UTC stamp. */
export function fmtTime(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/** Public proof page URL for a project. */
export function proofUrl(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/p/${id}`;
}

/** The /start text: what the bot does, in three lines. */
export const START_TEXT = [
  "Send me a Solana mint address (or a Solscan, pump.fun or Dexscreener link) and I tell you whether Tenfold manages it.",
  "Managed means the team vault trades only through Tenfold, under a public daily sell cap and withdrawal delay, with every insider wallet and trade on a public proof page.",
  "I answer with the badge tier, the live limits, the insider coverage and the proof link. I never give trading advice.",
].join("\n");

/** Reply for a mint Tenfold does not manage. */
export function formatUnknown(mint: string): string {
  return `Not managed by Tenfold: ${mint}\n${BADGE_MEANING}`;
}

/** Reply for a managed mint. */
export function formatLookup(v: LookupView, baseUrl: string): string {
  const lines: string[] = [];
  lines.push(`${v.name}: ${TIER_LABEL[v.tier]}${v.mode === "paper" ? " (paper)" : ""}${v.paused ? " (paused)" : ""}`);
  lines.push(v.statement);
  lines.push("");
  lines.push(`Daily sell cap: ${fmtPct(v.dailySellCapPct)} of vault tokens per 24h, ${fmtPct(v.capUsedTodayPct)} used today`);
  lines.push(`Withdrawal delay: ${v.withdrawalDelayHours} h`);
  lines.push(`Vault share of supply: ${fmtPct(v.vaultPct)}`);
  lines.push(`Insiders outside vault and locks: ${fmtPct(v.insiderOutsidePct)}`);
  lines.push(`Insider sells (7d): ${v.insiderSells7d}`);
  lines.push(`Coverage checked: ${v.coverageTs === null ? "not yet" : fmtTime(v.coverageTs)}`);
  if (v.reasons.length > 0) {
    lines.push("");
    lines.push("Why:");
    for (const r of v.reasons) lines.push(`- ${r}`);
  }
  lines.push("");
  lines.push(`Proof: ${proofUrl(baseUrl, v.id)}`);
  lines.push(`Solscan: ${SOLSCAN}/token/${v.mint}`);
  return lines.join("\n");
}
