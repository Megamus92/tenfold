/**
 * Marketing glue for the founder bot: a draft written by the marketing process arrives as a post_drafted event;
 * the alert poller sends it with Approve/Reject buttons, and the handlers here flip the post's status in the
 * ledger. The marketing process publishes `approved` posts; the agent never talks to X or to channels itself.
 */
import { InlineKeyboard } from "grammy";
import type { Api, Bot, Context } from "grammy";
import { logger } from "@tenfold/core";
import type { EngineEvent, Ledger } from "@tenfold/core";
import { shortPostId } from "./actions.js";

const PREFIX = "zp";
const POST_ID = /^[0-9a-f-]{36}$/;

/** Approve / Reject buttons for a drafted post. callback_data stays under Telegram's 64-byte limit (41 bytes). */
export function draftKeyboard(postId: string): InlineKeyboard {
  return new InlineKeyboard().text("✅ Approve", `${PREFIX}:a:${postId}`).text("❌ Reject", `${PREFIX}:r:${postId}`);
}

/** The post id of a post_drafted event that still needs the founder's decision, if any. */
export function draftPostId(ev: EngineEvent): string | undefined {
  if (ev.type !== "post_drafted") return undefined;
  const d = ev.data ?? {};
  if (d["auto"] === true) return undefined;
  const id = d["postId"];
  return typeof id === "string" && POST_ID.test(id) ? id : undefined;
}

/** Sender for the alert poller: plain text, plus buttons when the event is a draft waiting for approval. */
export function sendAlert(api: Api, chatId: string, text: string, ev: EngineEvent): Promise<unknown> {
  const postId = draftPostId(ev);
  if (postId) return api.sendMessage(chatId, text, { reply_markup: draftKeyboard(postId) });
  return api.sendMessage(chatId, text);
}

export type Decision = "approved" | "rejected" | "already" | "missing" | "wrong_project";

/** Flip a post's status on the founder's tap. Pure ledger work, shared by the buttons and the tools. */
export function decidePost(ledger: Ledger, projectId: string, postId: string, approve: boolean): { status: Decision; detail?: string } {
  const post = ledger.getPost(postId);
  if (!post) return { status: "missing" };
  if (post.projectId !== projectId) return { status: "wrong_project" };
  if (approve) {
    if (post.status === "approved" || post.status === "posted") return { status: "already", detail: post.status };
    if (post.status === "rejected") return { status: "already", detail: "rejected" };
    ledger.updatePost(postId, { status: "approved", error: "" });
    return { status: "approved" };
  }
  if (post.status === "posted") return { status: "already", detail: "posted" };
  if (post.status === "rejected") return { status: "already", detail: "rejected" };
  ledger.updatePost(postId, { status: "rejected", error: "rejected by founder" });
  return { status: "rejected" };
}

export interface MarketingHandlerDeps {
  ledger: Ledger;
  /** The project bound to a chat; undefined when the chat controls nothing. */
  projectFor: (chatId: string) => string | undefined;
  /** The project's Telegram allowlist, for group chats. Same rule as the Yes/No buttons: in a group only listed users may tap. */
  allowedUserIds: (projectId: string) => string[];
}

/** In a private chat the bound founder is the only one there; in a group the tap must come from the allowlist. */
export function mayDecide(ctx: Context, projectId: string | undefined, allowedUserIds: (projectId: string) => string[]): boolean {
  const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
  if (!isGroup) return true;
  if (!projectId) return false;
  const allowed = allowedUserIds(projectId);
  const userId = ctx.from ? String(ctx.from.id) : undefined;
  return allowed.length > 0 && userId !== undefined && allowed.includes(userId);
}

/** Wire the Approve/Reject callbacks onto the bot. */
export function registerMarketingHandlers(bot: Bot<Context>, deps: MarketingHandlerDeps): void {
  bot.callbackQuery(new RegExp(`^${PREFIX}:(a|r):([0-9a-f-]{36})$`), async (ctx) => {
    const approve = ctx.match[1] === "a";
    const postId = ctx.match[2] ?? "";
    const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id ?? "");
    const projectId = deps.projectFor(chatId);
    if (!mayDecide(ctx, projectId, deps.allowedUserIds)) {
      await ctx.answerCallbackQuery({ text: "You are not allowed to decide for this project." });
      return;
    }
    let reply: string;
    if (!projectId) reply = "This chat is not bound to a project.";
    else {
      const outcome = decidePost(deps.ledger, projectId, postId, approve);
      switch (outcome.status) {
        case "approved":
          reply = `Approved. The marketing process publishes post ${shortPostId(postId)} within about a minute; you will get the link here.`;
          break;
        case "rejected":
          reply = `Rejected. Post ${shortPostId(postId)} will not be published.`;
          break;
        case "already":
          reply = `Post ${shortPostId(postId)} is already ${outcome.detail}.`;
          break;
        case "wrong_project":
          reply = "That post belongs to another project.";
          break;
        default:
          reply = "That post no longer exists.";
      }
      logger.info("post decision", { postId, approve, status: outcome.status, chatId, projectId });
    }
    await ctx.answerCallbackQuery();
    try {
      const original = ctx.callbackQuery.message;
      if (original && "text" in original && original.text) {
        await ctx.editMessageText(`${original.text}\n\n${reply}`);
        return;
      }
    } catch (e) {
      logger.warn("edit after post decision failed", { error: (e as Error).message });
    }
    await ctx.reply(reply);
  });
}
