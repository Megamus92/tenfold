/** Entry point: env, ledger, alert poller, scheduled cap raises, Telegram long polling, graceful shutdown. */
import Anthropic from "@anthropic-ai/sdk";
import { Ledger, loadAllProjects, loadEnv, logger } from "@tenfold/core";
import { applyPendingCapRaises } from "./actions.js";
import { AlertPoller } from "./alerts.js";
import { createBot } from "./bot.js";
import { sendAlert } from "./marketing.js";

const CAP_RAISE_CHECK_MS = 3_600_000;

function fail(msg: string): never {
  process.stderr.write(`tenfold-agent: ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.telegramBotToken) fail("TENFOLD_TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and export its token.");
  if (!env.anthropicApiKey) fail("ANTHROPIC_API_KEY is not set. The agent needs it to understand the founder.");

  const ledger = new Ledger(env.dbPath);
  const anthropic = new Anthropic({ apiKey: env.anthropicApiKey });
  const { bot, bindings } = createBot({ token: env.telegramBotToken, ledger, anthropic, model: env.anthropicModel });

  const notifyRaises = async (): Promise<void> => {
    for (const { projectId, pct } of applyPendingCapRaises(ledger)) {
      const chatId = bindings.chatFor(projectId);
      if (chatId) await bot.api.sendMessage(chatId, `Scheduled change applied: the daily sell cap is now ${pct}%.`).catch(() => undefined);
    }
  };
  await notifyRaises();
  const raiseTimer = setInterval(() => void notifyRaises().catch((e: Error) => logger.error("cap raise check failed", { error: e.message })), CAP_RAISE_CHECK_MS);

  const poller = new AlertPoller({
    ledger,
    projects: () => {
      try {
        return loadAllProjects();
      } catch (e) {
        logger.error("could not load projects", { error: (e as Error).message });
        return [];
      }
    },
    send: async (chatId, text) => {
      await bot.api.sendMessage(chatId, text);
    },
    // Drafted marketing posts go out with Approve/Reject buttons; everything else is plain text.
    sendEvent: async (chatId, text, ev) => {
      await sendAlert(bot.api, chatId, text, ev);
    },
  });
  poller.start();

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info("agent stopping", { signal });
    poller.stop();
    clearInterval(raiseTimer);
    void bot
      .stop()
      .catch(() => undefined)
      .finally(() => {
        ledger.close();
        process.exit(0);
      });
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("agent starting", { db: env.dbPath, model: env.anthropicModel, projects: loadAllProjects().length });
  await bot.start({
    drop_pending_updates: true,
    allowed_updates: ["message", "callback_query"],
    onStart: (me) => logger.info("telegram connected", { username: me.username }),
  });
}

main().catch((e: Error) => {
  logger.error("agent crashed", { error: e.message, stack: e.stack });
  process.exit(1);
});
