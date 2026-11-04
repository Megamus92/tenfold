/**
 * Test helpers local to @tenfold/strategies: a config factory, a tiny fake feed and a fake executor so the tests
 * never depend on @tenfold/exec. Not exported from the package index.
 */
import { DEFAULT_RULES, DEFAULT_STRATEGY, WSOL_MINT, parseProjectConfig, solToLamports, tokensToBase } from "@tenfold/core";
import type { Fill, Order, ProjectConfig, Rng, RollingState, Snapshot } from "@tenfold/core";
import type { Proposal } from "./types.js";

export const TEST_MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
export const TEST_WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
export const DECIMALS = 6;

type Deep<T> = { [K in keyof T]?: T[K] extends object ? Deep<T[K]> : T[K] };

/** A validated project config with sensible test defaults; pass partial overrides for rules/strategy. */
export function testConfig(over: { rules?: Partial<ProjectConfig["rules"]>; strategy?: Deep<ProjectConfig["strategy"]>; paused?: boolean } = {}): ProjectConfig {
  const strategy = {
    defense: { ...DEFAULT_STRATEGY.defense, ...(over.strategy?.defense ?? {}) },
    distribution: { ...DEFAULT_STRATEGY.distribution, ...(over.strategy?.distribution ?? {}) },
    rebalance: { ...DEFAULT_STRATEGY.rebalance, ...(over.strategy?.rebalance ?? {}) },
    clip: { ...DEFAULT_STRATEGY.clip, ...(over.strategy?.clip ?? {}) },
  };
  return parseProjectConfig({
    id: "test",
    name: "Test",
    mint: TEST_MINT,
    decimals: DECIMALS,
    walletPubkey: TEST_WALLET,
    mode: "paper",
    rules: { ...DEFAULT_RULES, defenseBudgetSol: 10, maxDefenseSpendPerDaySol: 10, ...(over.rules ?? {}) },
    strategy,
    createdAt: 0,
    paused: over.paused ?? false,
  });
}

/** A snapshot with 1,000,000 tokens and 50 SOL at 0.0002 SOL/token unless overridden. */
export function testSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    projectId: "test",
    ts: 0,
    price: 0.0002,
    buyFlow5mSol: 1,
    sellFlow5mSol: 1,
    vaultTokens: tokensToBase(1_000_000, DECIMALS),
    vaultLamports: solToLamports(50),
    ...over,
  };
}

/** An empty rolling state unless overridden. */
export function testRolling(over: Partial<RollingState> = {}): RollingState {
  return { soldLast24h: 0n, defenseSpentLast24hLamports: 0n, defenseSpentTotalLamports: 0n, ordersLastHour: 0, ...over };
}

/** Turn a proposal into a stored-looking order with the given status and timestamp. */
export function toOrder(p: Proposal, status: Order["status"], createdAt: number, id = `o-${createdAt}-${Math.random().toString(36).slice(2, 8)}`): Order {
  return { ...p, id, status, createdAt, updatedAt: createdAt };
}

/** Fake feed: hands out a scripted sequence of snapshots and tracks vault balances across fills. */
export class FakeFeed {
  vaultTokens: bigint;
  vaultLamports: bigint;
  constructor(tokens: bigint, lamports: bigint) {
    this.vaultTokens = tokens;
    this.vaultLamports = lamports;
  }
  /** A snapshot at `price` with the given 5m flows and the current fake balances. */
  snapshot(price: number, buyFlow5mSol: number, sellFlow5mSol: number, ts: number): Snapshot {
    return { projectId: "test", ts, price, buyFlow5mSol, sellFlow5mSol, vaultTokens: this.vaultTokens, vaultLamports: this.vaultLamports };
  }
  /** Move the fake balances the way a fill would. */
  applyFill(f: Fill): void {
    if (f.side === "buy") {
      this.vaultLamports -= f.inAmount + f.feeLamports;
      this.vaultTokens += f.outAmount;
    } else {
      this.vaultTokens -= f.inAmount;
      this.vaultLamports += f.outAmount - f.feeLamports;
    }
  }
}

/** Fake executor: fills at the snapshot price with a flat 5,000 lamport fee, no slippage. */
export class FakeExecutor {
  readonly fills: Fill[] = [];
  /** Fill the order at snapshot.price. */
  execute(order: Order, snapshot: Snapshot, now: number): Fill {
    const price = snapshot.price;
    let outAmount: bigint;
    if (order.side === "buy") {
      outAmount = tokensToBase((Number(order.amountIn) / 1e9) / price, DECIMALS);
    } else {
      outAmount = solToLamports((Number(order.amountIn) / 10 ** DECIMALS) * price);
    }
    const fill: Fill = {
      orderId: order.id,
      projectId: order.projectId,
      side: order.side,
      reason: order.reason,
      inAmount: order.amountIn,
      outAmount,
      price,
      feeLamports: 5_000n,
      ts: now,
      paper: true,
    };
    this.fills.push(fill);
    return fill;
  }
}

/** A seeded random walk of `steps` prices starting at `start`, with per-step drift and volatility. */
export function priceSeries(rng: Rng, start: number, steps: number, drift: number, vol: number): number[] {
  const out: number[] = [start];
  let p = start;
  for (let i = 1; i < steps; i++) {
    const u1 = Math.max(rng.next(), Number.EPSILON);
    const u2 = rng.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    p = Math.max(p * (1 + drift + vol * z), 1e-12);
    out.push(p);
  }
  return out;
}

export { WSOL_MINT };
