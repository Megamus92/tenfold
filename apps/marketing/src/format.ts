/** Display helpers for public posts. Numbers only; every word around them lives in drafts.ts. */

function trimZeros(s: string): string {
  return s.includes("e") ? s : s.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
}

/** SOL per token, 4 significant digits, no trailing zeros. */
export function fmtPrice(p: number | undefined): string {
  if (p === undefined || !Number.isFinite(p)) return "n/a";
  if (p === 0) return "0";
  return trimZeros(p >= 1 ? p.toFixed(4) : p.toPrecision(4));
}

/** SOL amounts: 3 decimals below 1, 2 below 100, 1 above. */
export function fmtSol(x: number | undefined): string {
  if (x === undefined || !Number.isFinite(x)) return "n/a";
  const abs = Math.abs(x);
  const s = abs >= 100 ? x.toFixed(1) : abs >= 1 ? x.toFixed(2) : x.toFixed(3);
  return trimZeros(s);
}

/** Whole-token amounts with thousands separators; above a million, compact (1.2M). */
export function fmtTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "n/a";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return trimZeros((n / 1_000_000_000).toFixed(2)) + "B";
  if (abs >= 1_000_000) return trimZeros((n / 1_000_000).toFixed(2)) + "M";
  return n.toLocaleString("en-US", { maximumFractionDigits: abs < 1000 ? 2 : 0 });
}

/** Plain integer with thousands separators (holders, days, fills). */
export function fmtInt(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "n/a";
  return Math.round(n).toLocaleString("en-US");
}

/** Percentages, up to 2 decimals. */
export function fmtPct(p: number | undefined): string {
  if (p === undefined || !Number.isFinite(p)) return "n/a";
  return trimZeros(p.toFixed(2)) + "%";
}

/** Signed percentage change between two prices, "" when either is missing. */
export function fmtChange(from: number | undefined, to: number | undefined): string {
  if (!from || to === undefined || !Number.isFinite(to)) return "";
  const pct = ((to - from) / from) * 100;
  return `${pct >= 0 ? "+" : ""}${trimZeros(pct.toFixed(1))}%`;
}

/** Minutes as "45 min" or "3.5 h". */
export function fmtDuration(minutes: number | undefined): string {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes < 0) return "n/a";
  if (minutes < 90) return `${Math.round(minutes)} min`;
  return `${trimZeros((minutes / 60).toFixed(1))} h`;
}

/** First 8 characters of a signature or hash, with an ellipsis of three dots. */
export function short(s: string | undefined, n = 8): string {
  if (!s) return "";
  return s.length <= n ? s : `${s.slice(0, n)}...`;
}

/** UTC calendar day as YYYY-MM-DD. */
export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Unix ms as a compact UTC stamp, "2026-10-31 09:00 UTC". */
export function fmtTime(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
