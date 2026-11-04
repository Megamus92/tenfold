/** Shared fixtures for the agent tests: a temp projects dir, an in-memory ledger and a seeded project. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RULES, DEFAULT_STRATEGY, Ledger, parseProjectConfig, saveProject, solToLamports, tokensToBase } from "@tenfold/core";
import type { ProjectConfig, Snapshot } from "@tenfold/core";

export const MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
export const WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
export const CHAT = "424242";

export interface Fixture {
  dir: string;
  ledger: Ledger;
  cfg: ProjectConfig;
  cleanup: () => void;
}

/** Points TENFOLD_PROJECTS_DIR at a fresh temp dir and seeds one project plus a snapshot. */
export function fixture(over: Partial<ProjectConfig> = {}, snapshot: Partial<Snapshot> | null = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tenfold-agent-"));
  process.env.TENFOLD_PROJECTS_DIR = dir;
  const cfg = parseProjectConfig({
    id: "test",
    name: "Test Token",
    mint: MINT,
    decimals: 6,
    walletPubkey: WALLET,
    mode: "paper",
    rules: { ...DEFAULT_RULES, dailySellCapPct: 0.5, defenseBudgetSol: 10, maxDefenseSpendPerDaySol: 4 },
    strategy: {
      ...DEFAULT_STRATEGY,
      defense: { enabled: true, levels: [{ price: 0.00018, budgetSol: 4 }] },
      distribution: { enabled: true, pctOfVaultPerDay: 0.3, mode: "strength", minPrice: 0.0001 },
    },
    telegram: { chatId: CHAT },
    createdAt: Date.now(),
    paused: false,
    ...over,
  });
  saveProject(cfg);
  const ledger = new Ledger(":memory:");
  ledger.upsertProject(cfg);
  if (snapshot !== null) {
    ledger.insertSnapshot({
      projectId: cfg.id,
      ts: Date.now(),
      price: 0.0002,
      buyFlow5mSol: 1,
      sellFlow5mSol: 2,
      vaultTokens: tokensToBase(1_000_000, 6),
      vaultLamports: solToLamports(50),
      ...snapshot,
    });
  }
  return {
    dir,
    ledger,
    cfg,
    cleanup: () => {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
