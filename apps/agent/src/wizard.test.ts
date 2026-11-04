import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Bot } from "grammy";
import type { Context } from "grammy";
import { loadProject } from "@tenfold/core";
import { MandateWizard, PROFILE_LABELS, Q_PROFILE, SHARE_PRESETS, profileKeyboard, shareKeyboard } from "./wizard.js";
import { CHAT, fixture } from "./testkit.js";
import type { Fixture } from "./testkit.js";

let fx: Fixture;
beforeEach(() => {
  fx = fixture();
});
afterEach(() => fx.cleanup());

/** An offline grammY bot: every API call is recorded and answered with a plausible result. */
function offlineBot(): { bot: Bot<Context>; calls: { method: string; payload: Record<string, unknown> }[] } {
  const bot = new Bot<Context>("1:offline", {
    botInfo: { id: 1, is_bot: true, first_name: "tenfold", username: "tenfold_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false },
  });
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result = method === "sendMessage" || method === "editMessageText" ? { message_id: calls.length, date: 0, chat: { id: Number(CHAT), type: "private" }, text: "x" } : true;
    return { ok: true, result } as never;
  });
  return { bot, calls };
}

function tap(data: string, text = Q_PROFILE) {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    callback_query: { id: "cb", from: { id: 7, is_bot: false, first_name: "founder" }, chat_instance: "ci", data, message: { message_id: 10, date: 0, chat: { id: Number(CHAT), type: "private" as const }, text } },
  };
}

describe("mandate wizard", () => {
  it("keyboards stay within Telegram's 64-byte callback limit and offer every preset", () => {
    const flat = (kb: ReturnType<typeof profileKeyboard>) => kb.inline_keyboard.flat();
    for (const b of [...flat(profileKeyboard()), ...flat(shareKeyboard())]) {
      const data = (b as { callback_data?: string }).callback_data ?? "";
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    }
    expect(flat(profileKeyboard()).map((b) => b.text)).toEqual(Object.values(PROFILE_LABELS));
    expect(flat(shareKeyboard())).toHaveLength(SHARE_PRESETS.length + 1);
  });

  it("two taps set the mandate, apply it to the project file and tell the founder what happens next", async () => {
    const { bot, calls } = offlineBot();
    const wizard = new MandateWizard({ ledger: fx.ledger, loadProject, projectFor: () => "test", now: () => 1_700_000_000_000 });
    wizard.register(bot);
    await bot.handleUpdate(tap("tm:p:balanced"));
    expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery", "editMessageText", "sendMessage"]);
    expect(String(calls[2]!.payload.text)).toMatch(/How much of the vault/);
    // a forged callback that is not one of the keyboard's presets never reaches the mandate
    await bot.handleUpdate(tap("tm:h:50:60"));
    expect(loadProject("test").mandate).toBeUndefined();
    expect(String(calls[calls.length - 1]!.payload.text)).toMatch(/Pick one of the options/);
    await bot.handleUpdate(tap("tm:h:50:100"));
    const cfg = loadProject("test");
    expect(cfg.mandate).toMatchObject({ profile: "balanced", distributePct: 50, horizonDays: 100, autonomy: "auto", startedAt: 1_700_000_000_000 });
    expect(cfg.strategy.distribution.enabled).toBe(true);
    expect(cfg.strategy.distribution.pctOfVaultPerDay).toBeCloseTo(0.5, 5); // 50/100 = the 0.5% cap exactly
    const last = String(calls[calls.length - 1]!.payload.text);
    expect(last).toMatch(/^Mandate set: hold reasonable levels/);
    expect(last).not.toMatch(/above the 0.5% cap/);
    expect(fx.ledger.pendingCommands().some((c) => c.type === "reload")).toBe(true);
  });

  it("a share tap without a profile asks to start again, and an expired wizard restarts cleanly", async () => {
    let now = 1_700_000_000_000;
    const { bot, calls } = offlineBot();
    const wizard = new MandateWizard({ ledger: fx.ledger, loadProject, projectFor: () => "test", now: () => now });
    wizard.register(bot);
    await bot.handleUpdate(tap("tm:h:10:30"));
    expect(calls[0]!.method).toBe("answerCallbackQuery");
    expect(String(calls[0]!.payload.text)).toMatch(/Start again/);
    expect(loadProject("test").mandate).toBeUndefined();
    await bot.handleUpdate(tap("tm:p:protect"));
    now += 16 * 60_000; // expired
    expect(wizard.state(CHAT)).toBeUndefined();
    await bot.handleUpdate(tap("tm:h:10:30"));
    expect(loadProject("test").mandate).toBeUndefined();
  });

  it("'only defend' sets a zero share: distribution off, defense derived from the profile", async () => {
    const { bot } = offlineBot();
    const wizard = new MandateWizard({ ledger: fx.ledger, loadProject, projectFor: () => "test" });
    wizard.register(bot);
    await bot.handleUpdate(tap("tm:p:protect"));
    await bot.handleUpdate(tap("tm:h:0:30"));
    const cfg = loadProject("test");
    expect(cfg.mandate?.profile).toBe("protect");
    expect(cfg.mandate?.distributePct).toBe(0);
    expect(cfg.strategy.distribution.enabled).toBe(false);
    expect(cfg.strategy.defense.enabled).toBe(true);
  });

  it("in a group, only allowlisted users may tap", async () => {
    const { bot, calls } = offlineBot();
    const wizard = new MandateWizard({ ledger: fx.ledger, loadProject, projectFor: () => "test", mayAct: () => false });
    wizard.register(bot);
    await bot.handleUpdate(tap("tm:p:balanced"));
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.payload.text)).toMatch(/allowed users/);
  });
});
