/**
 * Mandate wizard: the three-tap onboarding. Profile → share and horizon → done, with an optional typed alert line.
 * The taps ARE the confirmation (each one is a deliberate choice), so the mandate is applied on the last tap.
 * State lives in memory per chat and expires after 15 minutes; nothing here touches keys or orders.
 */
import { InlineKeyboard } from "grammy";
import type { Bot, Context } from "grammy";
import { describeMandate, logger } from "@tenfold/core";
import type { Ledger, MandateProfile, ProjectConfig } from "@tenfold/core";
import { setMandate } from "./actions.js";

const PREFIX = "tm";
export const WIZARD_TTL_MS = 15 * 60_000;

export const PROFILE_LABELS: Record<MandateProfile, string> = { protect: "Protect the price", balanced: "Balanced", distribute: "Distribute supply" };
/** Share/horizon presets offered after the profile; the founder can type anything else later. */
export const SHARE_PRESETS: { pct: number; days: number }[] = [
  { pct: 10, days: 30 },
  { pct: 25, days: 60 },
  { pct: 50, days: 100 },
  { pct: 100, days: 200 },
];

interface WizardState {
  projectId: string;
  profile?: MandateProfile;
  startedAt: number;
}

export interface WizardDeps {
  ledger: Ledger;
  loadProject: (id: string) => ProjectConfig;
  projectFor: (chatId: string) => string | undefined;
  /** In a group only allowlisted users may tap; private chats always may. */
  mayAct?: (ctx: Context) => boolean;
  now?: () => number;
}

export function profileKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(PROFILE_LABELS.protect, `${PREFIX}:p:protect`)
    .row()
    .text(PROFILE_LABELS.balanced, `${PREFIX}:p:balanced`)
    .row()
    .text(PROFILE_LABELS.distribute, `${PREFIX}:p:distribute`);
}

export function shareKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  SHARE_PRESETS.forEach((s, i) => {
    kb.text(`${s.pct}% over ${s.days} d`, `${PREFIX}:h:${s.pct}:${s.days}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text("Only defend, sell nothing", `${PREFIX}:h:0:30`);
  return kb;
}

export const Q_PROFILE = "What matters most right now?\n\nProtect: hold the price first. Levels close under the price, slow selling.\nBalanced: reasonable levels, steady selling into real demand.\nDistribute: move supply first. Lighter defense, further down.";
export const Q_SHARE = "How much of the vault should go to buyers, and over how long? The desk turns this into a daily pace, never above your daily sell cap.";

export class MandateWizard {
  private readonly states = new Map<string, WizardState>();
  private readonly now: () => number;

  constructor(private readonly deps: WizardDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** First question. Call after a successful bind, or on /mandate. */
  async start(ctx: Context, chatId: string, projectId: string): Promise<void> {
    this.states.set(chatId, { projectId, startedAt: this.now() });
    await ctx.reply(Q_PROFILE, { reply_markup: profileKeyboard() });
  }

  /** The state for a chat, or undefined when none or expired. */
  state(chatId: string): WizardState | undefined {
    const s = this.states.get(chatId);
    if (!s) return undefined;
    if (this.now() - s.startedAt > WIZARD_TTL_MS) {
      this.states.delete(chatId);
      return undefined;
    }
    return s;
  }

  register(bot: Bot<Context>): void {
    bot.callbackQuery(new RegExp(`^${PREFIX}:p:(protect|balanced|distribute)$`), async (ctx) => {
      if (this.deps.mayAct && !this.deps.mayAct(ctx)) {
        await ctx.answerCallbackQuery({ text: "Only the project's allowed users can set the mandate." });
        return;
      }
      const chatId = String(ctx.chat?.id ?? "");
      const s = this.state(chatId) ?? this.fresh(chatId);
      if (!s) {
        await ctx.answerCallbackQuery({ text: "This chat is not linked to a project." });
        return;
      }
      s.profile = ctx.match[1] as MandateProfile;
      await ctx.answerCallbackQuery();
      await this.edit(ctx, `${Q_PROFILE}\n\n→ ${PROFILE_LABELS[s.profile]}`);
      await ctx.reply(Q_SHARE, { reply_markup: shareKeyboard() });
    });

    bot.callbackQuery(new RegExp(`^${PREFIX}:h:(\\d{1,3}):(\\d{1,3})$`), async (ctx) => {
      if (this.deps.mayAct && !this.deps.mayAct(ctx)) {
        await ctx.answerCallbackQuery({ text: "Only the project's allowed users can set the mandate." });
        return;
      }
      const chatId = String(ctx.chat?.id ?? "");
      const s = this.state(chatId);
      if (!s?.profile) {
        await ctx.answerCallbackQuery({ text: "Start again with /mandate." });
        return;
      }
      const pct = Number(ctx.match[1]);
      const days = Number(ctx.match[2]);
      // Only the keyboard's own presets are accepted: a forged callback never reaches the mandate.
      const preset = (pct === 0 && days === 30) || SHARE_PRESETS.some((x) => x.pct === pct && x.days === days);
      if (!preset) {
        await ctx.answerCallbackQuery({ text: "Pick one of the options." });
        return;
      }
      await ctx.answerCallbackQuery();
      await this.edit(ctx, `${Q_SHARE}\n\n→ ${pct === 0 ? "only defend" : `${pct}% over ${days} days`}`);
      const cfg = this.deps.loadProject(s.projectId);
      const res = setMandate({ ledger: this.deps.ledger, cfg, projectId: s.projectId, now: this.now() }, { profile: s.profile, horizonDays: days, distributePct: pct, autonomy: cfg.mandate?.autonomy ?? "auto" });
      const applied = res.needsConfirmation ? res.needsConfirmation.apply() : res;
      this.states.delete(chatId);
      if (!applied.ok) {
        await ctx.reply(`Could not set the mandate: ${applied.message}`);
        return;
      }
      const fresh = this.deps.loadProject(s.projectId);
      const summary = fresh.mandate ? describeMandate(fresh.mandate) : "set";
      const note = res.needsConfirmation?.summary.match(/Note: .*?tell you\./)?.[0] ?? "";
      logger.info("mandate set from wizard", { chatId, projectId: s.projectId, profile: s.profile, pct, days });
      await ctx.reply(
        [
          `Mandate set: ${summary}.`,
          note ? note + " Say \"extend the horizon\" or \"raise the cap\" and I handle it." : "",
          "The desk takes it from here: it places and moves the levels, paces the selling and tells you in one line each time. You never have to answer unless I say \"Your call\".",
          "Optional: a price under which you want to be told, e.g. \"tell me under 0.00012\". And /status any time.",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    });
  }

  private fresh(chatId: string): WizardState | undefined {
    const projectId = this.deps.projectFor(chatId);
    if (!projectId) return undefined;
    const s: WizardState = { projectId, startedAt: this.now() };
    this.states.set(chatId, s);
    return s;
  }

  private async edit(ctx: Context, text: string): Promise<void> {
    try {
      const original = ctx.callbackQuery?.message;
      if (original && "text" in original) await ctx.editMessageText(text);
    } catch (e) {
      logger.warn("wizard edit failed", { error: (e as Error).message });
    }
  }
}
