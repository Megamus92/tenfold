/** Entry point: env checks, read-only ledger, Telegram long polling, graceful shutdown. */
import { Ledger, loadEnv, logger } from "@tenfold/core";
import { createTraderBot } from "./bot.js";

function fail(msg: string): never {
  process.stderr.write(`tenfold-trader-bot: ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.traderBotToken) fail("TENFOLD_TRADER_BOT_TOKEN is not set. Create a separate public bot with @BotFather and export its token.");
  if (!process.env.TENFOLD_PROOF_BASE_URL) logger.warn("TENFOLD_PROOF_BASE_URL is not set: proof links will point at localhost");
  if (!/^https?:\/\//.test(env.proofBaseUrl)) fail(`TENFOLD_PROOF_BASE_URL must be an http(s) URL, got "${env.proofBaseUrl}"`);

  const ledger = new Ledger(env.dbPath);
  const bot = createTraderBot({ token: env.traderBotToken, ledger, proofBaseUrl: env.proofBaseUrl });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info("trader-bot stopping", { signal });
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

  logger.info("trader-bot starting", { db: env.dbPath, proofBaseUrl: env.proofBaseUrl });
  await bot.start({
    drop_pending_updates: true,
    allowed_updates: ["message"],
    onStart: (me) => logger.info("trader-bot connected", { username: me.username }),
  });
}

main().catch((e: Error) => {
  logger.error("trader-bot crashed", { error: e.message, stack: e.stack });
  process.exit(1);
});
