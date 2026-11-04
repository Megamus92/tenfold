/**
 * Drafts: pure functions that turn ledger facts into post texts. Nothing here reads the ledger, the chain or the
 * clock; every number comes in as an argument, so a post can only ever say what the data says.
 *
 * Each draft has an X variant (at most X_MAX_CHARS characters, built from ranked segments so the link always
 * survives) and a longer Telegram variant. The founder's `tone` moves the register (casual / formal) of the lead
 * words and never the facts: the same input gives the same numbers whatever the tone.
 */
import type { BadgeTier, ProjectConfig } from "@tenfold/core";
import type { Anchor, Coverage, DailyReport } from "@tenfold/core";
import { baseToTokens, lamportsToSol } from "@tenfold/core";
import { fmtChange, fmtDuration, fmtInt, fmtPct, fmtPrice, fmtSol, fmtTime, fmtTokens, short } from "./format.js";

export type PostKind = "daily_recap" | "milestone" | "level_defended" | "withdrawal_notice" | "badge_change";

export interface Draft {
  kind: PostKind;
  /** Stable key for dedupe within a project, e.g. "daily_recap:2026-10-31" or "milestone:volume:1000". */
  key: string;
  /** At most X_MAX_CHARS characters. */
  x: string;
  /** Multi-line variant for Telegram channels. */
  telegram: string;
}

export interface DraftContext {
  cfg: ProjectConfig;
  /** TENFOLD_PROOF_BASE_URL; the proof page is `${proofBaseUrl}/p/${cfg.id}`. */
  proofBaseUrl: string;
}

export const X_MAX_CHARS = 260;

export type Register = "neutral" | "casual" | "formal";

/** Map the founder's free-text tone to a register. Unknown words leave the neutral register. */
export function registerOf(tone: string | undefined): Register {
  if (!tone) return "neutral";
  const t = tone.toLowerCase();
  if (/\b(casual|relaxed|friendly|chill|informal|light|playful|fun)\b/.test(t)) return "casual";
  if (/\b(formal|professional|corporate|institutional|serious|sober|neutral|dry)\b/.test(t)) return "formal";
  return "neutral";
}

/**
 * Words a Tenfold post never contains. Checked on every draft in tests and again by the scheduler before a post is
 * written, with the project name and handle masked so a token called "Moon" is not blocked for its own name.
 */
export const BANNED_WORDS: readonly string[] = [
  "moon",
  "mooning",
  "to the moon",
  "massive",
  "insane",
  "huge",
  "gem",
  "100x",
  "10x",
  "guaranteed",
  "buy now",
  "don't miss",
  "dont miss",
  "last chance",
  "ape in",
  "lambo",
  "rocket",
  "explode",
  "parabolic",
  "bullish",
  "bearish",
  "send it",
  "fomo",
  "wagmi",
  "ngmi",
  "pump",
  "undervalued",
  "next big",
  "will hit",
  "target",
  "easy money",
];

/** Banned words present in `text`, after masking the strings in `ignore` (project name, handle). */
export function hypeWords(text: string, ignore: readonly string[] = []): string[] {
  let t = text.toLowerCase();
  for (const word of ignore) if (word) t = t.split(word.toLowerCase()).join(" ");
  const found: string[] = [];
  for (const w of BANNED_WORDS) {
    const re = new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
    if (re.test(t)) found.push(w);
  }
  return found;
}

// ---------- building blocks ----------

interface Segment {
  text: string;
  /** 0 = never dropped; higher numbers are dropped first when the X variant is too long. */
  priority: number;
}

/** Join segments, dropping the lowest-priority ones until the text fits in `max` characters. */
export function compose(segments: Segment[], max = X_MAX_CHARS, joiner = " "): string {
  const kept = segments.filter((s) => s.text.trim() !== "");
  const render = (list: Segment[]) => list.map((s) => s.text.trim()).join(joiner);
  let text = render(kept);
  while (text.length > max) {
    let worst = -1;
    for (let i = 0; i < kept.length; i++) {
      if (kept[i]!.priority > 0 && (worst < 0 || kept[i]!.priority > kept[worst]!.priority)) worst = i;
    }
    if (worst < 0) break;
    kept.splice(worst, 1);
    text = render(kept);
  }
  if (text.length > max) {
    // Only mandatory segments are left and they still overflow: cut the first one at a word boundary, keep the rest.
    const rest = render(kept.slice(1));
    const room = max - rest.length - joiner.length;
    const head = kept[0]!.text.trim();
    const cut = head.lastIndexOf(" ", Math.max(0, room));
    text = `${head.slice(0, cut > 0 ? cut : room).trimEnd()}${joiner}${rest}`;
  }
  return text;
}

function proofLink(ctx: DraftContext): string {
  return `${ctx.proofBaseUrl.replace(/\/+$/, "")}/p/${ctx.cfg.id}`;
}

function handle(ctx: DraftContext): string | undefined {
  const h = ctx.cfg.marketing?.xHandle?.replace(/^@/, "");
  return h ? `@${h}` : undefined;
}

/** "Name (@handle)" or just "Name". */
function who(ctx: DraftContext): string {
  const h = handle(ctx);
  return h ? `${ctx.cfg.name} (${h})` : ctx.cfg.name;
}

function reg(ctx: DraftContext): Register {
  return registerOf(ctx.cfg.marketing?.tone);
}

const REASON_WORDS: Record<string, string> = {
  DEF: "defense buys",
  DIST: "distribution sells",
  REB: "rebalancing",
  LP: "liquidity",
  MANUAL: "founder orders",
};

const TIER_RANK: Record<BadgeTier, number> = { gold: 3, managed: 2, beta: 1, flagged: 0 };

// ---------- daily recap ----------

export interface RecapExtras {
  /** SOL traded per reason code over the report window (buy: SOL in, sell: SOL out), from the fills. */
  volumeByReasonSol?: Record<string, number>;
  /** The anchor of the day the report covers, when it exists. */
  anchor?: Anchor;
  /** Fees earned by the project's LP position over the window, in SOL, when the engine reports them. */
  lpFeesSol?: number;
}

/**
 * The last 24 hours in numbers. Returns undefined when the ledger has no price for the window (nothing to say).
 */
export function dailyRecap(report: DailyReport, coverage: Coverage | undefined, ctx: DraftContext, extras: RecapExtras = {}): Draft | undefined {
  if (report.priceOpen === undefined && report.priceClose === undefined && report.fills === 0) return undefined;
  const d = ctx.cfg.decimals;
  const r = reg(ctx);
  const link = proofLink(ctx);
  const day = new Date(report.to).toISOString().slice(0, 10);

  const byReason = extras.volumeByReasonSol ?? fallbackVolumeByReason(report);
  const reasons = Object.entries(byReason)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const totalSol = reasons.reduce((a, [, v]) => a + v, 0);
  const soldTokens = baseToTokens(report.soldTokens, d);

  // Cap used: sold / (cap % of the vault before the day's sells started).
  let capUsedPct: number | undefined;
  if (report.vaultTokens !== undefined && ctx.cfg.rules.dailySellCapPct > 0) {
    const base = baseToTokens(report.vaultTokens, d) + soldTokens;
    const capTokens = (base * ctx.cfg.rules.dailySellCapPct) / 100;
    capUsedPct = capTokens > 0 ? Math.min(100, (soldTokens / capTokens) * 100) : undefined;
  }

  const priceLine =
    report.priceOpen !== undefined && report.priceClose !== undefined
      ? `Price ${fmtPrice(report.priceOpen)} -> ${fmtPrice(report.priceClose)} SOL (${fmtChange(report.priceOpen, report.priceClose) || "0%"})`
      : undefined;
  const volumeX =
    report.fills === 0
      ? "No vault trades"
      : `${fmtInt(report.fills)} fills, ${fmtSol(totalSol)} SOL: ${reasons.map(([k, v]) => `${k} ${fmtSol(v)}`).join(", ")}`;
  const capX = capUsedPct !== undefined ? `Sell cap ${fmtPct(ctx.cfg.rules.dailySellCapPct)} of vault, ${fmtPct(capUsedPct)} used` : undefined;
  const lpX = extras.lpFeesSol !== undefined && extras.lpFeesSol > 0 ? `LP fees earned ${fmtSol(extras.lpFeesSol)} SOL` : undefined;
  const anchorX = extras.anchor ? `Log hash ${short(extras.anchor.hash, 10)}` : undefined;
  const badgeX = coverage ? `Badge: ${coverage.tier}` : undefined;

  const lead =
    r === "casual" ? `${who(ctx)}, ${day} in numbers:` : r === "formal" ? `${who(ctx)}: market making report, ${day}.` : `${who(ctx)} daily recap (${day}):`;

  const x = compose([
    { text: lead, priority: 0 },
    { text: volumeX + ".", priority: 1 },
    { text: priceLine ? priceLine + "." : "", priority: 2 },
    { text: capX ? capX + "." : "", priority: 3 },
    { text: lpX ? lpX + "." : "", priority: 5 },
    { text: badgeX ? badgeX + "." : "", priority: 6 },
    { text: anchorX ? anchorX + "." : "", priority: 4 },
    { text: `Every fill: ${link}`, priority: 0 },
  ]);

  const tgLines: string[] = [lead, ""];
  if (report.fills === 0) tgLines.push("No vault trades in the window.");
  else {
    tgLines.push(`Fills: ${fmtInt(report.fills)}, ${fmtSol(totalSol)} SOL traded`);
    for (const [k, v] of reasons) tgLines.push(`  ${k} (${REASON_WORDS[k] ?? k.toLowerCase()}): ${fmtSol(v)} SOL`);
    if (report.soldTokens > 0n) {
      tgLines.push(
        `Sold: ${fmtTokens(soldTokens)} tokens for ${fmtSol(lamportsToSol(report.soldProceedsLamports))} SOL` +
          (report.distributionVwap !== undefined ? ` at ${fmtPrice(report.distributionVwap)} avg` : ""),
      );
    }
    if (report.boughtTokens > 0n) {
      tgLines.push(`Bought: ${fmtTokens(baseToTokens(report.boughtTokens, d))} tokens for ${fmtSol(lamportsToSol(report.boughtCostLamports))} SOL`);
    }
  }
  if (priceLine) tgLines.push(priceLine);
  if (capX) tgLines.push(capX);
  if (lpX) tgLines.push(lpX);
  if (coverage) tgLines.push(`Badge: ${coverage.tier}` + (coverage.data.insiderOutsidePct !== undefined ? ` (insider supply outside the vault: ${fmtPct(coverage.data.insiderOutsidePct)})` : ""));
  if (extras.anchor) {
    tgLines.push(`Daily log ${extras.anchor.day} anchored: sha256 ${extras.anchor.hash}` + (extras.anchor.txSig ? ` (tx ${short(extras.anchor.txSig)})` : ""));
  }
  tgLines.push("", `Every fill with its reason code: ${link}`);

  return { kind: "daily_recap", key: `daily_recap:${day}`, x, telegram: tgLines.join("\n") };
}

/** When the caller has no per-reason SOL, attribute what the report itself knows. */
function fallbackVolumeByReason(report: DailyReport): Record<string, number> {
  const out: Record<string, number> = {};
  const sold = lamportsToSol(report.soldProceedsLamports);
  const def = lamportsToSol(report.defenseLamports);
  const otherBuys = lamportsToSol(report.boughtCostLamports) - def;
  if (sold > 0) out.DIST = sold;
  if (def > 0) out.DEF = def;
  if (otherBuys > 0) out.REB = otherBuys;
  return out;
}

// ---------- milestones ----------

export type MilestoneKind = "holders" | "volume" | "days";

/**
 * A threshold crossed: holders (count), volume (SOL traded by the vault since onboarding), days (managed).
 * Returns undefined unless `value` is a finite positive number from real data; the function never guesses.
 */
export function milestone(kind: MilestoneKind, value: number, ctx: DraftContext): Draft | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  if ((kind === "holders" || kind === "days") && !Number.isInteger(value)) return undefined;
  const r = reg(ctx);
  const link = proofLink(ctx);
  const w = who(ctx);
  let lead: string;
  let detail: string;
  switch (kind) {
    case "volume":
      lead =
        r === "casual"
          ? `${w} just passed ${fmtSol(value)} SOL of vault trading volume with Tenfold.`
          : r === "formal"
            ? `${w} has passed ${fmtSol(value)} SOL of cumulative vault trading volume under Tenfold management.`
            : `${w} passed ${fmtSol(value)} SOL of vault trading volume with Tenfold.`;
      detail = "Real orders against real counterparties, each with a reason code.";
      break;
    case "holders":
      lead =
        r === "casual"
          ? `${w} is now held by ${fmtInt(value)} wallets.`
          : r === "formal"
            ? `${w} now has ${fmtInt(value)} holders on-chain.`
            : `${w} now has ${fmtInt(value)} holders.`;
      detail = "Counted on-chain.";
      break;
    case "days":
      lead =
        r === "casual"
          ? `Day ${fmtInt(value)} of ${w} with Tenfold.`
          : r === "formal"
            ? `${w}: ${fmtInt(value)} days under Tenfold market making.`
            : `${w}: ${fmtInt(value)} days managed by Tenfold.`;
      detail = "Every order since day 1 is logged.";
      break;
  }
  const x = compose([
    { text: lead, priority: 0 },
    { text: detail, priority: 1 },
    { text: `Proof: ${link}`, priority: 0 },
  ]);
  const telegram = [lead, detail, "", `Proof page: ${link}`].join("\n");
  return { kind: "milestone", key: `milestone:${kind}:${value}`, x, telegram };
}

// ---------- level defended ----------

export interface LevelDefendedEvent {
  /** The level, SOL per token. */
  level: number;
  /** SOL spent on DEF buys while the level was under pressure. */
  spentSol: number;
  /** Number of DEF fills in the episode. */
  fills?: number;
  /** Episode length in minutes. */
  durationMin?: number;
  /** Lowest price seen during the episode. */
  lowPrice?: number;
  /** When the episode ended (unix ms); used for the dedupe key. */
  ts?: number;
}

/** A level held through sell pressure: what it cost, how long it took, where the low was. */
export function levelDefended(ev: LevelDefendedEvent, ctx: DraftContext): Draft | undefined {
  if (!Number.isFinite(ev.level) || ev.level <= 0 || !Number.isFinite(ev.spentSol) || ev.spentSol <= 0) return undefined;
  const r = reg(ctx);
  const link = proofLink(ctx);
  const w = who(ctx);
  const lead =
    r === "casual" ? `${w}: the ${fmtPrice(ev.level)} level held.` : r === "formal" ? `${w}: the ${fmtPrice(ev.level)} SOL level was defended.` : `${w}: the ${fmtPrice(ev.level)} level held.`;
  const spent =
    `Tenfold spent ${fmtSol(ev.spentSol)} SOL in ` +
    (ev.fills !== undefined ? `${fmtInt(ev.fills)} real buys` : "real buys") +
    (ev.durationMin !== undefined ? ` over ${fmtDuration(ev.durationMin)}` : "") +
    ".";
  const low = ev.lowPrice !== undefined ? `Low ${fmtPrice(ev.lowPrice)}.` : "";
  const x = compose([
    { text: lead, priority: 0 },
    { text: spent, priority: 1 },
    { text: low, priority: 2 },
    { text: `Fills: ${link}`, priority: 0 },
  ]);
  const telegram = [lead, spent, low, "", `Every fill with its tx: ${link}`].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
  return { kind: "level_defended", key: `level_defended:${ev.level}:${ev.ts ?? 0}`, x, telegram };
}

// ---------- withdrawal notice ----------

export interface WithdrawalEvent {
  status: "requested" | "settled" | "cancelled";
  amountSol?: number;
  amountTokens?: number;
  /** The vault's withdrawal delay in hours (defaults to the project rule). */
  delayHours?: number;
  /** When the withdrawal settles or settled (unix ms). */
  settlesAt?: number;
  txSig?: string;
  ts?: number;
}

/** Transparency note: a withdrawal was requested, settled or cancelled. Posted whatever the direction. */
export function withdrawalNotice(ev: WithdrawalEvent, ctx: DraftContext): Draft | undefined {
  const parts: string[] = [];
  if (ev.amountSol !== undefined && Number.isFinite(ev.amountSol) && ev.amountSol > 0) parts.push(`${fmtSol(ev.amountSol)} SOL`);
  if (ev.amountTokens !== undefined && Number.isFinite(ev.amountTokens) && ev.amountTokens > 0) parts.push(`${fmtTokens(ev.amountTokens)} tokens`);
  if (parts.length === 0) return undefined;
  const amount = parts.join(" and ");
  const delay = ev.delayHours ?? ctx.cfg.rules.withdrawalDelayHours;
  const r = reg(ctx);
  const link = proofLink(ctx);
  const name = who(ctx);
  const team = `the ${name} team`;
  const prefix = r === "formal" ? "Transparency notice:" : "Transparency:";
  let body: string;
  let when = "";
  switch (ev.status) {
    case "requested":
      body = `${prefix} ${team} requested a withdrawal of ${amount} from the vault.`;
      when = `It settles after the ${delay}h delay` + (ev.settlesAt ? `, at ${fmtTime(ev.settlesAt)}` : "") + ".";
      break;
    case "settled":
      body = `${prefix} a withdrawal of ${amount} from the ${name} vault settled after the ${delay}h delay.`;
      when = ev.txSig ? `tx ${short(ev.txSig)}` : "";
      break;
    case "cancelled":
      body = `${prefix} the pending withdrawal of ${amount} from the ${name} vault was cancelled before the ${delay}h delay ended.`;
      break;
  }
  const x = compose([
    { text: body, priority: 0 },
    { text: when, priority: 1 },
    { text: `Vault history: ${link}`, priority: 0 },
  ]);
  const telegram = [body, when, "", `Vault history and every fill: ${link}`].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
  return { kind: "withdrawal_notice", key: `withdrawal:${ev.status}:${ev.txSig ?? ev.ts ?? 0}`, x, telegram };
}

// ---------- badge change ----------

export interface BadgeChangeEvent {
  from: BadgeTier;
  to: BadgeTier;
  reasons: string[];
  ts?: number;
}

/** Tier up or down, with the reasons. Downgrades are posted too: that is what makes the badge worth anything. */
export function badgeChange(ev: BadgeChangeEvent, ctx: DraftContext): Draft | undefined {
  if (!(ev.from in TIER_RANK) || !(ev.to in TIER_RANK) || ev.from === ev.to) return undefined;
  const up = TIER_RANK[ev.to] > TIER_RANK[ev.from];
  const r = reg(ctx);
  const link = proofLink(ctx);
  const w = who(ctx);
  const lead = r === "formal" ? `${w} badge update: ${ev.from} -> ${ev.to}.` : `${w} badge: ${ev.from} -> ${ev.to}.`;
  const reasons = ev.reasons.map((s) => s.trim().replace(/\.$/, "")).filter(Boolean);
  const note = up ? "" : r === "casual" ? "We post downgrades too." : "Downgrades are posted like upgrades.";
  // On X the first reason outranks the note, later reasons drop first when space runs out.
  const x = compose([
    { text: lead, priority: 0 },
    ...reasons.map((reason, i) => ({ text: `${i === 0 ? "Why: " : ""}${reason}.`, priority: i === 0 ? 1 : i + 2 })),
    { text: note, priority: 2 },
    { text: `Details: ${link}`, priority: 0 },
  ]);
  const tg: string[] = [lead];
  if (reasons.length) {
    tg.push("Why:");
    for (const s of reasons) tg.push(`  - ${s}`);
  }
  if (note) tg.push(note);
  tg.push("", `Badge criteria and the full picture: ${link}`);
  return { kind: "badge_change", key: `badge:${ev.from}:${ev.to}:${ev.ts ?? 0}`, x, telegram: tg.join("\n") };
}

/** True when the change is a downgrade (used to bypass rate limits: a downgrade is never held back). */
export function isDowngrade(ev: { from: BadgeTier; to: BadgeTier }): boolean {
  return (TIER_RANK[ev.to] ?? 0) < (TIER_RANK[ev.from] ?? 0);
}
