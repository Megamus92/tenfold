/**
 * Alerts: Tenfold speaks first. Polls the ledger for events the engine wrote, turns each into one short human
 * line and sends it to the chat bound to the project, at most one message per second per chat.
 */
import { baseToTokens, defenseCostPerHourSol, lamportsToSol, logger } from "@tenfold/core";
import type { EngineEvent, Ledger, ProjectConfig } from "@tenfold/core";
import { formatDailyReport } from "./actions.js";
import { fmtHours, fmtPct, fmtPrice, fmtSol, fmtTokens } from "./format.js";

export const POLL_INTERVAL_MS = 5_000;
export const MIN_GAP_PER_CHAT_MS = 1_000;
/** Fills below this (in SOL) are left to the daily report instead of pinging the founder. */
export const FILL_ALERT_MIN_SOL = 0.5;
const MAX_SEND_ATTEMPTS = 3;

type Data = Record<string, unknown>;

function n(d: Data, k: string): number | undefined {
  const v = d[k];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
function big(d: Data, k: string): bigint | undefined {
  const v = d[k];
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
    if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  } catch {
    return undefined;
  }
  return undefined;
}
function s(d: Data, k: string): string | undefined {
  const v = d[k];
  return typeof v === "string" && v.trim() ? v : undefined;
}

type LedgerReads = Pick<Ledger, "latestSnapshot" | "rollingState" | "dailyReport">;

/** Fill SOL size: SOL in for buys, SOL out for sells. */
function fillSol(d: Data): number | undefined {
  const side = s(d, "side");
  const lamports = side === "buy" ? big(d, "inAmount") : big(d, "outAmount");
  if (lamports !== undefined) return lamportsToSol(lamports);
  return n(d, "amountSol") ?? n(d, "sol");
}
function fillTokens(d: Data, decimals: number): number | undefined {
  const side = s(d, "side");
  const base = side === "buy" ? big(d, "outAmount") : big(d, "inAmount");
  if (base !== undefined) return baseToTokens(base, decimals);
  return n(d, "amountTokens") ?? n(d, "tokens");
}

/**
 * One human line for an engine event, or undefined when the founder should not be pinged for it
 * (small automatic fills, proposals, config echoes). Pure apart from ledger reads.
 */
export function formatEvent(ev: EngineEvent, cfg: ProjectConfig, ledger: LedgerReads): string | undefined {
  const d: Data = ev.data ?? {};
  switch (ev.type) {
    case "sell_pressure": {
      const snap = ledger.latestSnapshot(cfg.id);
      const price = n(d, "price") ?? snap?.price;
      const levels = cfg.strategy.defense.levels;
      const level =
        n(d, "level") ??
        (price !== undefined ? levels.filter((l) => l.price <= price).sort((a, b) => b.price - a.price)[0]?.price : undefined) ??
        levels[0]?.price;
      const costPerHour = n(d, "costPerHourSol") ?? (snap ? defenseCostPerHourSol(snap) : undefined);
      let hours = n(d, "hoursLeft");
      if (hours === undefined && costPerHour !== undefined) {
        const lvl = levels.find((l) => l.price === level);
        const rolling = ledger.rollingState(cfg.id, ev.ts);
        const remaining = Math.max(0, cfg.rules.defenseBudgetSol - lamportsToSol(rolling.defenseSpentTotalLamports));
        const budget = lvl ? Math.min(lvl.budgetSol, remaining) : remaining;
        hours = costPerHour > 0 ? budget / costPerHour : Infinity;
      }
      if (level === undefined) {
        return `Heavy sell pressure at ${fmtPrice(price)} (sells ${fmtSol(n(d, "sellFlow5mSol") ?? snap?.sellFlow5mSol)} vs buys ${fmtSol(n(d, "buyFlow5mSol") ?? snap?.buyFlow5mSol)} SOL over 5 min). No defense level is set. Want one, or let it breathe?`;
      }
      return `Heavy sell pressure at ${fmtPrice(price)}, holding ${fmtPrice(level)} costs ~${fmtSol(costPerHour)} SOL/hour, budget lasts ~${fmtHours(hours)} h. Hold, lower the level, or let it breathe?`;
    }
    case "level_hit": {
      const level = n(d, "level") ?? n(d, "price");
      const spent = n(d, "spentSol") ?? fillSol(d);
      const left = n(d, "levelBudgetLeftSol") ?? n(d, "budgetLeftSol");
      return (
        `Level ${fmtPrice(level)} hit${n(d, "price") !== undefined && n(d, "level") !== undefined ? ` at ${fmtPrice(n(d, "price"))}` : ""}: defending with real buys` +
        (spent !== undefined ? `, ${fmtSol(spent)} SOL spent` : "") +
        (left !== undefined ? `, ${fmtSol(left)} SOL left on this level` : "") +
        "."
      );
    }
    case "budget_low": {
      const left = n(d, "remainingSol") ?? n(d, "leftSol");
      const total = n(d, "budgetSol") ?? cfg.rules.defenseBudgetSol;
      const pct = left !== undefined && total ? (left / total) * 100 : undefined;
      return `Defense budget low: ${fmtSol(left)} SOL left${pct !== undefined ? ` (${fmtPct(pct)} of ${fmtSol(total)} SOL)` : ""}. Levels stop when it reaches 0. Raise the budget, lower the levels, or let it breathe?`;
    }
    case "cap_reached": {
      const pct = n(d, "pct") ?? cfg.rules.dailySellCapPct;
      const sold = big(d, "soldTokens");
      return `Daily sell cap reached: ${fmtPct(pct)} of the vault${sold !== undefined ? ` (${fmtTokens(baseToTokens(sold, cfg.decimals))} tokens)` : ""} sold in the last 24h. Distribution waits until the window rolls over. Raising the cap takes 48h if you want more.`;
    }
    case "circuit_breaker": {
      const move = n(d, "movePct");
      const from = n(d, "from") ?? n(d, "price5mAgo");
      const to = n(d, "to") ?? n(d, "price");
      return `Circuit breaker: price moved ${move !== undefined ? fmtPct(Math.abs(move)) : "more than " + fmtPct(cfg.rules.circuitBreakerMovePct)} in 5 minutes${from !== undefined && to !== undefined ? ` (${fmtPrice(from)} -> ${fmtPrice(to)})` : ""}. All orders are on hold until you say "resume" and confirm. Nothing is spent meanwhile.`;
    }
    case "order_filled": {
      const reason = s(d, "reason");
      const sol = fillSol(d);
      if ((reason !== "MANUAL" && reason !== "DEF") || sol === undefined || sol <= FILL_ALERT_MIN_SOL) return undefined;
      const side = s(d, "side") ?? "trade";
      const tokens = fillTokens(d, cfg.decimals);
      const price = n(d, "price");
      const tx = s(d, "txSig");
      return `${reason === "DEF" ? "Defense" : "Manual"} ${side} filled: ${fmtTokens(tokens)} tokens for ${fmtSol(sol)} SOL @ ${fmtPrice(price)}${d["paper"] === true ? " (paper)" : ""}${tx ? ` tx ${tx.slice(0, 8)}...` : ""}.`;
    }
    case "order_rejected": {
      const code = s(d, "code") ?? s(d, "reasonCode");
      const why = s(d, "reason") ?? s(d, "message") ?? "no reason given";
      const side = s(d, "side");
      const tag = s(d, "orderReason") ?? (s(d, "reason") && /^(DEF|DIST|REB|LP|MANUAL)$/.test(s(d, "reason") ?? "") ? s(d, "reason") : undefined);
      return `Order rejected${side ? ` (${tag ? tag + " " : ""}${side})` : ""}${code ? ` [${code}]` : ""}: ${why}`;
    }
    case "order_failed": {
      const side = s(d, "side");
      const err = s(d, "error") ?? s(d, "reason") ?? "unknown error";
      // The engine attaches txSig only when the transaction was sent and its result could not be established.
      if (s(d, "txSig")) {
        return `Order unconfirmed${side ? ` (${side})` : ""}: ${err}. It may have filled; it stays counted against the cap and the budget for 24h.`;
      }
      return `Order failed${side ? ` (${side})` : ""}: ${err}. Nothing was spent beyond network fees; Tenfold will retry on the next signal.`;
    }
    case "paused": {
      const by = s(d, "by") ?? s(d, "reason");
      return `Paused${by ? ` (${by})` : ""}. No new orders until resumed.`;
    }
    case "resumed":
      return "Resumed. Defense, distribution and rebalancing are live again.";
    case "daily_report":
      return formatDailyReport(ledger.dailyReport(cfg.id, ev.ts), cfg);
    case "badge_changed": {
      const from = s(d, "from");
      const to = s(d, "to");
      const reasons = Array.isArray(d["reasons"]) ? (d["reasons"] as unknown[]).filter((r): r is string => typeof r === "string") : [];
      const rank: Record<string, number> = { gold: 3, managed: 2, beta: 1, flagged: 0 };
      const dir = from && to && rank[to] !== undefined && rank[from] !== undefined ? (rank[to]! > rank[from]! ? " (up)" : " (down)") : "";
      const marketing = from && cfg.marketing?.mode && cfg.marketing.mode !== "off" ? (cfg.marketing.mode === "auto" ? " The change is posted publicly (auto mode)." : " A public post about it is drafted for your approval.") : "";
      // The first coverage check has no previous tier: that is the badge being assigned, not a change.
      const head = from ? `Badge ${from} -> ${to ?? "?"}${dir}.` : `Badge assigned: ${to ?? "?"}.`;
      return `${head}${reasons.length ? ` Why: ${reasons.join("; ")}.` : ""} Details are in your feed.${marketing}`;
    }
    case "insider_sell": {
      const wallet = s(d, "wallet");
      const pct = n(d, "pctOfSupply");
      const amount = big(d, "amount");
      const tx = s(d, "txSig");
      return (
        `Insider sell: ${wallet ? wallet.slice(0, 4) + "..." + wallet.slice(-4) : "a declared wallet"} sold` +
        (amount !== undefined ? ` ${fmtTokens(baseToTokens(amount, cfg.decimals))} tokens` : "") +
        (pct !== undefined ? ` (${fmtPct(pct)} of supply)` : "") +
        (tx ? `, tx ${tx.slice(0, 8)}...` : "") +
        ". It counts against the badge; moving insider supply into the vault or a public lock restores it."
      );
    }
    case "fees_swept": {
      const net = n(d, "netSol");
      const ref = n(d, "referralSol");
      const tx = s(d, "txSig");
      return `Tenfold fees swept: ${fmtSol(net)} SOL${ref ? `, ${fmtSol(ref)} SOL to your referrer` : ""}${d["paper"] === true ? " (paper)" : ""}${tx ? `, tx ${tx.slice(0, 8)}...` : ""}.`;
    }
    case "anchor_posted": {
      const day = s(d, "day");
      const hash = s(d, "hash");
      const entries = n(d, "entries");
      const tx = s(d, "txSig");
      const where = tx && !tx.startsWith("(") ? `, tx ${tx.slice(0, 8)}...` : tx ? ` ${tx}` : " (not on-chain yet)";
      return `Daily log${day ? ` ${day}` : ""} anchored: ${entries !== undefined ? `${entries} fills, ` : ""}sha256 ${hash ? hash.slice(0, 12) + "..." : "n/a"}${where}.`;
    }
    case "lp_rebalanced": {
      const lower = n(d, "lower");
      const upper = n(d, "upper");
      const tokens = big(d, "tokens");
      const sol = big(d, "sol") ?? big(d, "lamports");
      return (
        `LP position rebalanced to ${fmtPrice(lower)} - ${fmtPrice(upper)}` +
        (tokens !== undefined || sol !== undefined
          ? `: ${tokens !== undefined ? fmtTokens(baseToTokens(tokens, cfg.decimals)) + " tokens" : ""}${tokens !== undefined && sol !== undefined ? " + " : ""}${sol !== undefined ? fmtSol(lamportsToSol(sol)) + " SOL" : ""}`
          : "") +
        "."
      );
    }
    case "post_drafted": {
      // Auto mode: the post is already approved and post_published follows; no need to ping twice.
      if (d["auto"] === true) return undefined;
      const text = s(d, "text");
      if (!text) return undefined;
      const channel = s(d, "channel") === "x" ? "X" : "Telegram";
      const kind = (s(d, "kind") ?? "post").replace(/_/g, " ");
      const id = s(d, "postId");
      return `Draft for ${channel} (${kind})${id ? `, id ${id.slice(0, 8)}` : ""}:\n\n${text}\n\nApprove or reject below. Unapproved drafts expire after 24h.`;
    }
    case "post_published": {
      const channel = s(d, "channel") === "x" ? "X" : "Telegram";
      const kind = (s(d, "kind") ?? "post").replace(/_/g, " ");
      const url = s(d, "url");
      const ext = s(d, "externalId");
      return `Posted on ${channel} (${kind})${url ? `: ${url}` : ext ? `, id ${ext}` : ""}.`;
    }
    case "desk_decision": {
      const why = s(d, "why") ?? "";
      const kind = s(d, "kind");
      // The desk already wrote the sentence; prefix it so the founder knows who acted and that nothing is asked of him.
      if (kind === "mandate_started") return undefined; // bookkeeping, the status shows it
      return `Desk: ${why}`;
    }
    case "desk_proposal": {
      const why = s(d, "why") ?? "";
      return `Desk proposal (nothing changed, you chose to be asked): ${why}\nSay "do it" to apply, or tell me what you want instead.`;
    }
    case "desk_escalation": {
      const why = s(d, "why") ?? "";
      const options = Array.isArray(d["options"]) ? (d["options"] as unknown[]).filter((o): o is string => typeof o === "string") : [];
      const topic = s(d, "topic");
      const head =
        topic === "liquidity_pull"
          ? "I need you on this one."
          : topic === "budget_top_up" || topic === "no_sol" || topic === "unfunded"
            ? "Your call:"
            : topic === "target_reached"
              ? "Done:"
              : "Heads up:";
      return `${head} ${why}${options.length ? ` Options: ${options.join(" / ")}.` : ""}`;
    }
    case "weekly_report": {
      const r = ledger.dailyReport(cfg.id, ev.ts); // shape only; the real numbers come in the event data
      const week = { ...r, ...weekFromEvent(d, r) };
      return formatDailyReport(week, cfg).replace(/^.*?: 24h report/, `${cfg.name}: 7-day report`);
    }
    case "order_proposed":
    case "config_changed":
      return undefined;
    default:
      return undefined;
  }
}

/** The weekly event carries a period report serialised with bigints as strings; coerce the fields the formatter reads. */
function weekFromEvent(d: Data, fallback: ReturnType<LedgerReads["dailyReport"]>): Partial<ReturnType<LedgerReads["dailyReport"]>> {
  const out: Record<string, unknown> = {};
  for (const k of ["soldTokens", "soldProceedsLamports", "boughtTokens", "boughtCostLamports", "defenseLamports", "feesLamports", "vaultTokens", "vaultLamports"] as const) {
    const v = big(d, k);
    if (v !== undefined) out[k] = v;
  }
  for (const k of ["from", "to", "fills", "priceOpen", "priceClose", "tokenVwap", "distributionVwap", "distributionVsTokenBps"] as const) {
    const v = n(d, k);
    if (v !== undefined) out[k] = v;
  }
  if (d["byReason"] && typeof d["byReason"] === "object") out.byReason = d["byReason"];
  return { ...fallback, ...out } as Partial<ReturnType<LedgerReads["dailyReport"]>>;
}

export interface AlertPollerOptions {
  ledger: Ledger;
  /** Current project configs (with telegram bindings). */
  projects: () => ProjectConfig[];
  send: (chatId: string, text: string) => Promise<void>;
  /**
   * Optional: send with the event in hand, for messages that need more than text (the marketing module attaches
   * Approve/Reject buttons to post_drafted). Falls back to `send` when absent.
   */
  sendEvent?: (chatId: string, text: string, ev: EngineEvent & { id: number }) => Promise<void>;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Polls undelivered events, formats, sends with a per-chat rate limit, marks delivered. */
export class AlertPoller {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly lastSentAt = new Map<string, number>();
  private readonly attempts = new Map<number, number>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: AlertPollerOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  start(): void {
    if (this.timer) return;
    const interval = this.opts.intervalMs ?? POLL_INTERVAL_MS;
    const loop = async (): Promise<void> => {
      try {
        await this.tick();
      } catch (e) {
        logger.error("alert poll failed", { error: (e as Error).message });
      }
      if (this.timer) this.timer = setTimeout(loop, interval);
    };
    this.timer = setTimeout(loop, 0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Process one batch of undelivered events; returns how many messages were sent. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const events = this.opts.ledger.undeliveredEvents(100);
      if (events.length === 0) return 0;
      const byId = new Map(this.opts.projects().map((p) => [p.id, p] as const));
      const delivered: number[] = [];
      let sent = 0;
      for (const ev of events) {
        const cfg = byId.get(ev.projectId);
        const chatId = cfg?.telegram?.chatId;
        if (!cfg || !chatId) {
          delivered.push(ev.id);
          continue;
        }
        let text: string | undefined;
        try {
          text = formatEvent(ev, cfg, this.opts.ledger);
        } catch (e) {
          logger.error("alert format failed", { id: ev.id, type: ev.type, error: (e as Error).message });
          delivered.push(ev.id);
          continue;
        }
        if (!text) {
          delivered.push(ev.id);
          continue;
        }
        const wait = (this.lastSentAt.get(chatId) ?? 0) + MIN_GAP_PER_CHAT_MS - this.now();
        if (wait > 0) await this.sleep(wait);
        try {
          if (this.opts.sendEvent) await this.opts.sendEvent(chatId, text, ev);
          else await this.opts.send(chatId, text);
          this.lastSentAt.set(chatId, this.now());
          delivered.push(ev.id);
          this.attempts.delete(ev.id);
          sent++;
        } catch (e) {
          const tries = (this.attempts.get(ev.id) ?? 0) + 1;
          this.attempts.set(ev.id, tries);
          logger.warn("alert send failed", { id: ev.id, type: ev.type, chatId, tries, error: (e as Error).message });
          if (tries >= MAX_SEND_ATTEMPTS) {
            delivered.push(ev.id);
            this.attempts.delete(ev.id);
          }
        }
      }
      this.opts.ledger.markDelivered(delivered);
      return sent;
    } finally {
      this.running = false;
    }
  }
}
