import { describe, it, expect } from "vitest";
import { assess, solToLamports, tokensToBase } from "./risk.js";
import { Ledger } from "./ledger.js";
import { parseProjectConfig, DEFAULT_RULES, DEFAULT_STRATEGY } from "./config.js";
import type { ProjectConfig, Snapshot } from "./types.js";
import { WSOL_MINT } from "./types.js";

const MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";

function cfg(): ProjectConfig {
  return parseProjectConfig({
    id: "rv",
    name: "Review",
    mint: MINT,
    decimals: 6,
    walletPubkey: WALLET,
    mode: "live",
    rules: { ...DEFAULT_RULES, defenseBudgetSol: 1, maxDefenseSpendPerDaySol: 1 },
    strategy: { ...DEFAULT_STRATEGY, defense: { enabled: true, levels: [{ price: 0.0002, budgetSol: 1 }] } },
    createdAt: Date.now(),
    paused: false,
  });
}

function snap(): Snapshot {
  return {
    projectId: "rv",
    ts: Date.now(),
    price: 0.0002,
    buyFlow5mSol: 1,
    sellFlow5mSol: 2,
    vaultTokens: tokensToBase(1_000_000, 6),
    vaultLamports: solToLamports(50),
  };
}

describe("review: defense budget counts in-flight DEF buys", () => {
  it("an approved/sent DEF buy whose fill is not recorded yet still consumes the budget in rollingState", () => {
    const l = new Ledger(":memory:");
    const c = cfg();
    l.upsertProject(c);
    // 0.8 SOL defense buy sent to the chain; the process may die (or the RPC may go silent) before the fill is written.
    l.insertOrder({
      projectId: "rv",
      side: "buy",
      reason: "DEF",
      inputMint: WSOL_MINT,
      outputMint: MINT,
      amountIn: solToLamports(0.8),
      maxSlippageBps: 100,
      refPrice: 0.0002,
      status: "sent",
    });
    const rolling = l.rollingState("rv");
    expect(rolling.defenseSpentTotalLamports).toBe(solToLamports(0.8));
    expect(rolling.defenseSpentLast24hLamports).toBe(solToLamports(0.8));

    // A second 0.5 SOL defense buy must be cut down to the 0.2 SOL that is really left, not approved in full.
    const v = assess({ side: "buy", reason: "DEF", amountIn: solToLamports(0.5), maxSlippageBps: 100, refPrice: 0.0002 }, { cfg: c, snapshot: snap(), rolling });
    expect(v.ok).toBe(false);
    expect(v.code).toBe("budget");
    expect(v.allowedAmountIn).toBe(solToLamports(0.2));
    l.close();
  });

  it("a rejected or failed DEF order does not consume the budget", () => {
    const l = new Ledger(":memory:");
    l.upsertProject(cfg());
    for (const status of ["rejected", "failed", "proposed"] as const) {
      l.insertOrder({
        projectId: "rv",
        side: "buy",
        reason: "DEF",
        inputMint: WSOL_MINT,
        outputMint: MINT,
        amountIn: solToLamports(0.3),
        maxSlippageBps: 100,
        refPrice: 0.0002,
        status,
      });
    }
    const rolling = l.rollingState("rv");
    expect(rolling.defenseSpentTotalLamports).toBe(0n);
    expect(rolling.defenseSpentLast24hLamports).toBe(0n);
    l.close();
  });
});
