/** Entry point: open the shared ledger, register the projects on disk, serve the proof pages. */
import { Ledger, loadAllProjects, loadEnv, logger } from "@tenfold/core";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.proofSigningSecret) logger.warn("TENFOLD_PROOF_SIGNING_SECRET is empty: /verify signatures are not meaningful");

  const ledger = new Ledger(env.dbPath);
  // The engine upserts too; doing it here means the proof page lists projects even before the engine has started.
  const projects = loadAllProjects();
  for (const cfg of projects) ledger.upsertProject(cfg);
  logger.info("proof: projects registered", { count: projects.length, db: env.dbPath });

  const app = buildServer({ ledger, signingSecret: env.proofSigningSecret });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info("proof: shutting down", { signal });
    try {
      await app.close();
    } finally {
      ledger.close();
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: env.proofPort, host: "0.0.0.0" });
  logger.info("proof: listening", { port: env.proofPort, baseUrl: env.proofBaseUrl });
  process.stdout.write(`Tenfold proof page: ${env.proofBaseUrl}\n`);
}

main().catch((err: unknown) => {
  logger.error("proof: fatal", { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
