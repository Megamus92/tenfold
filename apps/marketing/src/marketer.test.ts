import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Ledger, ProjectConfig } from "@tenfold/core";
import { dayKey, fmtTime } from "./format.js";
import { DEFAULT_MAX_POSTS_PER_DAY, DEFAULT_MIN_GAP_MS, Marketer } from "./marketer.js";
import { FakeChannel, PROOF, fill, ledgerWith, project, snapshot } from "./testkit.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// The ledger stamps posts with the real clock, so the injected clock starts at the real now and moves forward.
let cfg: ProjectConfig;
let ledger: Ledger;
let x: FakeChannel;
let tg: FakeChannel;
let clock: number;
let dir: string;

function marketer(over: Partial<ConstructorParameters<typeof Marketer>[0]> = {}): Marketer {
  return new Marketer({
    ledger,
    projects: () => [cfg],
    channels: [x, tg],
    proofBaseUrl: PROOF,
    now: () => clock,
    ...over,
  });
}

const auto = { mode: "auto" as const, xHandle: "alphacoin", telegramChannelId: "@alphacoin_news" };

beforeEach(() => {
  clock = Date.now();
  cfg = project({ createdAt: clock - 3 * 24 * HOUR });
  ledger = ledgerWith(cfg);
  x = new FakeChannel("x");
  tg = new FakeChannel("telegram", (c) => Boolean(c.marketing?.telegramChannelId) && c.marketing?.mode !== "off");
  dir = mkdtempSync(join(tmpdir(), "tenfold-mkt-"));
  snapshot(ledger, cfg, clock - HOUR, 0.0002);
});
afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Marketer: approve mode", () => {
  it("drafts a badge change once per channel and tells the agent through post_drafted", async () => {
    const m = marketer();
    await m.tick(); // first sight: cursor set at the end of the log, nothing drafted
    ledger.insertEvent({ type: "badge_changed", projectId: "alpha", ts: clock, data: { from: "managed", to: "gold", reasons: ["LP burned"] } });
    const r = await m.tick();
    expect(r.drafted).toBe(2);
    const drafts = ledger.listPosts("alpha", { status: "draft" });
    expect(drafts.map((p) => p.channel).sort()).toEqual(["telegram", "x"]);
    expect(drafts.every((p) => p.kind === "badge_change")).toBe(true);
    const events = ledger.listEvents("alpha", { types: ["post_drafted"] });
    expect(events).toHaveLength(2);
    expect(events[0]!.data).toMatchObject({ channel: expect.any(String), kind: "badge_change", auto: false });
    expect(typeof events[0]!.data.postId).toBe("string");
    // nothing published, nothing re-drafted on the next tick
    expect(x.posted).toHaveLength(0);
    expect((await m.tick()).drafted).toBe(0);
  });

  it("publishes a post once the founder approved it and emits post_published", async () => {
    const m = marketer();
    await m.tick();
    ledger.insertEvent({ type: "badge_changed", projectId: "alpha", ts: clock, data: { from: "beta", to: "managed", reasons: [] } });
    await m.tick();
    const draft = ledger.listPosts("alpha", { status: "draft" }).find((p) => p.channel === "x")!;
    ledger.updatePost(draft.id, { status: "approved" });
    const r = await m.tick();
    expect(r.published).toBe(1);
    expect(x.posted).toHaveLength(1);
    expect(x.posted[0]!.text).toBe(draft.text);
    const posted = ledger.getPost(draft.id)!;
    expect(posted.status).toBe("posted");
    expect(posted.externalId).toBe("x-1");
    expect(posted.postedAt).toBeDefined();
    const pub = ledger.listEvents("alpha", { types: ["post_published"] });
    expect(pub).toHaveLength(1);
    expect(pub[0]!.data).toMatchObject({ postId: draft.id, channel: "x", externalId: "x-1", url: "https://x.example/1" });
  });

  it("marks a post failed with the channel's error and never retries it on its own", async () => {
    const m = marketer();
    await m.tick();
    ledger.insertEvent({ type: "badge_changed", projectId: "alpha", ts: clock, data: { from: "beta", to: "managed", reasons: [] } });
    await m.tick();
    const draft = ledger.listPosts("alpha", { status: "draft" }).find((p) => p.channel === "x")!;
    ledger.updatePost(draft.id, { status: "approved" });
    x.failWith = new Error("X API 429: Too Many Requests");
    const r = await m.tick();
    expect(r.failed).toBe(1);
    expect(ledger.getPost(draft.id)).toMatchObject({ status: "failed", error: "X API 429: Too Many Requests" });
    x.failWith = undefined;
    expect((await m.tick()).published).toBe(0);
  });

  it("expires drafts nobody approved within 24h", async () => {
    const m = marketer();
    await m.tick();
    ledger.insertEvent({ type: "badge_changed", projectId: "alpha", ts: clock, data: { from: "beta", to: "managed", reasons: [] } });
    await m.tick();
    clock += 25 * HOUR;
    const r = await m.tick();
    expect(r.expired).toBe(2);
    expect(ledger.listPosts("alpha", { status: "rejected" })).toHaveLength(2);
    expect(ledger.listPosts("alpha", { status: "rejected" })[0]!.error).toMatch(/expired/);
  });
});

describe("Marketer: auto mode", () => {
  beforeEach(() => {
    cfg = project({ marketing: auto, createdAt: clock - 3 * 24 * HOUR });
    ledger.upsertProject(cfg);
  });

  it("publishes without asking", async () => {
    const m = marketer();
    await m.tick();
    ledger.insertEvent({ type: "badge_changed", projectId: "alpha", ts: clock, data: { from: "managed", to: "gold", reasons: ["mint authority revoked"] } });
    const r = await m.tick();
    expect(r.drafted).toBe(2);
    expect(r.published).toBe(2);
    expect(x.posted).toHaveLength(1);
    expect(tg.posted).toHaveLength(1);
    expect(x.posted[0]!.text).toContain("managed -> gold");
    expect(x.posted[0]!.text.length).toBeLessThanOrEqual(260);
    expect(tg.posted[0]!.text).toContain("Why:");
    expect(ledger.listPosts("alpha", { status: "posted" })).toHaveLength(2);
  });

  it("holds ordinary posts back by the daily cap and the minimum gap, but never a badge downgrade", async () => {
    const m = marketer();
    await m.tick();
    for (let i = 0; i < DEFAULT_MAX_POSTS_PER_DAY; i++) {
      ledger.insertPost({ projectId: "alpha", channel: "x", kind: "milestone", text: `old ${i}`, status: "posted" });
    }
    ledger.insertEvent({ type: "badge_changed", projectId: "alpha", ts: clock, data: { from: "beta", to: "managed", reasons: [] } });
    let r = await m.tick();
    expect(x.posted).toHaveLength(0); // X at its daily cap: held
    expect(tg.posted).toHaveLength(1); // Telegram has room
    expect(r.published).toBe(1);
    expect(m.rateLimited("alpha", "x", clock)).toMatch(/4 posts in the last 24h/);
    // A downgrade goes out whatever the counters say.
    ledger.insertEvent({ type: "badge_changed", projectId: "alpha", ts: clock, data: { from: "managed", to: "flagged", reasons: ["insider wallet sold 2% of supply"] } });
    r = await m.tick();
    expect(x.posted).toHaveLength(1);
    expect(x.posted[0]!.text).toContain("managed -> flagged");
    expect(m.rateLimited("alpha", "telegram", clock)).toMatch(/min gap/);
    expect(m.rateLimited("alpha", "telegram", clock + DEFAULT_MIN_GAP_MS + MINUTE)).toBeUndefined();
    // The held upgrade goes out on X once the 24h window has room again (held posts live 6h).
    clock += 5 * HOUR;
    ledger.db.prepare(`UPDATE posts SET ts = ts - ? WHERE text LIKE 'old %'`).run(2 * 24 * HOUR);
    r = await m.tick();
    expect(r.drafted).toBe(1);
    expect(x.posted.map((p) => p.text).some((t) => t.includes("beta -> managed"))).toBe(true);
  });

  it("writes a daily recap once per day when the engine reports, from fills and anchors", async () => {
    const m = marketer();
    await m.tick();
    fill(ledger, cfg, { side: "sell", reason: "DIST", ts: clock - 2 * HOUR, sol: 0.6, tokens: 3_000 });
    fill(ledger, cfg, { side: "buy", reason: "DEF", ts: clock - 3 * HOUR, sol: 0.9, tokens: 5_000 });
    ledger.insertAnchor({ projectId: "alpha", day: dayKey(clock - 1), hash: "deadbeefcafe0123", entries: 12, txSig: "anchorsig" });
    snapshot(ledger, cfg, clock, 0.00021);
    ledger.insertEvent({ type: "daily_report", projectId: "alpha", ts: clock, data: {} });
    let r = await m.tick();
    expect(r.drafted).toBe(2);
    const xPost = x.posted[0]!.text;
    expect(xPost).toContain("2 fills, 1.5 SOL: DEF 0.9, DIST 0.6");
    expect(xPost).toContain("Price 0.0002 -> 0.00021 SOL (+5%)");
    expect(xPost).toContain("Log hash deadbeefca...");
    expect(xPost).toContain(`${PROOF}/p/alpha`);
    // a second daily_report the same day is ignored
    ledger.insertEvent({ type: "daily_report", projectId: "alpha", ts: clock + MINUTE, data: {} });
    clock += MINUTE;
    r = await m.tick();
    expect(r.drafted).toBe(0);
  });

  it("posts 'level held' only after price recovers above the level with real DEF buys behind it", async () => {
    const m = marketer();
    await m.tick();
    ledger.insertEvent({ type: "level_hit", projectId: "alpha", ts: clock, data: { level: 0.00018, price: 0.000179 } });
    snapshot(ledger, cfg, clock, 0.000179);
    await m.tick();
    expect(x.posted).toHaveLength(0);
    // still under the level 20 min later, buys happening
    clock += 20 * MINUTE;
    fill(ledger, cfg, { side: "buy", reason: "DEF", ts: clock - MINUTE, sol: 1.2, tokens: 6_700 });
    fill(ledger, cfg, { side: "buy", reason: "DEF", ts: clock - 30_000, sol: 1.3, tokens: 7_300 });
    snapshot(ledger, cfg, clock, 0.000177);
    await m.tick();
    expect(x.posted).toHaveLength(0);
    // recovered: 1.5% above the level
    clock += 25 * MINUTE;
    snapshot(ledger, cfg, clock, 0.000183);
    const r = await m.tick();
    expect(r.drafted).toBe(2);
    expect(x.posted[0]!.text).toContain("the 0.00018 level held. Tenfold spent 2.5 SOL in 2 real buys over 45 min. Low 0.000177.");
    // a new hit on the same level inside the cooldown opens no new episode
    ledger.insertEvent({ type: "level_hit", projectId: "alpha", ts: clock, data: { level: 0.00018 } });
    clock += MINUTE;
    snapshot(ledger, cfg, clock, 0.000184);
    expect((await m.tick()).drafted).toBe(0);
  });

  it("stays silent when the level is lost", async () => {
    const m = marketer();
    await m.tick();
    ledger.insertEvent({ type: "level_hit", projectId: "alpha", ts: clock, data: { level: 0.00018 } });
    fill(ledger, cfg, { side: "buy", reason: "DEF", ts: clock + 1, sol: 1, tokens: 5_000 });
    clock += 10 * MINUTE;
    snapshot(ledger, cfg, clock, 0.00014); // 22% under: lost
    await m.tick();
    clock += MINUTE;
    snapshot(ledger, cfg, clock, 0.00019); // bounces back later: not a defense
    expect((await m.tick()).drafted).toBe(0);
  });

  it("posts the highest crossed volume, days and holders milestones once, spaced by the minimum gap", async () => {
    // 40 days old, 120 SOL of real volume => days 30, volume 100; paper fills do not count
    cfg = project({ marketing: auto, createdAt: clock - 40 * 24 * HOUR });
    ledger.upsertProject(cfg);
    fill(ledger, cfg, { side: "sell", reason: "DIST", ts: clock - 5 * HOUR, sol: 70, tokens: 350_000 });
    fill(ledger, cfg, { side: "buy", reason: "DEF", ts: clock - 4 * HOUR, sol: 50, tokens: 250_000 });
    fill(ledger, cfg, { side: "buy", reason: "DEF", ts: clock - 3 * HOUR, sol: 500, tokens: 250_000, paper: true });
    const m = marketer({ holderCount: async () => 1_234 });
    expect(m.lifetimeVolumeSol("alpha")).toBeCloseTo(120, 6);
    let r = await m.tick();
    expect(r.drafted).toBe(2); // one milestone per channel at a time, the others wait for the gap
    expect(x.posted[0]!.text).toContain("passed 100 SOL of vault trading volume");
    clock += DEFAULT_MIN_GAP_MS + MINUTE;
    r = await m.tick();
    expect(r.drafted).toBe(2);
    expect(x.posted[1]!.text).toContain("30 days managed by Tenfold");
    clock += DEFAULT_MIN_GAP_MS + MINUTE;
    r = await m.tick();
    expect(r.drafted).toBe(2);
    expect(x.posted[2]!.text).toContain("1,000 holders");
    clock += DEFAULT_MIN_GAP_MS + MINUTE;
    expect((await m.tick()).drafted).toBe(0);
    // crossing the next threshold later posts again, once (the 24h cap is 4 per channel: make room)
    ledger.db.prepare(`UPDATE posts SET ts = ts - ?`).run(2 * 24 * HOUR);
    fill(ledger, cfg, { side: "sell", reason: "DIST", ts: clock, sol: 200, tokens: 1_000_000 });
    clock += DEFAULT_MIN_GAP_MS + MINUTE;
    expect((await m.tick()).drafted).toBe(2);
    expect(x.posted.at(-1)!.text).toContain("passed 250 SOL");
  });

  it("writes withdrawal transparency notes from vault events, whatever the rate limit says", async () => {
    const m = marketer();
    await m.tick();
    for (let i = 0; i < DEFAULT_MAX_POSTS_PER_DAY; i++) ledger.insertPost({ projectId: "alpha", channel: "x", kind: "milestone", text: `old ${i}`, status: "posted" });
    ledger.insertEvent({ type: "withdrawal_requested" as never, projectId: "alpha", ts: clock, data: { amountLamports: "10000000000", settlesAt: clock + 24 * HOUR } });
    await m.tick();
    expect(x.posted[0]!.text).toContain(`requested a withdrawal of 10 SOL from the vault. It settles after the 24h delay, at ${fmtTime(clock + 24 * HOUR)}.`);
    ledger.insertEvent({ type: "withdrawal_settled" as never, projectId: "alpha", ts: clock, data: { amountSol: 10, txSig: "settletx12345" } });
    await m.tick();
    expect(x.posted[1]!.text).toContain("settled after the 24h delay. tx settletx...");
  });
});

describe("Marketer: guards", () => {
  it("never posts for a paper project unless allowed, and fails approved posts when marketing is off", async () => {
    cfg = project({ mode: "paper", marketing: { mode: "auto", xHandle: "alphacoin" }, createdAt: clock - 3 * 24 * HOUR });
    ledger.upsertProject(cfg);
    const m = marketer();
    await m.tick();
    ledger.insertEvent({ type: "badge_changed", projectId: "alpha", ts: clock, data: { from: "beta", to: "managed", reasons: [] } });
    expect((await m.tick()).drafted).toBe(0);
    expect(x.posted).toHaveLength(0);

    cfg = project({ marketing: { mode: "off" }, createdAt: clock - 3 * 24 * HOUR });
    ledger.upsertProject(cfg);
    ledger.insertPost({ projectId: "alpha", channel: "x", kind: "milestone", text: "left over", status: "approved" });
    const r = await marketer().tick();
    expect(r.failed).toBe(1);
    expect(ledger.listPosts("alpha", { status: "failed" })[0]!.error).toMatch(/marketing is off/);
  });

  it("drops a channel's post when the channel is not configured on this server", async () => {
    cfg = project({ marketing: { mode: "auto", xHandle: "alphacoin" }, createdAt: clock - 3 * 24 * HOUR });
    ledger.upsertProject(cfg);
    ledger.insertPost({ projectId: "alpha", channel: "telegram", kind: "milestone", text: "hello", status: "approved" });
    const m = marketer({ channels: [x] });
    const r = await m.tick();
    expect(r.failed).toBe(1);
    expect(ledger.listPosts("alpha", { status: "failed" })[0]!.error).toMatch(/not configured/);
  });

  it("persists its cursor so a restart replays nothing", async () => {
    cfg = project({ marketing: { mode: "auto", xHandle: "alphacoin" }, createdAt: clock - 3 * 24 * HOUR });
    ledger.upsertProject(cfg);
    const statePath = join(dir, "state.json");
    const m1 = marketer({ statePath });
    await m1.tick();
    ledger.insertEvent({ type: "badge_changed", projectId: "alpha", ts: clock, data: { from: "beta", to: "managed", reasons: [] } });
    await m1.tick();
    m1.stop();
    expect(x.posted).toHaveLength(1);
    const saved = JSON.parse(readFileSync(statePath, "utf8")) as { projects: Record<string, { lastEventId: number; done: string[] }> };
    expect(saved.projects.alpha!.lastEventId).toBeGreaterThan(0);
    expect(saved.projects.alpha!.done.some((k) => k.startsWith("badge:beta:managed"))).toBe(true);
    const m2 = marketer({ statePath });
    expect((await m2.tick()).drafted).toBe(0);
    expect(x.posted).toHaveLength(1);
  });
});
