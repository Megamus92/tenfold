/** Display helpers shared by actions and alerts: everything the founder reads goes through here. */

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

/** Whole-token amounts with thousands separators. */
export function fmtTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "n/a";
  return n.toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) < 1000 ? 2 : 0 });
}

/** Percentages, up to 2 decimals. */
export function fmtPct(p: number | undefined): string {
  if (p === undefined || !Number.isFinite(p)) return "n/a";
  return trimZeros(p.toFixed(2)) + "%";
}

/** Hours of runway; Infinity reads as "unlimited". */
export function fmtHours(h: number | undefined): string {
  if (h === undefined || Number.isNaN(h)) return "n/a";
  if (!Number.isFinite(h)) return "unlimited";
  return h >= 100 ? Math.round(h).toString() : trimZeros(h.toFixed(1));
}

/** Unix ms as a compact UTC stamp. */
export function fmtTime(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/** Signed percentage change between two prices. */
export function fmtChange(from: number | undefined, to: number | undefined): string {
  if (!from || to === undefined) return "";
  const pct = ((to - from) / from) * 100;
  return `${pct >= 0 ? "+" : ""}${trimZeros(pct.toFixed(1))}%`;
}
