/**
 * Telegram bot: binds one chat to one project, routes shortcuts to the actions and free text to the Brain,
 * and never lets a stack trace reach the founder.
 */
import { timingSafeEqual } from "node:crypto";
import { Bot, GrammyError, HttpError } from "grammy";
import type { Context } from "grammy";
import { describeMandate, loadAllProjects, loadProject, logger, saveProject } from "@tenfold/core";
import type { Ledger, ProjectConfig } from "@tenfold/core";
import { dailyReport, getStatus, listPosts, pause, resume, runTool } from "./actions.js";
import type { ActionContext, ActionResult, Confirmation } from "./actions.js";
import { Brain, History, systemPromptFor } from "./brain.js";
import type { AnthropicLike, ToolRunner } from "./brain.js";
import { ConfirmStore, confirmKeyboard, confirmText, registerConfirmHandlers } from "./confirm.js";
import { registerMarketingHandlers } from "./marketing.js";
import { MandateWizard } from "./wizard.js";

const APOLOGY = "Something broke on my side. Nothing was changed. Try again in a moment; if it keeps happening, your Tenfold contact can see the log.";
const UNBOUND = "This chat is not linked to a project yet. From the founder's own chat, send /start <projectId> <bindCode> (both are in your onboarding message).";

const HELP = [
  "What I do: run your token's market on the mandate you gave me. The desk places and moves the defense levels, paces the distribution into real buyers within your daily cap, keeps SOL and tokens balanced, and tells you in one line each time it decides something. Every order has a reason and shows in your live feed.",
  "",
  "Shortcuts",
  "/status   where things stand right now",
  "/report   the last 24 hours",
  "/pause    stop all new orders instantly",
  "/resume   start again (asks you to confirm)",
  "/mandate  set or change the mandate in two taps",
  "/posts    marketing drafts waiting for your approval",
  "",
  "Or just talk to me: \"protect the price for now\", \"move 20% of the vault over 30 days\", \"tell me under 0.00015\", \"what does holding 0.0002 cost?\", \"lower the cap to 0.3%\".",
  "Anything that spends or changes a rule, I ask you to confirm with a button first. Pause and cap cuts apply instantly.",
].join("\n");
const MAX_TG_LEN = 4000;

/** chatId -> projectId, built from the project files; the single source of who may control what. */
export class Bindings {
  private readonly byChat = new Map<string, string>();
  private readonly byProject = new Map<string, string>();

  constructor(projects: ProjectConfig[] = []) {
    for (const p of projects) if (p.telegram?.chatId) this.set(p.telegram.chatId, p.id);
  }

  set(chatId: string, projectId: string): void {
    this.byChat.set(chatId, projectId);
    this.byProject.set(projectId, chatId);
  }

  projectFor(chatId: string): string | undefined {
    return this.byChat.get(chatId);
  }

  chatFor(projectId: string): string | undefined {
    return this.byProject.get(projectId);
  }
}

export interface BotDeps {
  token: string;
  ledger: Ledger;
  anthropic: AnthropicLike;
  model: string;
  confirmStore?: ConfirmStore;
  bindings?: Bindings;
}

function chatIdOf(ctx: Context): string | undefined {
  return ctx.chat ? String(ctx.chat.id) : undefined;
}

function chunk(text: string): string[] {
  if (text.length <= MAX_TG_LEN) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > MAX_TG_LEN) {
    const cut = rest.lastIndexOf("\n", MAX_TG_LEN);
    const at = cut > MAX_TG_LEN / 2 ? cut : MAX_TG_LEN;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Build the bot; `start()` is left to the caller so tests can construct it without a network. */
export function createBot(deps: BotDeps): { bot: Bot<Context>; bindings: Bindings; confirmStore: ConfirmStore } {
  const bot = new Bot<Context>(deps.token);
  const bindings = deps.bindings ?? new Bindings(safeLoadAll());
  const confirmStore = deps.confirmStore ?? new ConfirmStore();
  const history = new History();
  const isGroupCtx = (ctx: Context): boolean => ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
  const mayActIn = (ctx: Context): boolean => {
    if (!isGroupCtx(ctx)) return true;
    const chatId = chatIdOf(ctx);
    const projectId = chatId ? bindings.projectFor(chatId) : undefined;
    const allowed = projectId ? (safeLoad(projectId)?.telegram?.allowedUserIds ?? []) : [];
    const userId = ctx.from ? String(ctx.from.id) : undefined;
    return allowed.length > 0 && userId !== undefined && allowed.includes(userId);
  };
  const wizard = new MandateWizard({ ledger: deps.ledger, loadProject, projectFor: (chatId) => bindings.projectFor(chatId), mayAct: mayActIn });
  wizard.register(bot);
  const brains = new Map<string, Brain>();

  // One Brain per project AND per set of baked-in facts, so a mandate change or going live is seen at once.
  const brainFor = (cfg: ProjectConfig): Brain => {
    const key = `${cfg.id}|${cfg.mode}|${JSON.stringify(cfg.mandate ?? null)}|${cfg.rules.withdrawalDelayHours}`;
    let b = brains.get(key);
    if (!b) {
      for (const k of brains.keys()) if (k.startsWith(`${cfg.id}|`)) brains.delete(k);
      b = new Brain(deps.anthropic, deps.model, systemPromptFor(cfg));
      brains.set(key, b);
    }
    return b;
  };

  const actionCtx = (projectId: string): ActionContext => ({ ledger: deps.ledger, cfg: loadProject(projectId), projectId });

  const sendResult = async (ctx: Context, chatId: string, res: ActionResult): Promise<void> => {
    if (res.needsConfirmation) {
      const id = confirmStore.stash(chatId, res.needsConfirmation);
      await ctx.reply(confirmText(res.needsConfirmation.summary), { reply_markup: confirmKeyboard(id) });
      return;
    }
    for (const part of chunk(res.message)) await ctx.reply(part);
  };

  /**
   * Resolve the bound project for this chat or answer with the refusal; undefined means already answered.
   * In a group, only users on the project's allowlist may act; a private chat is the bound founder by construction.
   */
  const bound = async (ctx: Context): Promise<{ chatId: string; projectId: string } | undefined> => {
    const chatId = chatIdOf(ctx);
    if (!chatId) return undefined;
    const projectId = bindings.projectFor(chatId);
    if (!projectId) {
      await ctx.reply(UNBOUND);
      return undefined;
    }
    const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
    if (isGroup) {
      const allowed = safeLoad(projectId)?.telegram?.allowedUserIds ?? [];
      const userId = ctx.from ? String(ctx.from.id) : undefined;
      if (allowed.length === 0) {
        await ctx.reply("This project is bound to a group with no allowed users set. Add telegram.allowedUserIds to the project file, or control it from a private chat.");
        return undefined;
      }
      if (!userId || !allowed.includes(userId)) {
        logger.warn("group member not on the allowlist", { chatId, projectId, userId });
        return undefined; // silent: do not advertise who may act
      }
    }
    return { chatId, projectId };
  };

  bot.command("start", async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (!chatId) return;
    const raw = (ctx.match ?? "").trim();
    const [arg, code] = raw.split(/\s+/, 2);
    const current = bindings.projectFor(chatId);
    if (!arg) {
      await ctx.reply(
        current
          ? `This chat runs "${current}". Ask me anything about it, or use /status, /report, /pause, /resume. /help lists everything.`
          : "I am Tenfold, the market-making desk for your token. Link this chat to your project with /start <projectId> <bindCode> (both are in your onboarding message).",
      );
      return;
    }
    if (!/^[a-z0-9-]{2,40}$/.test(arg)) {
      await ctx.reply("That does not look like a project id: lowercase letters, digits and dashes only.");
      return;
    }
    if (current && current !== arg) {
      await ctx.reply(`This chat already runs "${current}". One project per chat: open a separate chat for another token.`);
      return;
    }
    const owner = bindings.chatFor(arg);
    if (owner && owner !== chatId) {
      await ctx.reply(`"${arg}" is already run from another chat. Only that chat can change it; ask your Tenfold contact if that is wrong.`);
      return;
    }
    let cfg: ProjectConfig;
    try {
      cfg = loadProject(arg);
    } catch {
      await ctx.reply(`I do not know a project called "${arg}". Check the id in your onboarding message.`);
      return;
    }
    if (cfg.telegram?.chatId && cfg.telegram.chatId !== chatId) {
      bindings.set(cfg.telegram.chatId, cfg.id);
      await ctx.reply(`"${arg}" is already run from another chat. Only that chat can change it; ask your Tenfold contact if that is wrong.`);
      return;
    }
    // Fresh bind: require the project's bind code so a chat that merely guesses the id cannot claim it.
    const binding = cfg.telegram?.chatId !== chatId;
    if (binding && cfg.bindCode) {
      if (!code) {
        await ctx.reply(`"${arg}" needs its bind code: /start ${arg} <bindCode>. It is in your onboarding message; it proves this chat is the founder's.`);
        return;
      }
      if (!timingSafeEqualStr(code, cfg.bindCode)) {
        logger.warn("bind code mismatch", { chatId, projectId: cfg.id });
        await ctx.reply("That bind code is not right. Copy it exactly from your onboarding message.");
        return;
      }
    } else if (binding && !cfg.bindCode) {
      logger.warn("project bound without a bind code; set one at onboarding before handling real funds", { projectId: cfg.id });
    }
    if (cfg.telegram?.chatId !== chatId) {
      cfg.telegram = { chatId };
      saveProject(cfg);
      deps.ledger.upsertProject(cfg);
      deps.ledger.enqueueCommand(cfg.id, "reload");
      deps.ledger.insertEvent({ type: "config_changed", projectId: cfg.id, ts: Date.now(), data: { source: "agent", telegram: { chatId } } });
    }
    bindings.set(chatId, cfg.id);
    history.clear(chatId);
    logger.info("chat bound", { chatId, projectId: cfg.id });
    await ctx.reply(
      [
        `Linked to ${cfg.name}${cfg.mode === "paper" ? " (paper mode: real prices, simulated fills, no real money moves)" : ""}.`,
        cfg.mandate
          ? `Mandate: ${describeMandate(cfg.mandate)}. The desk runs it on its own; you get one line per decision and a report every day. You never have to answer unless I say "Your call".`
          : "Two taps and the desk runs on its own. /mandate restarts this any time.",
        "Anything you ask me to change, I confirm with a button first. Pause is instant, any time.",
        "Send /status to see where things stand, or just talk to me.",
      ].join("\n"),
    );
    if (!cfg.mandate) await wizard.start(ctx, chatId, cfg.id);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP);
  });

  bot.command("mandate", async (ctx) => {
    const b = await bound(ctx);
    if (!b) return;
    await wizard.start(ctx, b.chatId, b.projectId);
  });

  bot.command("status", async (ctx) => {
    const b = await bound(ctx);
    if (!b) return;
    await sendResult(ctx, b.chatId, getStatus(actionCtx(b.projectId)));
  });

  bot.command("report", async (ctx) => {
    const b = await bound(ctx);
    if (!b) return;
    await sendResult(ctx, b.chatId, dailyReport(actionCtx(b.projectId)));
  });

  bot.command("pause", async (ctx) => {
    const b = await bound(ctx);
    if (!b) return;
    await sendResult(ctx, b.chatId, pause(actionCtx(b.projectId)));
  });

  bot.command("resume", async (ctx) => {
    const b = await bound(ctx);
    if (!b) return;
    await sendResult(ctx, b.chatId, resume(actionCtx(b.projectId)));
  });

  // In a group, only allowlisted users may tap Yes/No; in a private chat the bound founder is the only one there.
  registerConfirmHandlers(bot, confirmStore, mayActIn);

  // Marketing: /posts lists the drafts waiting for a decision; the Approve/Reject buttons under a draft alert flip
  // the post's status in the ledger (same group allowlist rule as the Yes/No buttons).
  bot.command("posts", async (ctx) => {
    const b = await bound(ctx);
    if (!b) return;
    await sendResult(ctx, b.chatId, listPosts(actionCtx(b.projectId), "draft"));
  });
  registerMarketingHandlers(bot, {
    ledger: deps.ledger,
    projectFor: (chatId) => bindings.projectFor(chatId),
    allowedUserIds: (projectId) => safeLoad(projectId)?.telegram?.allowedUserIds ?? [],
  });

  bot.on("message:text", async (ctx) => {
    const b = await bound(ctx);
    if (!b) return;
    const text = ctx.message.text.trim();
    if (!text) return;
    const cfg = loadProject(b.projectId);
    const runner: ToolRunner = {
      run: (call) => runTool({ ledger: deps.ledger, cfg: loadProject(b.projectId), projectId: b.projectId }, call),
      stash: (c: Confirmation) => confirmStore.stash(b.chatId, c),
    };
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    const reply = await brainFor(cfg).respond(history.get(b.chatId), text, runner);
    if (reply.text) for (const part of chunk(reply.text)) await ctx.reply(part);
    if (reply.pendingConfirmation) {
      await ctx.reply(confirmText(reply.pendingConfirmation.summary), { reply_markup: confirmKeyboard(reply.pendingConfirmation.id) });
    }
  });

  bot.on("message", async (ctx) => {
    const b = await bound(ctx);
    if (!b) return;
    await ctx.reply("I only read text for now. Type what you want in plain words.");
  });

  bot.catch(async (err) => {
    const e = err.error;
    const fields: Record<string, unknown> = { update: err.ctx.update.update_id, chatId: chatIdOf(err.ctx) };
    if (e instanceof GrammyError) fields.telegram = e.description;
    else if (e instanceof HttpError) fields.http = maskToken(String(e.error));
    else if (e instanceof Error) {
      fields.error = e.message;
      fields.stack = e.stack;
    } else fields.error = String(e);
    logger.error("bot handler failed", fields);
    try {
      await err.ctx.reply(APOLOGY);
    } catch {
      // the chat may be gone; nothing else to do
    }
  });

  return { bot, bindings, confirmStore };
}

/** A Telegram API URL embeds the bot token; never let it reach a log line. */
export function maskToken(text: string): string {
  return text.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<token>");
}

/** Constant-time string compare that never throws on length mismatch. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function safeLoad(projectId: string): ProjectConfig | undefined {
  try {
    return loadProject(projectId);
  } catch {
    return undefined;
  }
}

function safeLoadAll(): ProjectConfig[] {
  try {
    return loadAllProjects();
  } catch (e) {
    logger.error("could not load projects", { error: (e as Error).message });
    return [];
  }
}
