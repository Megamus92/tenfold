/**
 * Confirmation flow: a change that spends or alters a parameter is parked here, shown to the founder with
 * Yes/No buttons, and applied only on Yes. Entries expire after 10 minutes. Nothing here is persisted.
 */
import { randomBytes } from "node:crypto";
import { InlineKeyboard } from "grammy";
import type { Bot, Context } from "grammy";
import { logger } from "@tenfold/core";
import type { ActionResult, Confirmation } from "./actions.js";

export const CONFIRM_TTL_MS = 10 * 60_000;
const PREFIX = "zc";

interface Pending {
  chatId: string;
  confirmation: Confirmation;
  expiresAt: number;
}

export class ConfirmStore {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Park a confirmation for `chatId`; returns the short id used in the button callback data. */
  stash(chatId: string, confirmation: Confirmation): string {
    this.sweep();
    const id = randomBytes(4).toString("hex");
    this.pending.set(id, { chatId, confirmation, expiresAt: this.now() + CONFIRM_TTL_MS });
    return id;
  }

  /** Remove and return the confirmation if it exists, belongs to `chatId` and has not expired. */
  take(id: string, chatId: string): Confirmation | "expired" | "missing" | "wrong_chat" {
    const p = this.pending.get(id);
    if (!p) return "missing";
    if (p.chatId !== chatId) return "wrong_chat";
    this.pending.delete(id);
    if (p.expiresAt <= this.now()) return "expired";
    return p.confirmation;
  }

  /** Apply by id: runs the closure on Yes, drops it on No. */
  resolve(id: string, chatId: string, yes: boolean): { status: "applied" | "declined" | "expired" | "missing" | "wrong_chat"; result?: ActionResult } {
    const c = this.take(id, chatId);
    if (typeof c === "string") return { status: c };
    if (!yes) return { status: "declined" };
    return { status: "applied", result: c.apply() };
  }

  size(): number {
    this.sweep();
    return this.pending.size;
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, p] of this.pending) if (p.expiresAt <= t) this.pending.delete(id);
  }
}

/** The two-button keyboard under a "Confirm: ..." message. */
export function confirmKeyboard(id: string): InlineKeyboard {
  return new InlineKeyboard().text("Yes, do it", `${PREFIX}:y:${id}`).text("No, cancel", `${PREFIX}:n:${id}`);
}

export function confirmText(summary: string): string {
  return `Before I do this, confirm:\n${summary}\n\nNothing happens until you tap Yes. This expires in 10 minutes.`;
}

/** Wire the Yes/No callback handlers onto the bot. `mayAct` gates who can tap in a group (the project's allowlist). */
export function registerConfirmHandlers(bot: Bot<Context>, store: ConfirmStore, mayAct?: (ctx: Context) => boolean): void {
  bot.callbackQuery(new RegExp(`^${PREFIX}:(y|n):([0-9a-f]{8})$`), async (ctx) => {
    if (mayAct && !mayAct(ctx)) {
      await ctx.answerCallbackQuery({ text: "Only the project's allowed users can confirm here." });
      return;
    }
    const match = ctx.match;
    const yes = match[1] === "y";
    const id = match[2] ?? "";
    const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id ?? "");
    const outcome = store.resolve(id, chatId, yes);
    let reply: string;
    switch (outcome.status) {
      case "applied":
        reply = outcome.result?.ok ? `Confirmed. ${outcome.result.message}` : `Could not apply it: ${outcome.result?.message ?? "unknown error"}. Nothing changed.`;
        break;
      case "declined":
        reply = "Cancelled. Nothing changed.";
        break;
      case "expired":
        reply = "That confirmation expired after 10 minutes. Nothing changed; ask again if you still want it.";
        break;
      case "wrong_chat":
        reply = "This confirmation belongs to another chat. Nothing changed."; 
        break;
      default:
        reply = "That confirmation is no longer pending. Nothing changed.";
    }
    logger.info("confirmation", { id, yes, status: outcome.status, chatId });
    await ctx.answerCallbackQuery();
    try {
      const original = ctx.callbackQuery.message;
      if (original && "text" in original && original.text) {
        await ctx.editMessageText(`${original.text}\n\n${reply}`);
        return;
      }
    } catch (e) {
      logger.warn("edit after confirm failed", { error: (e as Error).message });
    }
    await ctx.reply(reply);
  });
}
