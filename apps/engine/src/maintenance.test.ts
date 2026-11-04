import { describe, it, expect } from "vitest";
import { Ledger, parseProjectConfig, DEFAULT_RULES, DEFAULT_STRATEGY, solToLamports, tokensToBase } from "@tenfold/core";
import type { Env, ProjectConfig, Fill } from "@tenfold/core";
import { Maintenance } from "./maintenance.js";

const MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const DAY = 86_400_000;

function paperProject(): ProjectConfig {
  return parseProjectConfig({
    id: "demo",
    name: "Demo",
    mint: MINT,
    decimals: 6,
    walletPubkey: WALLET,
    mode: "paper",
    rules: { ...DEFAULT_RULES, dailySellCapPct: 1 },
    strategy: { ...DEFAULT_STRATEGY, distribution: { enabled: true, pctOfVaultPerDay: 1, mode: "strength" } },
    fees: { volumeBps: 50, cashoutBps: 200, referralBps: 1000, discountBps: 1000 },
    createdAt: Date.now(),
    paused: false,
  });
}

function env(): Env {
  return {
    rpcUrl: "https://example.com",
    dbPath: ":memory:",
    keystoreDir: "/tmp/none",
    keystorePassword: "",
    jitoTipLamports: 0n,
    priorityFeeMicroLamports: 50_000,
    anthropicModel: "x",
    proofPort: 1,
    proofBaseUrl: "x",
    proofSigningSecret: "",
    onboardPort: 1,
    onboardBaseUrl: "x",
  };
}

function sellFill(projectId: string, ts: number): Fill {
  return {
    orderId: `o-${ts}`,
    projectId,
    side: "sell",
    reason: "DIST",
    inAmount: tokensToBase(1_000, 6),
    outAmount: solToLamports(0.2),
    price: 0.0002,
    feeLamports: 5000n,
    ts,
    paper: true,
  };
}

describe("maintenance in a paper / no-RPC run", () => {
  it("sweep_fees leaves paper fees accrued, never moves funds", async () => {
    const l = new Ledger(":memory:");
    const cfg = paperProject();
    l.upsertProject(cfg);
    l.accrueFee({ projectId: "demo", kind: "volume", baseLamports: solToLamports(10), grossLamports: solToLamports(0.05), discountLamports: 0n, referralLamports: 0n, paper: true });
    const m = new Maintenance({ ledger: l, env: env() }); // no connection, no signer
    l.enqueueCommand("demo", "sweep_fees");
    await m.tick();
    expect(l.pendingCommands().filter((c) => c.type === "sweep_fees")).toHaveLength(0); // completed
    const fs = l.feeSummary("demo");
    expect(fs.accruedLamports).toBe(solToLamports(0.05));
    expect(fs.sweptLamports).toBe(0n);
    l.close();
  });

  it("anchors yesterday's log as a hash with no on-chain tx in paper mode", async () => {
    const l = new Ledger(":memory:");
    const cfg = paperProject();
    l.upsertProject(cfg);
    const yts = Date.now() - DAY;
    l.insertFill(sellFill("demo", yts));
    l.insertFill(sellFill("demo", yts + 1000));
    const m = new Maintenance({ ledger: l, env: env() });
    await m.tick();
    const anchors = l.listAnchors("demo");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.entries).toBe(2);
    expect(anchors[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(anchors[0]!.txSig).toBeUndefined();
    const events = l.listEvents("demo", { types: ["anchor_posted"] });
    expect(events).toHaveLength(1);
    // a second pass does not double-anchor the same day
    await m.tick();
    expect(l.listAnchors("demo")).toHaveLength(1);
    l.close();
  });

  it("coverage_check without a chain reader completes without throwing and records no coverage", async () => {
    const l = new Ledger(":memory:");
    l.upsertProject(paperProject());
    const m = new Maintenance({ ledger: l, env: env() });
    l.enqueueCommand("demo", "coverage_check");
    await m.tick();
    expect(l.pendingCommands().filter((c) => c.type === "coverage_check")).toHaveLength(0);
    expect(l.latestCoverage("demo")).toBeUndefined();
    l.close();
  });

  it("reserved (sweeping) fee rows are excluded from unsweptFees, so a crash mid-sweep cannot double-pay", () => {
    const l = new Ledger(":memory:");
    l.upsertProject(paperProject());
    const id1 = l.accrueFee({ projectId: "demo", kind: "volume", baseLamports: solToLamports(10), grossLamports: solToLamports(0.05), discountLamports: 0n, referralLamports: 0n, paper: false });
    const id2 = l.accrueFee({ projectId: "demo", kind: "volume", baseLamports: solToLamports(10), grossLamports: solToLamports(0.05), discountLamports: 0n, referralLamports: 0n, paper: false });
    expect(l.unsweptFees("demo").ids).toEqual([id1, id2]);
    l.markFeesSweeping([id1, id2]); // transfer about to be sent; simulate a crash right here
    expect(l.unsweptFees("demo").ids).toEqual([]); // a restart sees nothing to sweep: no double-pay
    l.revertFeesSweeping([id1, id2]); // a sure failure releases them for retry
    expect(l.unsweptFees("demo").ids).toEqual([id1, id2]);
    l.close();
  });

  it("does not anchor a day with no fills", async () => {
    const l = new Ledger(":memory:");
    l.upsertProject(paperProject());
    const m = new Maintenance({ ledger: l, env: env() });
    await m.tick();
    expect(l.listAnchors("demo")).toHaveLength(0);
    l.close();
  });
});
