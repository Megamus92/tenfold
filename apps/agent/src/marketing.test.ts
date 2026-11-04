import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject } from "@tenfold/core";
import type { EngineEvent } from "@tenfold/core";
import { approvePost, findPost, listPosts, rejectPost, setMarketing } from "./actions.js";
import type { ActionContext } from "./actions.js";
import { AlertPoller, formatEvent } from "./alerts.js";
import { decidePost, draftKeyboard, draftPostId } from "./marketing.js";
import { fixture } from "./testkit.js";
import type { Fixture } from "./testkit.js";
import { CONFIRMED_TOOLS, TOOLS, parseToolCall } from "./tools.js";

let fx: Fixture;
const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({ ledger: fx.ledger, cfg: loadProject("test"), projectId: "test", ...over });
const ev = (type: EngineEvent["type"], data: Record<string, unknown>): EngineEvent => ({ type, projectId: "test", ts: Date.now(), data });

beforeEach(() => {
  fx = fixture({ marketing: { mode: "approve", xHandle: "testtoken", telegramChannelId: "@testtoken_news" } });
});
afterEach(() => fx.cleanup());

describe("tools: marketing", () => {
  it("declares the four marketing tools and marks the publishing ones as confirmed", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_posts", "approve_post", "reject_post", "set_marketing"]));
    expect(CONFIRMED_TOOLS.has("approve_post")).toBe(true);
    expect(CONFIRMED_TOOLS.has("set_marketing")).toBe(true);
    expect(CONFIRMED_TOOLS.has("reject_post")).toBe(false);
    expect(TOOLS.find((t) => t.name === "set_marketing")!.description).toMatch(/paid callers.*refuse/);
  });

  it("validates inputs", () => {
    expect(parseToolCall("list_posts", {})).toEqual({ name: "list_posts", input: {} });
    expect(parseToolCall("list_posts", { status: "posted" })).toEqual({ name: "list_posts", input: { status: "posted" } });
    expect(parseToolCall("list_posts", { status: "nope" })).toMatchObject({ error: expect.stringMatching(/status/) });
    expect(parseToolCall("approve_post", { postId: "ab" })).toMatchObject({ error: expect.stringMatching(/4 characters/) });
    expect(parseToolCall("approve_post", { postId: "abcd1234" })).toEqual({ name: "approve_post", input: { postId: "abcd1234" } });
    expect(parseToolCall("reject_post", { postId: "zzzz" })).toMatchObject({ error: expect.any(String) });
    expect(parseToolCall("set_marketing", {})).toMatchObject({ error: expect.stringMatching(/at least one/) });
    expect(parseToolCall("set_marketing", { mode: "auto", xHandle: "@MyToken" })).toEqual({ name: "set_marketing", input: { mode: "auto", xHandle: "MyToken" } });
    expect(parseToolCall("set_marketing", { xHandle: "has space" })).toMatchObject({ error: expect.stringMatching(/xHandle/) });
    expect(parseToolCall("set_marketing", { telegramChannelId: "@abc" })).toMatchObject({ error: expect.stringMatching(/telegramChannelId/) });
    expect(parseToolCall("set_marketing", { telegramChannelId: "-1001234567890", tone: " casual " })).toEqual({
      name: "set_marketing",
      input: { telegramChannelId: "-1001234567890", tone: "casual" },
    });
    expect(parseToolCall("set_marketing", { xHandle: "" })).toEqual({ name: "set_marketing", input: { xHandle: "" } });
  });
});

describe("actions: posts", () => {
  it("lists drafts with short ids, approves on confirmation only, rejects instantly", () => {
    const draft = fx.ledger.insertPost({ projectId: "test", channel: "x", kind: "badge_change", text: "Test Token (@testtoken) badge: beta -> managed. Details: http://p/test" });
    fx.ledger.insertPost({ projectId: "test", channel: "telegram", kind: "daily_recap", text: "line one\nline two", status: "posted" });

    const listed = listPosts(ctx());
    expect(listed.ok).toBe(true);
    expect(listed.message).toMatch(/^Marketing: approve, X @testtoken, Telegram @testtoken_news\n1 draft post\(s\):/);
    expect(listed.message).toContain(`${draft.id.slice(0, 8)} [draft] x badge_change`);
    expect(listPosts(ctx(), "all").message).toContain("[posted] telegram daily_recap");
    expect(listPosts(ctx(), "all").message).toContain("line one / line two");
    expect(listPosts(ctx(), "failed").message).toMatch(/No failed posts/);

    const res = approvePost(ctx(), draft.id.slice(0, 6));
    expect(res.ok).toBe(true);
    expect(res.needsConfirmation?.summary).toContain("Publish on X (badge_change):");
    expect(res.needsConfirmation?.summary).toContain(draft.text);
    expect(fx.ledger.getPost(draft.id)!.status).toBe("draft"); // not yet
    const applied = res.needsConfirmation!.apply();
    expect(applied.ok).toBe(true);
    expect(fx.ledger.getPost(draft.id)!.status).toBe("approved");
    expect(approvePost(ctx(), draft.id).message).toMatch(/already approved/);

    const other = fx.ledger.insertPost({ projectId: "test", channel: "x", kind: "milestone", text: "m" });
    const rej = rejectPost(ctx(), other.id.slice(0, 8));
    expect(rej.ok).toBe(true);
    expect(fx.ledger.getPost(other.id)).toMatchObject({ status: "rejected", error: "rejected by founder" });
  });

  it("refuses ambiguous prefixes, other projects' posts and approvals while marketing is off", () => {
    const a = fx.ledger.insertPost({ projectId: "test", channel: "x", kind: "milestone", text: "a" });
    fx.ledger.insertPost({ projectId: "other", channel: "x", kind: "milestone", text: "b" });
    expect(findPost(fx.ledger, "test", "nope").error).toMatch(/No post starts with/);
    expect(findPost(fx.ledger, "other", a.id).error).toMatch(/another project/);
    expect(findPost(fx.ledger, "test", a.id.slice(0, 8)).post?.id).toBe(a.id);
    const off = fixture({ marketing: { mode: "off" } });
    try {
      const p = off.ledger.insertPost({ projectId: "test", channel: "x", kind: "milestone", text: "a" });
      const res = approvePost({ ledger: off.ledger, cfg: loadProject("test"), projectId: "test" }, p.id);
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/Marketing is off/);
    } finally {
      off.cleanup();
    }
  });

  it("retries a failed post through approval and leaves posted ones alone", () => {
    const failed = fx.ledger.insertPost({ projectId: "test", channel: "telegram", kind: "milestone", text: "m", status: "failed" });
    fx.ledger.updatePost(failed.id, { error: "Telegram API 403" });
    const res = approvePost(ctx(), failed.id);
    expect(res.needsConfirmation?.summary).toContain("Publish on Telegram @testtoken_news (milestone, retry)");
    expect(res.needsConfirmation!.apply().ok).toBe(true);
    expect(fx.ledger.getPost(failed.id)!.status).toBe("approved");
    const posted = fx.ledger.insertPost({ projectId: "test", channel: "x", kind: "milestone", text: "m", status: "posted" });
    expect(approvePost(ctx(), posted.id).ok).toBe(false);
    expect(rejectPost(ctx(), posted.id).ok).toBe(false);
  });
});

describe("actions: set_marketing", () => {
  it("summarises the diff, applies on confirm, and persists through the project file", () => {
    const res = setMarketing(ctx(), { mode: "auto", tone: "casual", telegramChannelId: "" });
    expect(res.ok).toBe(true);
    expect(res.needsConfirmation?.summary).toContain("mode approve -> auto");
    expect(res.needsConfirmation?.summary).toContain("Telegram channel @testtoken_news -> none");
    expect(res.needsConfirmation?.summary).toContain('tone default -> "casual"');
    expect(res.needsConfirmation?.summary).toMatch(/auto mode posts go out without asking/);
    expect(loadProject("test").marketing?.mode).toBe("approve");
    expect(res.needsConfirmation!.apply().ok).toBe(true);
    const saved = loadProject("test").marketing!;
    expect(saved).toEqual({ mode: "auto", xHandle: "testtoken", tone: "casual" });
    expect(fx.ledger.getProject("test")?.marketing).toEqual(saved);
    expect(fx.ledger.pendingCommands().map((c) => c.type)).toContain("reload");
    expect(setMarketing(ctx(), { mode: "auto" }).message).toMatch(/already like that/);
  });

  it("can switch marketing on for a project that never had it", () => {
    const bare = fixture();
    try {
      const c: ActionContext = { ledger: bare.ledger, cfg: loadProject("test"), projectId: "test" };
      const res = setMarketing(c, { mode: "approve", xHandle: "fresh" });
      expect(res.needsConfirmation?.summary).toContain("mode off -> approve; X handle none -> @fresh");
      res.needsConfirmation!.apply();
      expect(loadProject("test").marketing).toEqual({ mode: "approve", xHandle: "fresh" });
    } finally {
      bare.cleanup();
    }
  });
});

describe("alerts: marketing and badge events", () => {
  it("formats badge changes with the direction and the marketing follow-up", () => {
    expect(formatEvent(ev("badge_changed", { from: "managed", to: "gold", reasons: ["every insider wallet is in the vault"] }), fx.cfg, fx.ledger)).toBe(
      "Badge managed -> gold (up). Why: every insider wallet is in the vault. Details are in your feed. A public post about it is drafted for your approval.",
    );
    expect(formatEvent(ev("badge_changed", { from: "gold", to: "flagged", reasons: [] }), { ...fx.cfg, marketing: { mode: "auto" } }, fx.ledger)).toBe(
      "Badge gold -> flagged (down). Details are in your feed. The change is posted publicly (auto mode).",
    );
    // first coverage check: no previous tier, so nothing is "changed" and nothing is posted
    expect(formatEvent(ev("badge_changed", { from: null, to: "beta", reasons: ["No on-chain vault yet"] }), fx.cfg, fx.ledger)).toBe(
      "Badge assigned: beta. Why: No on-chain vault yet. Details are in your feed.",
    );
  });

  it("formats insider sells, fee sweeps, anchors and LP rebalances", () => {
    expect(formatEvent(ev("insider_sell", { wallet: "3Kd9abcdefghijklmnopqrstuvwxyz1234567890WXYZ", amount: "2500000000", pctOfSupply: 1.2, txSig: "5KtPn3abcdef" }), fx.cfg, fx.ledger)).toBe(
      "Insider sell: 3Kd9...WXYZ sold 2,500 tokens (1.2% of supply), tx 5KtPn3ab.... It counts against the badge; moving insider supply into the vault or a public lock restores it.",
    );
    expect(formatEvent(ev("fees_swept", { netSol: 0.42, referralSol: 0.05, txSig: "sweepsig12345" }), fx.cfg, fx.ledger)).toBe("Tenfold fees swept: 0.42 SOL, 0.05 SOL to your referrer, tx sweepsig....");
    expect(formatEvent(ev("anchor_posted", { day: "2026-10-30", hash: "abcdef0123456789", entries: 12, txSig: "anchorsig1234" }), fx.cfg, fx.ledger)).toBe(
      "Daily log 2026-10-30 anchored: 12 fills, sha256 abcdef012345..., tx anchorsi....",
    );
    expect(formatEvent(ev("anchor_posted", { day: "2026-10-30", hash: "abcdef0123456789", entries: 2, txSig: "(paper)" }), fx.cfg, fx.ledger)).toBe(
      "Daily log 2026-10-30 anchored: 2 fills, sha256 abcdef012345... (paper).",
    );
    expect(formatEvent(ev("anchor_posted", { day: "2026-10-30", hash: "abcdef0123456789", entries: 2, txSig: null }), fx.cfg, fx.ledger)).toBe(
      "Daily log 2026-10-30 anchored: 2 fills, sha256 abcdef012345... (not on-chain yet).",
    );
    expect(formatEvent(ev("lp_rebalanced", { positionId: "p1", lower: 0.00017, upper: 0.00023, tokens: "1000000000", sol: "2000000000" }), fx.cfg, fx.ledger)).toBe(
      "LP position rebalanced to 0.00017 - 0.00023: 1,000 tokens + 2 SOL.",
    );
  });

  it("formats drafts for approval, skips auto-mode drafts, and links published posts", () => {
    const text = formatEvent(ev("post_drafted", { postId: "0f1e2d3c-0000-4000-8000-000000000000", channel: "x", kind: "daily_recap", text: "Test Token daily recap: ..." }), fx.cfg, fx.ledger)!;
    expect(text).toBe("Draft for X (daily recap), id 0f1e2d3c:\n\nTest Token daily recap: ...\n\nApprove or reject below. Unapproved drafts expire after 24h.");
    expect(formatEvent(ev("post_drafted", { postId: "x", channel: "x", kind: "milestone", text: "t", auto: true }), fx.cfg, fx.ledger)).toBeUndefined();
    expect(formatEvent(ev("post_published", { postId: "p", channel: "x", kind: "milestone", externalId: "179", url: "https://x.com/tenfold/status/179" }), fx.cfg, fx.ledger)).toBe(
      "Posted on X (milestone): https://x.com/tenfold/status/179.",
    );
  });

  it("hands drafted posts to sendEvent so buttons can be attached", async () => {
    const sent: { chatId: string; text: string; type: string }[] = [];
    const poller = new AlertPoller({
      ledger: fx.ledger,
      projects: () => [fx.cfg],
      send: async () => {
        throw new Error("plain send must not be used when sendEvent is given");
      },
      sendEvent: async (chatId, text, e) => {
        sent.push({ chatId, text, type: e.type });
      },
    });
    fx.ledger.insertEvent(ev("post_drafted", { postId: "0f1e2d3c-0000-4000-8000-000000000000", channel: "telegram", kind: "milestone", text: "Day 30." }));
    expect(await poller.tick()).toBe(1);
    expect(sent).toEqual([{ chatId: "424242", text: expect.stringContaining("Draft for Telegram (milestone), id 0f1e2d3c"), type: "post_drafted" }]);
  });
});

describe("marketing buttons", () => {
  it("builds Approve/Reject callback data within Telegram's 64-byte limit", () => {
    const kb = draftKeyboard("0f1e2d3c-0000-4000-8000-000000000000").inline_keyboard[0]!;
    expect(kb.map((b) => ("callback_data" in b ? b.callback_data : ""))).toEqual(["zp:a:0f1e2d3c-0000-4000-8000-000000000000", "zp:r:0f1e2d3c-0000-4000-8000-000000000000"]);
    expect(Buffer.byteLength("zp:a:0f1e2d3c-0000-4000-8000-000000000000")).toBeLessThanOrEqual(64);
    expect(draftPostId(ev("post_drafted", { postId: "0f1e2d3c-0000-4000-8000-000000000000" }))).toBe("0f1e2d3c-0000-4000-8000-000000000000");
    expect(draftPostId(ev("post_drafted", { postId: "0f1e2d3c-0000-4000-8000-000000000000", auto: true }))).toBeUndefined();
    expect(draftPostId(ev("post_published", { postId: "0f1e2d3c-0000-4000-8000-000000000000" }))).toBeUndefined();
  });

  it("decidePost flips the status only for the bound project", () => {
    const p = fx.ledger.insertPost({ projectId: "test", channel: "x", kind: "milestone", text: "m" });
    expect(decidePost(fx.ledger, "other", p.id, true)).toEqual({ status: "wrong_project" });
    expect(decidePost(fx.ledger, "test", "0f1e2d3c-0000-4000-8000-000000000000", true)).toEqual({ status: "missing" });
    expect(decidePost(fx.ledger, "test", p.id, true)).toEqual({ status: "approved" });
    expect(decidePost(fx.ledger, "test", p.id, true)).toEqual({ status: "already", detail: "approved" });
    expect(decidePost(fx.ledger, "test", p.id, false)).toEqual({ status: "rejected" });
    expect(fx.ledger.getPost(p.id)!.status).toBe("rejected");
    expect(decidePost(fx.ledger, "test", p.id, true)).toEqual({ status: "already", detail: "rejected" });
  });
});
