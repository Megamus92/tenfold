/** Shared fixtures for the marketing tests: an in-memory ledger, a live project with marketing on, a fake channel. */
import { DEFAULT_RULES, DEFAULT_STRATEGY, Ledger, parseProjectConfig, solToLamports, tokensToBase } from "@tenfold/core";
import type { Fill, ProjectConfig } from "@tenfold/core";
import type { Channel, ChannelName, Published } from "./channels.js";

export const MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
export const WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
export const PROOF = "https://proof.tenfold.test";
export const T0 = Date.parse("2026-10-30T12:00:00Z");

export function project(over: Partial<ProjectConfig> = {}): ProjectConfig {
  return parseProjectConfig({
    id: "alpha",
    name: "Alpha Coin",
    mint: MINT,
    decimals: 6,
    walletPubkey: WALLET,
    mode: "live",
    rules: { ...DEFAULT_RULES, dailySellCapPct: 0.5, defenseBudgetSol: 10, maxDefenseSpendPerDaySol: 4 },
    strategy: {
      ...DEFAULT_STRATEGY,
      defense: { enabled: true, levels: [{ price: 0.00018, budgetSol: 4 }] },
      distribution: { enabled: true, pctOfVaultPerDay: 0.3, mode: "strength" },
    },
    marketing: { mode: "approve", xHandle: "alphacoin", telegramChannelId: "@alphacoin_news", tone: "neutral" },
    createdAt: T0 - 3 * 86_400_000,
    paused: false,
    ...over,
  });
}

/** A channel that records what it was asked to publish and can be made to fail. */
export class FakeChannel implements Channel {
  readonly posted: { text: string; projectId: string }[] = [];
  failWith?: Error;
  constructor(
    readonly name: ChannelName,
    private readonly enabled: (cfg: ProjectConfig) => boolean = (cfg) => Boolean(cfg.marketing && cfg.marketing.mode !== "off"),
  ) {}
  enabledFor(cfg: ProjectConfig): boolean {
    return this.enabled(cfg);
  }
  async publish(text: string, cfg: ProjectConfig): Promise<Published> {
    if (this.failWith) throw this.failWith;
    this.posted.push({ text, projectId: cfg.id });
    return { externalId: `${this.name}-${this.posted.length}`, url: `https://${this.name}.example/${this.posted.length}` };
  }
}

export function ledgerWith(cfg: ProjectConfig): Ledger {
  const ledger = new Ledger(":memory:");
  ledger.upsertProject(cfg);
  return ledger;
}

/** Insert an order plus its fill so the ledger is consistent. */
export function fill(ledger: Ledger, cfg: ProjectConfig, f: Partial<Fill> & { side: Fill["side"]; reason: Fill["reason"]; ts: number; sol: number; tokens: number }): Fill {
  const inAmount = f.side === "buy" ? solToLamports(f.sol) : tokensToBase(f.tokens, cfg.decimals);
  const outAmount = f.side === "buy" ? tokensToBase(f.tokens, cfg.decimals) : solToLamports(f.sol);
  const order = ledger.insertOrder({
    projectId: cfg.id,
    side: f.side,
    reason: f.reason,
    inputMint: f.side === "buy" ? "So11111111111111111111111111111111111111112" : cfg.mint,
    outputMint: f.side === "buy" ? cfg.mint : "So11111111111111111111111111111111111111112",
    amountIn: inAmount,
    maxSlippageBps: 100,
    refPrice: f.price ?? f.sol / f.tokens,
  });
  const full: Fill = {
    orderId: order.id,
    projectId: cfg.id,
    side: f.side,
    reason: f.reason,
    inAmount,
    outAmount,
    price: f.price ?? f.sol / f.tokens,
    feeLamports: f.feeLamports ?? 5_000n,
    ts: f.ts,
    txSig: f.txSig ?? `sig${order.id.slice(0, 8)}`,
    paper: f.paper ?? false,
  };
  ledger.insertFill(full);
  return full;
}

export function snapshot(ledger: Ledger, cfg: ProjectConfig, ts: number, price: number, over: { buy?: number; sell?: number; tokens?: number; sol?: number } = {}): void {
  ledger.insertSnapshot({
    projectId: cfg.id,
    ts,
    price,
    buyFlow5mSol: over.buy ?? 1,
    sellFlow5mSol: over.sell ?? 1,
    vaultTokens: tokensToBase(over.tokens ?? 1_000_000, cfg.decimals),
    vaultLamports: solToLamports(over.sol ?? 50),
  });
}
