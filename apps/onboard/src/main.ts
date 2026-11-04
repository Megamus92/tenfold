/** Entry point: open the shared ledger and serve the onboarding page. */
import { Ledger, loadEnv, logger } from "@tenfold/core";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.keystorePassword) {
    logger.warn("TENFOLD_KEYSTORE_PASSWORD is empty: the onboarding page will refuse to create projects until it is set");
  }

  const ledger = new Ledger(env.dbPath);
  const app = buildServer({
    ledger,
    keystoreDir: env.keystoreDir,
    keystorePassword: env.keystorePassword,
    proofBaseUrl: env.proofBaseUrl,
  });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info("onboard: shutting down", { signal });
    try {
      await app.close();
    } finally {
      ledger.close();
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: env.onboardPort, host: "0.0.0.0" });
  logger.info("onboard: listening", { port: env.onboardPort, baseUrl: env.onboardBaseUrl, keystore: env.keystoreDir, db: env.dbPath });
  process.stdout.write(`Tenfold onboarding: ${env.onboardBaseUrl}\n`);
}

main().catch((err: unknown) => {
  logger.error("onboard: fatal", { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
