/**
 * Public Telegram bot: any trader pastes a mint and gets the badge, the live limits and the proof link.
 * Read-only on the ledger, one reply per chat every 2 s at most, never a stack trace in a chat.
 */
import { Bot, GrammyError, HttpError } from "grammy";
import type { Context } from "grammy";
import { logger, type Ledger } from "@tenfold/core";
import { formatLookup, formatUnknown, START_TEXT } from "./format.js";
import { lookupMint } from "./lookup.js";
import { extractMints } from "./mint.js";

/** Minimum gap between two replies in the same chat. */
export const REPLY_GAP_MS = 2_000;
/** Mints answered per message; the rest are ignored to keep replies short. */
const MAX_MINTS_PER_MESSAGE = 3;
const PRIVATE_HINT = "Send me a Solana mint address and I tell you whether Tenfold manages it. /start explains.";

/** One reply per key every `gapMs`; stale keys are pruned as it goes. */
export class RateLimiter {
  private readonly last = new Map<string, number>();
  constructor(private readonly gapMs: number = REPLY_GAP_MS) {}

  /** True when a reply may go out now for this key; records the reply when it may. */
  allow(key: string, now: number): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < this.gapMs) return false;
    this.last.set(key, now);
    if (this.last.size > 10_000) for (const [k, t] of this.last) if (now - t >= this.gapMs) this.last.delete(k);
    return true;
  }
}

export interface TraderBotDeps {
  token: string;
  ledger: Ledger;
  /** Public base URL of the proof page, e.g. https://proof.tenfold.xyz */
  proofBaseUrl: string;
  now?: () => number;
  limiter?: RateLimiter;
}

/** Text of a message for one or several mints; `undefined` when the text holds no mint. */
export function replyFor(ledger: Ledger, text: string, proofBaseUrl: string, now: number): string | undefined {
  const mints = extractMints(text).slice(0, MAX_MINTS_PER_MESSAGE);
  if (mints.length === 0) return undefined;
  return mints
    .map((mint) => {
      const v = lookupMint(ledger, mint, now);
      return v ? formatLookup(v, proofBaseUrl) : formatUnknown(mint);
    })
    .join("\n\n");
}

/** Build the bot without starting it, so tests and main share the same wiring. */
export function createTraderBot(deps: TraderBotDeps): Bot<Context> {
  const bot = new Bot<Context>(deps.token);
  const now = deps.now ?? (() => Date.now());
  const limiter = deps.limiter ?? new RateLimiter();

  const send = async (ctx: Context, text: string): Promise<void> => {
    const chatId = ctx.chat ? String(ctx.chat.id) : undefined;
    if (!chatId || !limiter.allow(chatId, now())) return;
    await ctx.reply(text, { link_preview_options: { is_disabled: true } });
  };

  bot.command(["start", "help"], async (ctx) => {
    const payload = ctx.match.trim();
    const reply = payload ? replyFor(deps.ledger, payload, deps.proofBaseUrl, now()) : undefined;
    await send(ctx, reply ?? START_TEXT);
  });

  bot.on("message:text", async (ctx) => {
    const reply = replyFor(deps.ledger, ctx.message.text, deps.proofBaseUrl, now());
    if (reply) await send(ctx, reply);
    else if (ctx.chat.type === "private") await send(ctx, PRIVATE_HINT);
  });

  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) logger.error("trader-bot telegram error", { description: e.description });
    else if (e instanceof HttpError) logger.error("trader-bot network error", { error: String(e.error) });
    else logger.error("trader-bot handler error", { error: e instanceof Error ? e.message : String(e) });
  });

  return bot;
}
