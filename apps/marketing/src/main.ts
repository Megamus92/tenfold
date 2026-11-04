/** Entry point: env, ledger, channels from credentials, the Marketer loop, graceful shutdown. No keys, no signing. */
import { join, dirname } from "node:path";
import { Ledger, loadAllProjects, loadEnv, logger } from "@tenfold/core";
import { LogChannel, TelegramChannel, XClient } from "./channels.js";
import type { Channel } from "./channels.js";
import { Marketer } from "./marketer.js";

function main(): void {
  const env = loadEnv();
  const e = process.env;
  const dryRun = e.TENFOLD_MARKETING_DRY_RUN === "1";
  // allowPaper only takes effect in a dry run: simulated (paper) numbers must never reach real X/Telegram channels.
  const allowPaper = e.TENFOLD_MARKETING_ALLOW_PAPER === "1" && dryRun;
  if (e.TENFOLD_MARKETING_ALLOW_PAPER === "1" && !dryRun) {
    logger.warn("TENFOLD_MARKETING_ALLOW_PAPER is ignored outside a dry run: paper numbers are never published to real channels");
  }

  const channels: Channel[] = [];
  if (dryRun) {
    channels.push(new LogChannel("x"), new LogChannel("telegram", true));
    logger.warn("marketing dry run: posts are logged, nothing is published");
  } else {
    if (env.xApiKey && env.xApiSecret && env.xAccessToken && env.xAccessSecret) {
      channels.push(
        new XClient({
          creds: { consumerKey: env.xApiKey, consumerSecret: env.xApiSecret, token: env.xAccessToken, tokenSecret: env.xAccessSecret },
          baseUrl: e.TENFOLD_X_API_BASE || undefined,
          accountHandle: e.TENFOLD_X_ACCOUNT_HANDLE || undefined,
        }),
      );
    } else {
      logger.warn("X credentials missing (TENFOLD_X_API_KEY/SECRET, TENFOLD_X_ACCESS_TOKEN/SECRET): no X posts");
    }
    const tgToken = e.TENFOLD_MARKETING_BOT_TOKEN || env.telegramBotToken;
    if (tgToken) channels.push(new TelegramChannel({ token: tgToken }));
    else logger.warn("no Telegram bot token (TENFOLD_MARKETING_BOT_TOKEN or TENFOLD_TELEGRAM_BOT_TOKEN): no Telegram channel posts");
  }
  if (channels.length === 0) {
    process.stderr.write("tenfold-marketing: no channel configured; set X credentials, a Telegram bot token, or TENFOLD_MARKETING_DRY_RUN=1\n");
    process.exit(1);
  }

  const ledger = new Ledger(env.dbPath);
  const statePath = e.TENFOLD_MARKETING_STATE_PATH || join(dirname(env.dbPath), "marketing-state.json");
  const marketer = new Marketer({
    ledger,
    channels,
    proofBaseUrl: env.proofBaseUrl,
    statePath,
    allowPaper,
    maxPostsPerDay: e.TENFOLD_MARKETING_MAX_POSTS_PER_DAY ? Number(e.TENFOLD_MARKETING_MAX_POSTS_PER_DAY) : undefined,
    projects: () => {
      try {
        return loadAllProjects();
      } catch (err) {
        logger.error("could not load projects", { error: (err as Error).message });
        return [];
      }
    },
  });
  marketer.start();

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info("marketing stopping", { signal });
    marketer.stop();
    ledger.close();
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("marketing starting", {
    db: env.dbPath,
    state: statePath,
    channels: channels.map((c) => c.name),
    dryRun,
    allowPaper,
    projects: loadAllProjects().filter((p) => p.marketing && p.marketing.mode !== "off").length,
  });
}

try {
  main();
} catch (e) {
  logger.error("marketing crashed", { error: (e as Error).message, stack: (e as Error).stack });
  process.exit(1);
}
