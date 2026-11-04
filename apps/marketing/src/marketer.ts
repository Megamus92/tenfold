/**
 * Marketer: the loop that turns ledger events into posts and ships approved posts to their channels.
 *
 * Per project with marketing on:
 *   1. read the events written since the last tick (badge_changed, level_hit, daily_report, withdrawals),
 *   2. close "level under pressure" episodes when price is back above the level and real DEF buys were made,
 *   3. check volume / days / holders thresholds against the ledger (and a chain provider, if one is injected),
 *   4. write each new draft once per channel: as a `draft` (mode approve, the agent asks the founder) or straight
 *      to `approved` (mode auto),
 *   5. publish every `approved` post, record the external id, emit post_published; expire drafts older than 24h.
 *
 * Nothing simulated goes public: paper projects are skipped unless `allowPaper` is set (dry runs, e2e).
 * The cursor and the dedupe keys live in a small JSON file next to the ledger so a restart replays nothing.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { baseToTokens, lamportsToSol, logger } from "@tenfold/core";
import type { BadgeTier, EngineEvent, Ledger, Post, ProjectConfig } from "@tenfold/core";
import type { Channel, ChannelName } from "./channels.js";
import { X_MAX_CHARS, badgeChange, dailyRecap, hypeWords, isDowngrade, levelDefended, milestone, withdrawalNotice } from "./drafts.js";
import type { Draft, DraftContext } from "./drafts.js";
import { dayKey } from "./format.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const POLL_INTERVAL_MS = 15_000;
/** A draft the founder has not approved within this time is stale and is rejected automatically. */
export const DRAFT_TTL_MS = DAY;
export const DEFAULT_MAX_POSTS_PER_DAY = 4;
export const DEFAULT_MIN_GAP_MS = 30 * MINUTE;
/** A level episode that neither recovers nor is lost within this time is dropped without a post. */
export const EPISODE_TIMEOUT_MS = 12 * HOUR;
/** After a "level held" post, the same level is not posted about again for this long. */
export const LEVEL_COOLDOWN_MS = 6 * HOUR;
/** Price must be this far above the level (in %) to call the level held; the engine's test zone is 0.5%. */
export const RECOVERY_PCT = 1.5;
/** Below this DEF spend an episode is not worth a post. */
export const MIN_DEFENSE_SPEND_SOL = 0.1;

export const VOLUME_MILESTONES_SOL: readonly number[] = [10, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000];
export const HOLDER_MILESTONES: readonly number[] = [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000];
export const DAY_MILESTONES: readonly number[] = [7, 14, 30, 60, 90, 180, 365];

interface Episode {
  level: number;
  startTs: number;
}

/** A draft held back by the rate limit on one channel, retried every tick until it goes out or expires. */
interface Pending {
  draft: Draft;
  channel: ChannelName;
  expiresAt: number;
}

interface ProjectState {
  /** Highest event id already processed. */
  lastEventId: number;
  lastRecapDay?: string;
  /** "<draft key>#<channel>" of posts already written; capped to the last 500. */
  done: string[];
  episodes: Episode[];
  /** level -> ts of the last "held" post. */
  levelCooldown: Record<string, number>;
  pending: Pending[];
}

/** A draft held back by the rate limit is dropped after this long: yesterday's milestone is not news. */
export const PENDING_TTL_MS = 6 * HOUR;

interface State {
  version: 1;
  projects: Record<string, ProjectState>;
}

export interface MarketerOptions {
  ledger: Ledger;
  /** Current project configs (re-read every tick so a mode change applies at once). */
  projects: () => ProjectConfig[];
  channels: Channel[];
  /** TENFOLD_PROOF_BASE_URL. */
  proofBaseUrl: string;
  /** JSON file for the cursor and dedupe keys; omitted = memory only (tests). */
  statePath?: string;
  now?: () => number;
  intervalMs?: number;
  maxPostsPerDay?: number;
  minGapMs?: number;
  /** Post for paper projects too (dry runs only; simulated numbers must never go public). */
  allowPaper?: boolean;
  /** Holder count from the chain; without it no holders milestone is ever posted. */
  holderCount?: (cfg: ProjectConfig) => Promise<number | undefined>;
}

export interface TickResult {
  drafted: number;
  published: number;
  failed: number;
  expired: number;
}

export class Marketer {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private state: State;
  private dirty = false;
  private readonly now: () => number;
  private readonly warnedPaper = new Set<string>();
  /** "<project>#<channel>" -> when this process last wrote a post there (the ledger stamps posts with its own clock). */
  private readonly lastWritten = new Map<string, number>();

  constructor(private readonly opts: MarketerOptions) {
    this.now = opts.now ?? Date.now;
    this.state = this.loadState();
  }

  start(): void {
    if (this.timer) return;
    const interval = this.opts.intervalMs ?? POLL_INTERVAL_MS;
    const loop = async (): Promise<void> => {
      try {
        await this.tick();
      } catch (e) {
        logger.error("marketing tick failed", { error: (e as Error).message });
      }
      if (this.timer) this.timer = setTimeout(loop, interval);
    };
    this.timer = setTimeout(loop, 0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.saveState();
  }

  /** One pass over every project. */
  async tick(): Promise<TickResult> {
    const result: TickResult = { drafted: 0, published: 0, failed: 0, expired: 0 };
    if (this.running) return result;
    this.running = true;
    try {
      const now = this.now();
      for (const cfg of this.opts.projects()) {
        if (!cfg.marketing) continue;
        result.expired += this.expireDrafts(cfg, now);
        if (cfg.marketing.mode === "off") {
          result.failed += this.failApproved(cfg, "marketing is off for this project");
          continue;
        }
        if (cfg.mode === "paper" && !this.opts.allowPaper) {
          if (!this.warnedPaper.has(cfg.id)) {
            this.warnedPaper.add(cfg.id);
            logger.info("marketing skips paper project (simulated fills never go public)", { project: cfg.id });
          }
          continue;
        }
        try {
          const st = this.stateFor(cfg.id);
          const drafts: Draft[] = [];
          for (const ev of this.newEvents(cfg.id, st.lastEventId)) {
            try {
              drafts.push(...this.handleEvent(ev, cfg, st, now));
            } catch (e) {
              logger.error("marketing event handling failed", { project: cfg.id, type: ev.type, error: (e as Error).message });
            }
            st.lastEventId = ev.id;
            this.dirty = true;
          }
          drafts.push(...this.checkEpisodes(cfg, st, now));
          drafts.push(...(await this.checkMilestones(cfg, st, now)));
          result.drafted += this.retryPending(cfg, st, now);
          for (const d of drafts) result.drafted += this.writeDraft(d, cfg, st, now);
          if (st.done.length > 500) st.done.splice(0, st.done.length - 500);
        } catch (e) {
          logger.error("marketing project pass failed", { project: cfg.id, error: (e as Error).message });
        }
        const pub = await this.publishApproved(cfg, now);
        result.published += pub.published;
        result.failed += pub.failed;
      }
      this.saveState();
      return result;
    } finally {
      this.running = false;
    }
  }

  // ---------- events ----------

  private newEvents(projectId: string, afterId: number): (EngineEvent & { id: number })[] {
    const rows = this.opts.ledger.db
      .prepare(`SELECT id, project_id, type, ts, data_json FROM events WHERE project_id = ? AND id > ? ORDER BY id ASC LIMIT 500`)
      .all(projectId, afterId) as unknown as { id: number; project_id: string; type: string; ts: number; data_json: string }[];
    return rows.map((r) => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(r.data_json) as Record<string, unknown>;
      } catch {
        // malformed row: treat as empty data
      }
      return { id: r.id, projectId: r.project_id, type: r.type as EngineEvent["type"], ts: r.ts, data };
    });
  }

  private handleEvent(ev: EngineEvent & { id: number }, cfg: ProjectConfig, st: ProjectState, now: number): Draft[] {
    const ctx = this.ctx(cfg);
    const d = ev.data ?? {};
    // Compared as plain strings: withdrawal events come from the vault program and are not yet in EngineEventType.
    switch (ev.type as string) {
      case "badge_changed": {
        const from = str(d, "from") as BadgeTier | undefined;
        const to = str(d, "to") as BadgeTier | undefined;
        if (!from || !to) return [];
        const reasons = Array.isArray(d.reasons) ? (d.reasons as unknown[]).filter((r): r is string => typeof r === "string") : [];
        const draft = badgeChange({ from, to, reasons, ts: ev.ts }, ctx);
        return draft ? [draft] : [];
      }
      case "level_hit": {
        const level = num(d, "level");
        if (level === undefined || level <= 0) return [];
        if (st.episodes.some((e) => e.level === level)) return [];
        const cool = st.levelCooldown[String(level)];
        if (cool !== undefined && now - cool < LEVEL_COOLDOWN_MS) return [];
        st.episodes.push({ level, startTs: ev.ts });
        this.dirty = true;
        return [];
      }
      case "daily_report": {
        const day = dayKey(ev.ts);
        if (st.lastRecapDay === day) return [];
        const draft = this.recap(cfg, ev.ts);
        if (!draft) return [];
        st.lastRecapDay = day;
        this.dirty = true;
        return [draft];
      }
      case "withdrawal":
      case "withdrawal_requested":
      case "withdrawal_settled":
      case "withdrawal_cancelled": {
        const status = withdrawalStatus(ev.type, str(d, "status"));
        if (!status) return [];
        // SOL arrives as a number of SOL or a lamports string; tokens as whole tokens (number) or base units (string).
        const lamports = big(d, "amountLamports") ?? big(d, "lamports");
        const tokensWhole = typeof d.amountTokens === "number" ? num(d, "amountTokens") : num(d, "tokens");
        const tokensBase = typeof d.amountTokens === "string" ? big(d, "amountTokens") : big(d, "amountBase");
        const draft = withdrawalNotice(
          {
            status,
            amountSol: num(d, "amountSol") ?? num(d, "sol") ?? (lamports !== undefined ? lamportsToSol(lamports) : undefined),
            amountTokens: tokensWhole ?? (tokensBase !== undefined ? baseToTokens(tokensBase, cfg.decimals) : undefined),
            delayHours: num(d, "delayHours"),
            settlesAt: num(d, "settlesAt") ?? num(d, "unlockAt"),
            txSig: str(d, "txSig"),
            ts: ev.ts,
          },
          ctx,
        );
        return draft ? [draft] : [];
      }
      default:
        return [];
    }
  }

  /** The daily recap for the 24h ending at `to`, from the ledger only. */
  recap(cfg: ProjectConfig, to: number): Draft | undefined {
    const { ledger } = this.opts;
    const report = ledger.dailyReport(cfg.id, to);
    const coverage = ledger.latestCoverage(cfg.id);
    const fills = ledger.listFills(cfg.id, { since: report.from, until: report.to, limit: 10_000 });
    const volumeByReasonSol: Record<string, number> = {};
    for (const f of fills) {
      const sol = lamportsToSol(f.side === "buy" ? f.inAmount : f.outAmount);
      volumeByReasonSol[f.reason] = (volumeByReasonSol[f.reason] ?? 0) + sol;
    }
    // The anchor of the day the window mostly covers, if it exists already (anchors land after the UTC day closes).
    const days = new Set([dayKey(report.from), dayKey(report.to - 1)]);
    const anchor = ledger.listAnchors(cfg.id, 5).find((a) => days.has(a.day));
    let lpFeesSol = 0;
    for (const ev of ledger.listEvents(cfg.id, { since: report.from, types: ["lp_rebalanced"], limit: 500 })) {
      const fees = num(ev.data ?? {}, "feesSol");
      if (fees !== undefined && ev.ts <= report.to) lpFeesSol += fees;
    }
    return dailyRecap(report, coverage, this.ctx(cfg), { volumeByReasonSol, anchor, ...(lpFeesSol > 0 ? { lpFeesSol } : {}) });
  }

  // ---------- level episodes ----------

  private checkEpisodes(cfg: ProjectConfig, st: ProjectState, now: number): Draft[] {
    if (st.episodes.length === 0) return [];
    const { ledger } = this.opts;
    const snap = ledger.latestSnapshot(cfg.id);
    if (!snap) return [];
    const maxBelow = cfg.strategy.defense.maxDistanceBelowPct ?? 15;
    const out: Draft[] = [];
    const keep: Episode[] = [];
    for (const ep of st.episodes) {
      if (now - ep.startTs > EPISODE_TIMEOUT_MS) {
        this.dirty = true;
        continue;
      }
      if (snap.price < ep.level * (1 - maxBelow / 100)) {
        // Level lost: nothing to say. Dropped, a later hit opens a new episode.
        this.dirty = true;
        continue;
      }
      if (snap.price >= ep.level * (1 + RECOVERY_PCT / 100)) {
        const fills = ledger.listFills(cfg.id, { since: ep.startTs, until: now, limit: 10_000 }).filter((f) => f.side === "buy" && f.reason === "DEF");
        const spentSol = fills.reduce((a, f) => a + lamportsToSol(f.inAmount), 0);
        if (spentSol >= MIN_DEFENSE_SPEND_SOL) {
          const snaps = ledger.snapshotsSince(cfg.id, ep.startTs, 10_000);
          const lowPrice = snaps.length ? Math.min(...snaps.map((s) => s.price)) : undefined;
          const draft = levelDefended(
            { level: ep.level, spentSol, fills: fills.length, durationMin: (now - ep.startTs) / MINUTE, lowPrice, ts: now },
            this.ctx(cfg),
          );
          if (draft) out.push(draft);
          st.levelCooldown[String(ep.level)] = now;
        }
        this.dirty = true;
        continue;
      }
      keep.push(ep);
    }
    st.episodes = keep;
    return out;
  }

  // ---------- milestones ----------

  private async checkMilestones(cfg: ProjectConfig, st: ProjectState, now: number): Promise<Draft[]> {
    const out: Draft[] = [];
    const ctx = this.ctx(cfg);
    const pick = (kind: "volume" | "days" | "holders", value: number, thresholds: readonly number[]): void => {
      const crossed = thresholds.filter((t) => value >= t);
      const top = crossed[crossed.length - 1];
      if (top === undefined) return;
      const key = `milestone:${kind}:${top}`;
      if (this.seen(st, key, cfg)) return;
      // Lower thresholds crossed in the same stride are marked seen without a post: one milestone per kind at a time.
      for (const t of crossed) if (t !== top) this.markSeen(st, `milestone:${kind}:${t}`);
      const draft = milestone(kind, top, ctx);
      if (draft) out.push(draft);
    };

    pick("volume", this.lifetimeVolumeSol(cfg.id), VOLUME_MILESTONES_SOL);

    const days = Math.floor((now - cfg.createdAt) / DAY);
    pick("days", days, DAY_MILESTONES);

    if (this.opts.holderCount) {
      try {
        const holders = await this.opts.holderCount(cfg);
        if (holders !== undefined && Number.isInteger(holders) && holders > 0) pick("holders", holders, HOLDER_MILESTONES);
      } catch (e) {
        logger.warn("holder count failed", { project: cfg.id, error: (e as Error).message });
      }
    }
    return out;
  }

  /** SOL traded by the vault since onboarding, real fills only (buy: SOL in, sell: SOL out). REAL sum: thresholds only. */
  lifetimeVolumeSol(projectId: string): number {
    const row = this.opts.ledger.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN side = 'buy' THEN CAST(in_amount AS REAL) ELSE CAST(out_amount AS REAL) END), 0) AS lamports
         FROM fills WHERE project_id = ? AND paper = 0`,
      )
      .get(projectId) as { lamports: number };
    return Number(row.lamports) / 1e9;
  }

  // ---------- writing drafts ----------

  /** Write the draft for every enabled channel it has not been written to yet. Returns how many posts were created. */
  private writeDraft(draft: Draft, cfg: ProjectConfig, st: ProjectState, now: number): number {
    let created = 0;
    for (const channel of this.opts.channels) {
      if (!channel.enabledFor(cfg)) continue;
      if (st.done.includes(`${draft.key}#${channel.name}`)) continue;
      const outcome = this.writeOne(draft, channel, cfg, st, now);
      if (outcome === "written") created++;
      else if (outcome === "held" && !st.pending.some((p) => p.draft.key === draft.key && p.channel === channel.name)) {
        st.pending.push({ draft, channel: channel.name, expiresAt: now + PENDING_TTL_MS });
        this.dirty = true;
      }
    }
    return created;
  }

  /** Drafts held back earlier: write the ones that now fit, drop the ones that expired. */
  private retryPending(cfg: ProjectConfig, st: ProjectState, now: number): number {
    if (st.pending.length === 0) return 0;
    let created = 0;
    const keep: Pending[] = [];
    for (const p of st.pending) {
      if (p.expiresAt <= now) {
        logger.info("held post expired", { project: cfg.id, channel: p.channel, kind: p.draft.kind });
        continue;
      }
      const channel = this.opts.channels.find((c) => c.name === p.channel);
      if (!channel || !channel.enabledFor(cfg) || st.done.includes(`${p.draft.key}#${p.channel}`)) continue;
      const outcome = this.writeOne(p.draft, channel, cfg, st, now);
      if (outcome === "written") created++;
      else if (outcome === "held") keep.push(p);
    }
    if (keep.length !== st.pending.length) this.dirty = true;
    st.pending = keep;
    return created;
  }

  /**
   * One draft on one channel: checks the text, the rate limit and the mode, then inserts the post (draft or approved)
   * and the post_drafted event the agent relays. "held" means the rate limit said no for now.
   */
  private writeOne(draft: Draft, channel: Channel, cfg: ProjectConfig, st: ProjectState, now: number): "written" | "held" | "dropped" {
    const mode = cfg.marketing?.mode;
    if (!mode || mode === "off") return "dropped";
    const doneKey = `${draft.key}#${channel.name}`;
    const text = channel.name === "x" ? draft.x : draft.telegram;
    if (channel.name === "x" && text.length > X_MAX_CHARS) {
      logger.error("x draft over the limit, dropped", { project: cfg.id, kind: draft.kind, chars: text.length });
      this.markSeen(st, doneKey);
      return "dropped";
    }
    const hype = hypeWords(text, [cfg.name, cfg.marketing?.xHandle ?? ""]);
    if (hype.length) {
      logger.error("draft contains banned words, dropped", { project: cfg.id, kind: draft.kind, words: hype });
      this.markSeen(st, doneKey);
      return "dropped";
    }
    // Transparency posts (a downgrade, a withdrawal) are never held back: holding them is what the badge promises not to do.
    const bypassLimits = draft.kind === "withdrawal_notice" || (draft.kind === "badge_change" && downgradeKey(draft.key));
    if (!bypassLimits) {
      const why = this.rateLimited(cfg.id, channel.name, now);
      if (why) {
        logger.debug("post held back by rate limit", { project: cfg.id, channel: channel.name, kind: draft.kind, why });
        return "held";
      }
    }
    const post = this.opts.ledger.insertPost({ projectId: cfg.id, channel: channel.name, kind: draft.kind, text, status: mode === "auto" ? "approved" : "draft" });
    this.opts.ledger.insertEvent({
      type: "post_drafted",
      projectId: cfg.id,
      ts: now,
      data: { postId: post.id, channel: channel.name, kind: draft.kind, text, key: draft.key, auto: mode === "auto" },
    });
    logger.info("post drafted", { project: cfg.id, postId: post.id, channel: channel.name, kind: draft.kind, status: post.status, chars: text.length });
    this.lastWritten.set(`${cfg.id}#${channel.name}`, now);
    this.markSeen(st, doneKey);
    return "written";
  }

  /** A reason when the (project, channel) pair has posted too much lately; undefined when a post may go. */
  rateLimited(projectId: string, channel: ChannelName, now: number): string | undefined {
    const max = this.opts.maxPostsPerDay ?? DEFAULT_MAX_POSTS_PER_DAY;
    const gap = this.opts.minGapMs ?? DEFAULT_MIN_GAP_MS;
    const recent = this.opts.ledger
      .listPosts(projectId, { limit: 200 })
      .filter((p) => p.channel === channel && p.status !== "rejected" && p.status !== "failed" && p.ts > now - DAY);
    if (recent.length >= max) return `${recent.length} posts in the last 24h (max ${max})`;
    const last = Math.max(recent[0]?.ts ?? 0, this.lastWritten.get(`${projectId}#${channel}`) ?? 0);
    if (last && now - last < gap) return `last post ${Math.round((now - last) / MINUTE)} min ago (min gap ${Math.round(gap / MINUTE)} min)`;
    return undefined;
  }

  // ---------- publishing ----------

  private async publishApproved(cfg: ProjectConfig, now: number): Promise<{ published: number; failed: number }> {
    const { ledger } = this.opts;
    const approved = ledger.listPosts(cfg.id, { status: "approved", limit: 50 }).reverse();
    let published = 0;
    let failed = 0;
    for (const post of approved) {
      const channel = this.opts.channels.find((c) => c.name === post.channel);
      if (!channel) {
        ledger.updatePost(post.id, { status: "failed", error: `channel ${post.channel} is not configured on this server` });
        failed++;
        continue;
      }
      if (!channel.enabledFor(cfg)) {
        ledger.updatePost(post.id, { status: "failed", error: `channel ${post.channel} is not enabled for this project` });
        failed++;
        continue;
      }
      try {
        const res = await channel.publish(post.text, cfg);
        ledger.updatePost(post.id, { status: "posted", externalId: res.externalId });
        ledger.insertEvent({
          type: "post_published",
          projectId: cfg.id,
          ts: now,
          data: { postId: post.id, channel: post.channel, kind: post.kind, externalId: res.externalId, url: res.url, text: post.text },
        });
        logger.info("post published", { project: cfg.id, postId: post.id, channel: post.channel, externalId: res.externalId, url: res.url });
        published++;
      } catch (e) {
        const msg = (e as Error).message;
        ledger.updatePost(post.id, { status: "failed", error: msg.slice(0, 500) });
        logger.error("post failed", { project: cfg.id, postId: post.id, channel: post.channel, error: msg });
        failed++;
      }
    }
    return { published, failed };
  }

  /** Drafts nobody approved within DRAFT_TTL_MS are rejected: a recap of the day before yesterday is not news. */
  private expireDrafts(cfg: ProjectConfig, now: number): number {
    let n = 0;
    for (const p of this.opts.ledger.listPosts(cfg.id, { status: "draft", limit: 200 })) {
      if (p.ts <= now - DRAFT_TTL_MS) {
        this.opts.ledger.updatePost(p.id, { status: "rejected", error: "expired: not approved within 24h" });
        n++;
      }
    }
    return n;
  }

  private failApproved(cfg: ProjectConfig, why: string): number {
    let n = 0;
    for (const p of this.opts.ledger.listPosts(cfg.id, { status: "approved", limit: 50 })) {
      this.opts.ledger.updatePost(p.id, { status: "failed", error: why });
      n++;
    }
    return n;
  }

  // ---------- state ----------

  private ctx(cfg: ProjectConfig): DraftContext {
    return { cfg, proofBaseUrl: this.opts.proofBaseUrl };
  }

  /** True when nothing remains to do for this key: marked bare, or written/pending on every enabled channel. */
  private seen(st: ProjectState, key: string, cfg: ProjectConfig): boolean {
    if (st.done.includes(key)) return true;
    const channels = this.opts.channels.filter((c) => c.enabledFor(cfg));
    if (channels.length === 0) return true;
    return channels.every((c) => st.done.includes(`${key}#${c.name}`) || st.pending.some((p) => p.draft.key === key && p.channel === c.name));
  }

  private markSeen(st: ProjectState, key: string): void {
    if (!st.done.includes(key)) {
      st.done.push(key);
      this.dirty = true;
    }
  }

  /** State for a project; a project seen for the first time starts at the current end of its event log. */
  private stateFor(projectId: string): ProjectState {
    let st = this.state.projects[projectId];
    if (!st) {
      const row = this.opts.ledger.db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM events WHERE project_id = ?`).get(projectId) as { m: number };
      st = { lastEventId: Number(row.m), done: [], episodes: [], levelCooldown: {}, pending: [] };
      this.state.projects[projectId] = st;
      this.dirty = true;
    }
    return st;
  }

  private loadState(): State {
    const empty: State = { version: 1, projects: {} };
    const path = this.opts.statePath;
    if (!path || !existsSync(path)) return empty;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<State>;
      if (parsed.version !== 1 || typeof parsed.projects !== "object" || parsed.projects === null) return empty;
      for (const st of Object.values(parsed.projects)) {
        st.done ??= [];
        st.episodes ??= [];
        st.levelCooldown ??= {};
        st.pending ??= [];
        st.lastEventId ??= 0;
      }
      return parsed as State;
    } catch (e) {
      logger.warn("marketing state unreadable, starting fresh", { path, error: (e as Error).message });
      return empty;
    }
  }

  private saveState(): void {
    if (!this.dirty || !this.opts.statePath) return;
    try {
      const dir = dirname(this.opts.statePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${this.opts.statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.opts.statePath);
      this.dirty = false;
    } catch (e) {
      logger.error("marketing state save failed", { path: this.opts.statePath, error: (e as Error).message });
    }
  }

  /** Test hook: the posts of a project, newest first. */
  posts(projectId: string, status?: Post["status"]): Post[] {
    return this.opts.ledger.listPosts(projectId, status ? { status } : {});
  }
}

// ---------- helpers ----------

type Data = Record<string, unknown>;

function num(d: Data, k: string): number | undefined {
  const v = d[k];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) && !/^\d{16,}$/.test(v)) return Number(v);
  return undefined;
}
function big(d: Data, k: string): bigint | undefined {
  const v = d[k];
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  } catch {
    return undefined;
  }
  return undefined;
}
function str(d: Data, k: string): string | undefined {
  const v = d[k];
  return typeof v === "string" && v.trim() ? v : undefined;
}

function withdrawalStatus(type: string, status: string | undefined): "requested" | "settled" | "cancelled" | undefined {
  if (type === "withdrawal_requested") return "requested";
  if (type === "withdrawal_settled") return "settled";
  if (type === "withdrawal_cancelled") return "cancelled";
  if (status === "requested" || status === "settled" || status === "cancelled") return status;
  return undefined;
}

/** badge keys are "badge:<from>:<to>:<ts>"; true when the tier went down. */
function downgradeKey(key: string): boolean {
  const [, from, to] = key.split(":");
  return isDowngrade({ from: from as BadgeTier, to: to as BadgeTier });
}
