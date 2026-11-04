/**
 * Engine entry point. Opens the ledger, loads every project from the projects dir, builds a feed and an executor
 * per project according to its mode, starts one ProjectRunner each, rescans the projects dir every minute for
 * new files and shuts down cleanly on SIGINT/SIGTERM.
 *
 *  paper  + TENFOLD_RPC_URL set   -> JupiterFeed (real prices) + PaperExecutor (simulated fills)
 *  paper  + TENFOLD_SIM=1         -> SimFeed (random walk) + PaperExecutor
 *  live                        -> JupiterFeed + JupiterExecutor with the Signer (RPC send path; Jito bundles carry no tip yet)
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Ledger, LAMPORTS_PER_SOL, loadAllProjects, loadEnv, logger, secureRng, seededRng, solToLamports, tokensToBase } from "@tenfold/core";
import type { Env, ProjectConfig, Rng } from "@tenfold/core";
import { JupiterExecutor, JupiterFeed, PaperExecutor, SimFeed, Signer, makeRpc } from "@tenfold/exec";
import type { Connection } from "@solana/web3.js";
import { ProjectRunner } from "./runner.js";
import type { Executor, PriceFeed, RunnerDeps } from "./runner.js";
import { Maintenance } from "./maintenance.js";

const RESCAN_MS = 60_000;
const TICK_MS = 10_000;
const SIM_TICK_MS = 500;

const engineRng: Rng = secureRng;

interface Wiring {
  feed: PriceFeed;
  executor: Executor;
  tickMs: number;
  afterFill?: RunnerDeps["afterFill"];
}

/** Lazily shared RPC connection and signer, created on first use. */
class Shared {
  private rpc?: Connection;
  private signer?: Signer;
  constructor(private readonly env: Env) {}
  connection(): Connection {
    if (!this.rpc) this.rpc = makeRpc(this.env.rpcUrl);
    return this.rpc;
  }
  signerFor(): Signer {
    if (!this.signer) {
      if (!this.env.keystorePassword) throw new Error("TENFOLD_KEYSTORE_PASSWORD is required for live mode");
      this.signer = new Signer(this.env.keystoreDir, this.env.keystorePassword);
    }
    return this.signer;
  }
}

/** Choose feed and executor for a project from its mode and the environment. */
function wire(cfg: ProjectConfig, env: Env, shared: Shared): Wiring {
  const sim = process.env.TENFOLD_SIM === "1";
  if (cfg.mode === "live") {
    const rpc = shared.connection();
    const signer = shared.signerFor();
    if (!signer.has(cfg.walletPubkey)) throw new Error(`no keystore entry for wallet ${cfg.walletPubkey}`);
    return {
      feed: new JupiterFeed(rpc),
      executor: new JupiterExecutor(rpc, signer, {
        priorityFeeMicroLamports: env.priorityFeeMicroLamports,
        // Bundles are used when TENFOLD_JITO_URL is set (the tip instruction is now appended); empty = normal RPC send path.
        jitoUrl: env.jitoUrl,
        jitoTipLamports: env.jitoTipLamports,
      }),
      tickMs: TICK_MS,
    };
  }
  // paper
  if (process.env.TENFOLD_RPC_URL && !sim) {
    return { feed: new JupiterFeed(shared.connection()), executor: new PaperExecutor(), tickMs: TICK_MS };
  }
  if (!sim) {
    logger.warn("paper project without TENFOLD_RPC_URL: falling back to the simulated feed (set TENFOLD_SIM=1 to silence this)", { project: cfg.id });
  }
  const seed = Number(process.env.TENFOLD_SIM_SEED ?? "") || 0;
  const rng = seed ? seededRng(seed) : engineRng;
  const simFeed = new SimFeed({
    startPrice: Number(process.env.TENFOLD_SIM_START_PRICE ?? "0.0002"),
    driftPerStep: Number(process.env.TENFOLD_SIM_DRIFT ?? "0"),
    volPerStep: Number(process.env.TENFOLD_SIM_VOL ?? "0.004"),
    vaultTokens: tokensToBase(Number(process.env.TENFOLD_SIM_TOKENS ?? "1000000"), cfg.decimals),
    vaultLamports: solToLamports(Number(process.env.TENFOLD_SIM_SOL ?? "50")),
    rng,
  });
  // Each tick advances the simulated market one step before the runner snapshots it.
  const feed: PriceFeed = {
    snapshot: (c) => {
      simFeed.step();
      return simFeed.snapshot(c);
    },
  };
  return { feed, executor: new PaperExecutor(), tickMs: SIM_TICK_MS, afterFill: (f) => simFeed.applyFill(f) };
}

/**
 * Only one engine may run against a ledger: two would each approve and execute within their own tick and double-spend
 * the daily cap. Acquire an exclusive lock file holding this PID; reclaim it only if the recorded process is gone.
 */
function acquireLock(dbPath: string): () => void {
  const lockPath = `${dbPath}.engine.lock`;
  const dir = dirname(lockPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(lockPath, "utf8").trim() === String(process.pid)) rmSync(lockPath);
        } catch {
          /* already gone */
        }
      };
    } catch {
      const holder = Number(readFileSync(lockPath, "utf8").trim());
      let alive = false;
      try {
        process.kill(holder, 0);
        alive = holder !== process.pid;
      } catch {
        alive = false;
      }
      if (alive) throw new Error(`another engine (pid ${holder}) is already running against ${dbPath}; stop it first`);
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error(`could not acquire the engine lock at ${lockPath}`);
}

async function main(): Promise<void> {
  const env = loadEnv();
  const releaseLock = acquireLock(env.dbPath);
  // Release synchronously on any exit path: the shutdown grace timer is unref'd and may not fire when the loop empties.
  process.on("exit", releaseLock);
  const ledger = new Ledger(env.dbPath);
  const shared = new Shared(env);
  const runners = new Map<string, ProjectRunner>();

  const startProject = (cfg: ProjectConfig): void => {
    if (runners.has(cfg.id)) return;
    ledger.upsertProject(cfg);
    try {
      const w = wire(cfg, env, shared);
      const runner = new ProjectRunner({ ledger, feed: w.feed, executor: w.executor, rng: engineRng, cfg, tickMs: w.tickMs, afterFill: w.afterFill });
      runners.set(cfg.id, runner);
      runner.start();
      logger.info("project started", { project: cfg.id, name: cfg.name, mode: cfg.mode, mint: cfg.mint, wallet: cfg.walletPubkey, tickMs: w.tickMs });
    } catch (e) {
      logger.error("project not started", { project: cfg.id, err: e instanceof Error ? e.message : String(e) });
    }
  };

  const scan = (): void => {
    let projects: ProjectConfig[];
    try {
      projects = loadAllProjects();
    } catch (e) {
      logger.error("projects dir scan failed", { err: e instanceof Error ? e.message : String(e) });
      return;
    }
    for (const cfg of projects) startProject(cfg);
  };

  logger.info("tenfold engine starting", { db: env.dbPath, rpc: env.rpcUrl, sim: process.env.TENFOLD_SIM === "1", lamportsPerSol: LAMPORTS_PER_SOL });
  scan();
  if (runners.size === 0) logger.warn("no projects found; waiting for files in the projects dir");
  const rescan = setInterval(scan, RESCAN_MS);

  // Badge/coverage checks, daily on-chain log anchors, and fee sweeps run beside the trading runners.
  // In a pure-sim run (no RPC) coverage and on-chain posting are skipped; fees and anchors are still recorded.
  const hasRpc = Boolean(process.env.TENFOLD_RPC_URL) && process.env.TENFOLD_SIM !== "1";
  const maintenance = new Maintenance({
    ledger,
    env,
    connection: hasRpc ? () => shared.connection() : undefined,
    signer: hasRpc && env.keystorePassword ? () => shared.signerFor() : undefined,
  });
  maintenance.start();

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info("shutting down", { signal, runners: runners.size });
    clearInterval(rescan);
    maintenance.stop();
    for (const r of runners.values()) r.stop();
    // Give an in-flight tick a moment to finish writing before the database closes.
    setTimeout(() => {
      try {
        ledger.close();
      } catch (e) {
        logger.warn("ledger close failed", { err: e instanceof Error ? e.message : String(e) });
      }
      releaseLock();
      process.exit(0);
    }, 1_500).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (e) => logger.error("unhandled rejection", { err: e instanceof Error ? e.message : String(e) }));
}

main().catch((e: unknown) => {
  logger.error("engine crashed", { err: e instanceof Error ? e.stack ?? e.message : String(e) });
  process.exit(1);
});
