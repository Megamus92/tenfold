/**
 * Server-rendered HTML for the proof pages. No frameworks, no external assets: one inline stylesheet,
 * system font, dark background, yellow accent. Every dynamic string goes through esc().
 */
import type { AnchorView, InsiderSellView, InsiderWalletView, ProjectView, TradeView, TrackRecordEntry } from "./api.js";
import type { BadgeTier, ReasonCode } from "@tenfold/core";
import { TIER_LABEL } from "@tenfold/coverage";

const SOLSCAN = "https://solscan.io";

/** Escape a value for safe inclusion in HTML text or attribute content. */
export function esc(v: string | number | null | undefined): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Grouped integer or short decimal, for token amounts. */
function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** SOL with up to four decimals. */
function fmtSol(n: number): string {
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}

/** Price in SOL per token with 4 significant digits (prices are usually tiny). */
function fmtPrice(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n === 0) return "-";
  return n.toPrecision(4);
}

/** Percent with one decimal. */
function fmtPct(n: number | null): string {
  return n === null || !Number.isFinite(n) ? "-" : `${n.toFixed(1)}%`;
}

/** UTC timestamp, short. */
function fmtTs(ts: number | null): string {
  if (ts === null) return "-";
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

/** Head and tail of a base58 string. */
function short(s: string, n = 4): string {
  return s.length <= n * 2 + 1 ? s : `${s.slice(0, n)}…${s.slice(-n)}`;
}

const REASON_TITLE: Record<ReasonCode, string> = {
  DEF: "Level defense: buy at a founder-set level",
  DIST: "Distribution: sell into strength, within the daily cap",
  REB: "Rebalance: keep the token/SOL ratio inside the band",
  LP: "Liquidity position management",
  MANUAL: "Founder-instructed one-off, validated by the risk engine",
};

/** Reason code as a colored pill. */
function reasonPill(r: ReasonCode): string {
  return `<span class="pill r-${esc(r)}" title="${esc(REASON_TITLE[r])}">${esc(r)}</span>`;
}

/** The tier as a pill; the reasons ride along as the title so hovering explains the tier. */
function badgePill(tier: BadgeTier, reasons: string[] = []): string {
  return `<span class="badge b-${esc(tier)}" title="${esc(reasons.join("\n"))}">${esc(TIER_LABEL[tier])}</span>`;
}

function txCell(sig: string | null): string {
  if (!sig) return `<span class="muted">-</span>`;
  return `<a href="${SOLSCAN}/tx/${esc(sig)}" target="_blank" rel="noopener">${esc(short(sig, 5))}</a>`;
}

function accountCell(pubkey: string): string {
  return `<a class="mono" href="${SOLSCAN}/account/${esc(pubkey)}" target="_blank" rel="noopener">${esc(short(pubkey, 5))}</a>`;
}

/** Yes/no as a small check or cross. */
function flag(ok: boolean): string {
  return ok ? `<span class="ok">yes</span>` : `<span class="no">no</span>`;
}

function insiderRow(w: InsiderWalletView): string {
  const kind = w.declared ? "declared" : w.locked ? "locker" : "linked";
  return `<tr>
<td>${accountCell(w.wallet)}</td>
<td><span class="tag">${esc(kind)}</span>${w.locked ? ` <span class="tag lock">locked</span>` : ""}</td>
<td class="num">${esc(fmtPct(w.pctOfSupply))}</td>
</tr>`;
}

function sellRow(s: InsiderSellView): string {
  return `<tr>
<td class="mono">${esc(fmtTs(s.ts))}</td>
<td>${accountCell(s.wallet)}</td>
<td class="num">${esc(fmtTokens(s.tokens))}</td>
<td class="num">${esc(fmtPct(s.pctOfSupply))}</td>
<td>${txCell(s.txSig)}</td>
</tr>`;
}

function anchorRow(a: AnchorView): string {
  return `<tr>
<td class="mono">${esc(a.day)}</td>
<td class="num">${esc(a.entries)}</td>
<td class="mono hash" title="${esc(a.hash)}">${esc(short(a.hash, 8))}</td>
<td>${a.txSig ? txCell(a.txSig) : `<span class="muted">not posted yet</span>`}</td>
</tr>`;
}

function tradeRow(t: TradeView): string {
  return `<tr>
<td class="mono">${esc(fmtTs(t.ts))}</td>
<td class="${t.side === "buy" ? "buy" : "sell"}">${esc(t.side)}</td>
<td>${reasonPill(t.reason)}</td>
<td class="num">${esc(fmtTokens(t.tokens))}</td>
<td class="num">${esc(fmtSol(t.sol))}</td>
<td class="num mono">${esc(fmtPrice(t.price))}</td>
<td>${txCell(t.txSig)}${t.paper ? ` <span class="tag">paper</span>` : ""}</td>
</tr>`;
}

const CSS = `
:root{--bg:#0b0b0d;--panel:#15161a;--line:#26272d;--fg:#e8e8ea;--muted:#8a8b93;--accent:#f5c518;--buy:#39c27a;--sell:#ff6b6b;--def:#3aa0ff;--dist:#f5c518;--reb:#b58cff;--lp:#2ad3c8;--manual:#ff9f43}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
main{max-width:760px;margin:0 auto;padding:24px 16px 48px}
header h1{margin:0 0 6px;font-size:26px;letter-spacing:-.01em}
header .ids{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
.muted{color:var(--muted)}
.num{text-align:right;font-variant-numeric:tabular-nums}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;background:var(--accent);color:#111;vertical-align:middle;margin-left:8px;cursor:help}
.badge.b-gold{background:#ffd700}.badge.b-flagged{background:var(--sell);color:#fff}.badge.b-beta{background:var(--panel);color:var(--accent);border:1px solid var(--accent)}
.statement{margin:10px 0 0;font-size:14px}
.why{margin:6px 0 0;padding:0;list-style:none;font-size:12.5px;color:var(--muted)}
.why li{display:inline}.why li+li::before{content:" · "}
.ok{color:var(--buy);font-weight:600}.no{color:var(--sell);font-weight:600}
.tag.lock{color:var(--lp);border-color:var(--lp)}
.hash{letter-spacing:.02em}
.note{margin:0 0 10px;font-size:13px;color:var(--muted)}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.03em;color:#111}
.r-DEF{background:var(--def)}.r-DIST{background:var(--dist)}.r-REB{background:var(--reb)}.r-LP{background:var(--lp)}.r-MANUAL{background:var(--manual)}
.tag{display:inline-block;padding:0 6px;border:1px solid var(--line);border-radius:4px;font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;vertical-align:middle}
.buy{color:var(--buy);font-weight:600}.sell{color:var(--sell);font-weight:600}
section{margin-top:28px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 10px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.kv .k{font-size:12px;color:var(--muted)}.kv .v{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}
.kv .v small{font-size:12px;color:var(--muted);font-weight:400}
.bar{height:8px;background:var(--line);border-radius:999px;overflow:hidden;margin-top:8px}
.bar span{display:block;height:100%;background:var(--accent)}
.bar.warn span{background:var(--sell)}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:13.5px;min-width:560px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap;text-align:left}
th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600}
th.num{text-align:right}
tr:last-child td{border-bottom:0}
.rules td:first-child{color:var(--muted)}
footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted)}
footer p{margin:6px 0}
.list a.row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line);color:var(--fg)}
.list a.row:last-child{border-bottom:0}
.list .name{font-weight:600}.list .meta{font-size:12.5px;color:var(--muted);text-align:right}
.status{font-size:11px;text-transform:uppercase;letter-spacing:.05em}
.status.active{color:var(--buy)}.status.paused{color:var(--muted)}
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

/** Full public page for one project. */
export function renderProjectPage(v: ProjectView): string {
  const capUsed = Math.min(100, Math.max(0, v.today.capUsedPct));
  const vol = v.volumeByReason30d;
  const cov = v.coverage;

  const header = `<header>
<h1>${esc(v.name)}${badgePill(v.tier, v.reasons)}${v.mode === "paper" ? ` <span class="tag">paper</span>` : ""}</h1>
<div class="ids">
<div>Mint <a class="mono" href="${SOLSCAN}/token/${esc(v.mint)}" target="_blank" rel="noopener">${esc(v.mint)}</a></div>
<div>Wallet <a class="mono" href="${SOLSCAN}/account/${esc(v.wallet)}" target="_blank" rel="noopener">${esc(v.wallet)}</a></div>
<div>As of ${esc(fmtTs(v.asOf))}${v.lastSnapshotTs !== null ? ` · last snapshot ${esc(fmtTs(v.lastSnapshotTs))}` : " · no snapshot yet"}</div>
</div>
<p class="statement">${esc(v.badgeStatement)}</p>
<ul class="why">${v.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
</header>`;

  const rules = `<section>
<h2>Rules</h2>
<div class="panel scroll"><table class="rules">
<tr><td>Daily sell cap</td><td class="num">${esc(fmtPct(v.rules.dailySellCapPct))} of vault tokens per rolling 24h</td></tr>
<tr><td>Withdrawal delay</td><td class="num">${esc(v.rules.withdrawalDelayHours)} h</td></tr>
<tr><td>Defense budget</td><td class="num">${esc(fmtSol(v.rules.defenseBudgetSol))} SOL lifetime</td></tr>
<tr><td>Max defense per day</td><td class="num">${esc(fmtSol(v.rules.maxDefenseSpendPerDaySol))} SOL</td></tr>
<tr><td>Defense budget left</td><td class="num">${esc(fmtSol(v.today.defenseBudgetLeftSol))} SOL · ${esc(fmtSol(v.today.defenseSpentSol))} spent today</td></tr>
</table></div>
</section>`;

  const today = `<section>
<h2>Today</h2>
<div class="grid">
<div class="panel kv">
<div class="k">Sell cap used</div>
<div class="v">${esc(fmtPct(v.today.capUsedPct))} <small>${esc(fmtTokens(v.today.soldTokens))} / ${esc(fmtTokens(v.today.capTokens))} tokens</small></div>
<div class="bar${capUsed >= 90 ? " warn" : ""}"><span style="width:${capUsed.toFixed(1)}%"></span></div>
</div>
</div>
</section>`;

  const supply = `<section>
<h2>Supply coverage</h2>
${
  cov === null
    ? `<div class="panel"><p class="muted" style="margin:0">No coverage check yet. The first check reads the mint, the pool, the declared and linked wallets and their balances.</p></div>`
    : `<div class="grid">
<div class="panel kv"><div class="k">Vault share of supply</div><div class="v">${esc(fmtPct(cov.vaultPct))}</div></div>
<div class="panel kv"><div class="k">Insiders outside vault and locks</div><div class="v">${esc(fmtPct(cov.insiderOutsidePct))}</div></div>
<div class="panel kv"><div class="k">Mint authority revoked</div><div class="v">${flag(cov.mintAuthorityRevoked)}</div></div>
<div class="panel kv"><div class="k">Freeze authority revoked</div><div class="v">${flag(cov.freezeAuthorityRevoked)}</div></div>
<div class="panel kv"><div class="k">LP secured</div><div class="v">${flag(cov.lpSecured)}</div></div>
<div class="panel kv"><div class="k">Dangerous extensions</div><div class="v">${cov.dangerousExtensions.length === 0 ? `<span class="ok">none</span>` : esc(cov.dangerousExtensions.join(", "))}</div></div>
</div>
<div class="panel scroll" style="margin-top:12px">
<p class="note">Insider wallets: declared by the founder at onboarding, linked by following their funding, or sitting in a public locker. Checked ${esc(fmtTs(cov.ts))}.</p>
${
  cov.insiderWallets.length === 0
    ? `<p class="muted" style="margin:0">No insider wallet declared or linked.</p>`
    : `<table>
<thead><tr><th>Wallet</th><th>Kind</th><th class="num">% of supply</th></tr></thead>
<tbody>
${cov.insiderWallets.map(insiderRow).join("\n")}
</tbody></table>`
}
</div>`
}
</section>`;

  const insiderSells = `<section>
<h2>Insider sells <span class="muted">(last ${v.insiderSells.length}, ${esc(v.insiderSellCount30d)} in 30 days)</span></h2>
<div class="panel scroll">
${
  v.insiderSells.length === 0
    ? `<p class="muted" style="margin:0">No insider sell since onboarding.</p>`
    : `<table>
<thead><tr><th>Time</th><th>Wallet</th><th class="num">Tokens</th><th class="num">% of supply</th><th>Tx</th></tr></thead>
<tbody>
${v.insiderSells.map(sellRow).join("\n")}
</tbody></table>`
}
</div>
</section>`;

  const f = v.fees;
  const fees = `<section>
<h2>Fees</h2>
<div class="panel scroll">
<p class="note">Tenfold charges ${esc(f.terms.volumeBps)} bps on the SOL leg of every vault trade and ${esc(f.terms.cashoutBps)} bps on withdrawals${
    f.terms.referred ? `; this project was referred: ${esc(f.terms.discountBps)} bps of the fee is discounted and ${esc(f.terms.referralBps)} bps of the rest goes to the referrer` : ""
  }. Fees accrue in the ledger and are swept to the Tenfold fee wallet.</p>
<table class="rules">
<tr><td>Gross fees</td><td class="num">${esc(fmtSol(f.grossSol))} SOL</td></tr>
<tr><td>Referral discount</td><td class="num">${esc(fmtSol(f.discountSol))} SOL</td></tr>
<tr><td>Referral paid</td><td class="num">${esc(fmtSol(f.referralSol))} SOL</td></tr>
<tr><td>Net to Tenfold</td><td class="num">${esc(fmtSol(f.netSol))} SOL</td></tr>
<tr><td>Swept</td><td class="num">${esc(fmtSol(f.sweptSol))} SOL</td></tr>
<tr><td>Accrued, not yet swept</td><td class="num">${esc(fmtSol(f.accruedSol))} SOL</td></tr>
</table>
</div>
</section>`;

  const anchors = `<section>
<h2>Daily log anchors</h2>
<div class="panel scroll">
<p class="note">The SHA-256 hash of each day's trade log is posted on-chain in a memo transaction, so nobody, Tenfold included, can edit the record after the fact.</p>
${
  v.anchors.length === 0
    ? `<p class="muted" style="margin:0">No anchor yet.</p>`
    : `<table>
<thead><tr><th>Day</th><th class="num">Entries</th><th>SHA-256</th><th>Memo tx</th></tr></thead>
<tbody>
${v.anchors.map(anchorRow).join("\n")}
</tbody></table>`
}
</div>
</section>`;

  const vault = `<section>
<h2>Vault</h2>
<div class="grid">
<div class="panel kv"><div class="k">Tokens</div><div class="v">${esc(fmtTokens(v.vault.tokens))}</div></div>
<div class="panel kv"><div class="k">SOL</div><div class="v">${esc(fmtSol(v.vault.sol))}</div></div>
<div class="panel kv"><div class="k">Price</div><div class="v mono">${esc(fmtPrice(v.vault.price))} <small>SOL</small></div></div>
<div class="panel kv"><div class="k">Value</div><div class="v">${esc(fmtSol(v.vault.valueSol))} <small>SOL</small></div></div>
</div>
</section>`;

  const activity = `<section>
<h2>Last 30 days</h2>
<div class="grid">
<div class="panel kv"><div class="k">Volume by reason (SOL)</div>
<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:8px">
${(["DEF", "DIST", "REB", "LP", "MANUAL"] as const).map((r) => `<span>${reasonPill(r)} <span class="mono">${esc(fmtSol(vol[r]))}</span></span>`).join("\n")}
</div></div>
<div class="panel kv"><div class="k">Vault share of volume <span class="tag">${esc(v.vaultShareOfVolume30d.label)}</span></div><div class="v">${esc(fmtPct(v.vaultShareOfVolume30d.pct))}</div></div>
<div class="panel kv"><div class="k">Sell proceeds</div><div class="v">${esc(fmtSol(v.pnl.proceedsSol30d))} <small>SOL</small></div></div>
<div class="panel kv"><div class="k">Defense spent</div><div class="v">${esc(fmtSol(v.pnl.defenseSpentSol30d))} <small>SOL</small></div></div>
<div class="panel kv"><div class="k">Fees</div><div class="v">${esc(fmtSol(v.pnl.feesSol30d))} <small>SOL</small></div></div>
<div class="panel kv"><div class="k">Distribution vs token VWAP (24h)</div><div class="v">${v.pnl.distributionVsTokenBps === null ? "-" : esc(`${v.pnl.distributionVsTokenBps > 0 ? "+" : ""}${v.pnl.distributionVsTokenBps} bps`)}</div></div>
</div>
</section>`;

  const trades = `<section>
<h2>Trades <span class="muted">(last ${v.trades.length})</span></h2>
<div class="panel scroll">
${
  v.trades.length === 0
    ? `<p class="muted" style="margin:0">No fills yet.</p>`
    : `<table>
<thead><tr><th>Time</th><th>Side</th><th>Reason</th><th class="num">Tokens</th><th class="num">SOL</th><th class="num">Price</th><th>Tx</th></tr></thead>
<tbody>
${v.trades.map(tradeRow).join("\n")}
</tbody></table>`
}
</div>
</section>`;

  const deposits = `<section>
<h2>Deposits</h2>
<div class="panel scroll">
${
  v.deposits.length === 0
    ? `<p class="muted" style="margin:0">No deposits recorded.</p>`
    : `<table>
<thead><tr><th>Time</th><th>Kind</th><th class="num">Amount</th><th>Tx</th><th>Note</th></tr></thead>
<tbody>
${v.deposits
  .map(
    (dep) => `<tr>
<td class="mono">${esc(fmtTs(dep.ts))}</td>
<td>${esc(dep.kind === "sol" ? "SOL" : "tokens")}</td>
<td class="num">${esc(dep.kind === "sol" ? fmtSol(dep.amount) : fmtTokens(dep.amount))}</td>
<td>${txCell(dep.txSig)}</td>
<td class="muted">${esc(dep.note ?? "")}</td>
</tr>`,
  )
  .join("\n")}
</tbody></table>`
}
</div>
</section>`;

  const footer = `<footer>
<p>All figures read from the chain and the ledger. Strategy, levels and sizes are never shown.</p>
<p>JSON: <a href="/api/project/${esc(v.id)}">/api/project/${esc(v.id)}</a> · Signed summary: <a href="/verify/${esc(v.mint)}">/verify/${esc(short(v.mint, 6))}</a> · <a href="/">All projects</a></p>
</footer>`;

  return layout(`${v.name} · Tenfold proof`, header + rules + today + vault + supply + insiderSells + activity + trades + deposits + fees + anchors + footer);
}

/** Index page: every project managed by this Tenfold instance. */
export function renderIndex(rows: TrackRecordEntry[]): string {
  const list =
    rows.length === 0
      ? `<p class="muted">No projects yet.</p>`
      : `<div class="panel list">
${rows
  .map(
    (r) => `<a class="row" href="/p/${esc(r.id)}">
<span><span class="name">${esc(r.name)}</span>${badgePill(r.tier)}<br><span class="status ${esc(r.status)}">${esc(r.status)}</span> <span class="muted" style="font-size:12px">since ${esc(fmtTs(r.since).slice(0, 10))}</span></span>
<span class="meta">${esc(r.trades30d)} trades / 30d<br>${esc(fmtSol(r.vaultSol))} SOL in vault</span>
</a>`,
  )
  .join("\n")}
</div>`;
  const body = `<header><h1>Tenfold proof</h1><div class="ids"><div>Every project managed by Tenfold, with its rules, vault and every trade.</div></div></header>
<section><h2>Projects</h2>${list}</section>
<footer><p>All figures read from the chain and the ledger. Strategy, levels and sizes are never shown.</p><p>JSON: <a href="/api/projects">/api/projects</a></p></footer>`;
  return layout("Tenfold proof", body);
}
