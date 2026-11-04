/**
 * Price and flow feeds. A feed turns a project config into the market half of a Snapshot:
 * price, liquidity, 5-minute aggressor flow and the vault's balances.
 *
 *  - JupiterFeed: Jupiter quotes for price and impact, DexScreener for 5m flow, the RPC for balances.
 *  - SimFeed: deterministic random walk driven by a seeded Rng, for tests and backtests.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { Fill, ProjectConfig, Rng, Snapshot } from "@tenfold/core";
import { LAMPORTS_PER_SOL, WSOL_MINT, logger } from "@tenfold/core";
import { asNumber, asRecord, fetchJson, isTransientHttpError, DEFAULT_HTTP_TIMEOUT_MS } from "./http.js";
import { JupiterClient, type JupiterQuote, type Quoter } from "./jupiter.js";

/** The market half of a Snapshot; the engine adds projectId and ts. */
export type MarketSnapshot = Omit<Snapshot, "projectId" | "ts">;

export interface PriceFeed {
  /** Observe the market and the vault for one project. Throws FeedError when no price can be derived. */
  snapshot(cfg: ProjectConfig): Promise<MarketSnapshot>;
}

/** Thrown when the feed cannot produce a price; `retryable` is true for transient network conditions. */
export class FeedError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "FeedError";
  }
}

/** Reference size for price quotes: 0.1 SOL. */
export const PRICE_QUOTE_LAMPORTS = LAMPORTS_PER_SOL / 10n;
/** Size used to estimate pool depth from price impact: 1 SOL. */
export const IMPACT_QUOTE_LAMPORTS = LAMPORTS_PER_SOL;
/** How long an impact-based liquidity estimate is reused before a fresh quote. */
export const IMPACT_CACHE_MS = 60_000;

/** SOL per whole token implied by a SOL -> token quote (buy side). */
export function buyPriceFromQuote(q: JupiterQuote, decimals: number): number {
  if (q.outAmount === 0n) return 0;
  const sol = Number(q.inAmount) / 1e9;
  const tokens = Number(q.outAmount) / 10 ** decimals;
  return sol / tokens;
}

/** SOL per whole token implied by a token -> SOL quote (sell side). */
export function sellPriceFromQuote(q: JupiterQuote, decimals: number): number {
  if (q.inAmount === 0n) return 0;
  const sol = Number(q.outAmount) / 1e9;
  const tokens = Number(q.inAmount) / 10 ** decimals;
  return sol / tokens;
}

/**
 * Rough pool depth on the SOL side from the impact of a 1 SOL buy. For a constant-product pool a trade of
 * size x against reserve R moves the price by about x / R, so R ≈ x / impact. An estimate, not a reading.
 */
export function liquidityFromImpact(quoteSol: number, priceImpact: number): number | undefined {
  if (!Number.isFinite(priceImpact) || priceImpact <= 0) return undefined;
  return quoteSol / priceImpact;
}

export interface Flow5m {
  buyFlow5mSol: number;
  sellFlow5mSol: number;
  /** SOL side of the deepest SOL-quoted pair, as DexScreener reads it (a reading, unlike the impact estimate). */
  liquiditySol?: number;
}

/**
 * Split DexScreener's 5m volume (USD) for the deepest pair into buy/sell SOL using the txn counts, converting
 * with the pair's own priceNative/priceUsd ratio. Returns zeros for anything missing.
 */
export function flowFromDexScreener(body: unknown): Flow5m {
  const zero: Flow5m = { buyFlow5mSol: 0, sellFlow5mSol: 0 };
  const root = asRecord(body);
  const pairs = root && Array.isArray(root.pairs) ? root.pairs : [];
  let best: Record<string, unknown> | undefined;
  let bestLiq = -1;
  for (const p of pairs) {
    const pair = asRecord(p);
    if (!pair) continue;
    const liq = asNumber(asRecord(pair.liquidity)?.usd) ?? 0;
    if (liq > bestLiq) {
      bestLiq = liq;
      best = pair;
    }
  }
  if (!best) return zero;
  const buys = asNumber(asRecord(asRecord(best.txns)?.m5)?.buys) ?? 0;
  const sells = asNumber(asRecord(asRecord(best.txns)?.m5)?.sells) ?? 0;
  const volUsd = asNumber(asRecord(best.volume)?.m5) ?? 0;
  const priceUsd = asNumber(best.priceUsd);
  const priceNative = asNumber(best.priceNative);
  // USD per SOL = priceUsd(token) / priceNative(token in SOL); requires a SOL-quoted pair.
  const quoteSymbol = asRecord(best.quoteToken)?.symbol;
  const solPerUsd = priceUsd && priceNative && priceUsd > 0 && quoteSymbol === "SOL" ? priceNative / priceUsd : undefined;
  const quoteLiq = quoteSymbol === "SOL" ? asNumber(asRecord(best.liquidity)?.quote) : undefined;
  const liquiditySol = quoteLiq !== undefined && quoteLiq > 0 ? quoteLiq : undefined;
  if (!solPerUsd || volUsd <= 0 || buys + sells === 0) return liquiditySol !== undefined ? { ...zero, liquiditySol } : zero;
  const volSol = volUsd * solPerUsd;
  return {
    buyFlow5mSol: (volSol * buys) / (buys + sells),
    sellFlow5mSol: (volSol * sells) / (buys + sells),
    ...(liquiditySol !== undefined ? { liquiditySol } : {}),
  };
}

export interface VaultBalances {
  vaultTokens: bigint;
  vaultLamports: bigint;
}

/** Read the wallet's SOL and token balances from the RPC; a missing ATA counts as 0 tokens. */
export async function readVaultBalances(rpc: Connection, wallet: string, mint: string): Promise<VaultBalances> {
  const owner = new PublicKey(wallet);
  const mintKey = new PublicKey(mint);
  const lamportsP = rpc.getBalance(owner, "confirmed");
  // Try the classic token program first, then Token-2022; both ATAs missing means 0.
  const tokensP = (async (): Promise<bigint> => {
    for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const ata = getAssociatedTokenAddressSync(mintKey, owner, true, program);
      try {
        const res = await rpc.getTokenAccountBalance(ata, "confirmed");
        return BigInt(res.value.amount);
      } catch (e) {
        // "could not find account" / "Invalid param" are the normal responses for a missing ATA.
        if (e instanceof Error && /could not find|Invalid param|not found|AccountNotFound/i.test(e.message)) continue;
        throw e;
      }
    }
    return 0n;
  })();
  const [vaultLamports, vaultTokens] = await Promise.all([lamportsP, tokensP]);
  return { vaultTokens, vaultLamports: BigInt(vaultLamports) };
}

export interface JupiterFeedOptions {
  quoter?: Quoter;
  dexScreenerBase?: string;
  timeoutMs?: number;
}

export class JupiterFeed implements PriceFeed {
  private readonly quoter: Quoter;
  private readonly dexBase: string;
  private readonly impactCache = new Map<string, { ts: number; liquiditySol?: number }>();
  private readonly timeoutMs: number;

  constructor(
    private readonly rpc: Connection,
    opts: JupiterFeedOptions = {},
  ) {
    this.quoter = opts.quoter ?? new JupiterClient({ timeoutMs: opts.timeoutMs });
    this.dexBase = (opts.dexScreenerBase ?? "https://api.dexscreener.com").replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  }

  /** Mid of a 0.1 SOL buy quote and the matching sell quote, plus liquidity, 5m flow and balances. */
  async snapshot(cfg: ProjectConfig): Promise<MarketSnapshot> {
    const [priceAndLiq, flow, balances] = await Promise.all([
      this.price(cfg),
      this.flow(cfg.mint),
      readVaultBalances(this.rpc, cfg.walletPubkey, cfg.mint).catch((e: unknown) => {
        throw new FeedError(`rpc balances failed: ${(e as Error).message}`, true, e);
      }),
    ]);
    // DexScreener's pool reading wins over the impact estimate when it has one; the desk only hard-stops on a pool reading.
    const { liquiditySol: dexLiq, ...flows } = flow;
    const liquiditySol = dexLiq ?? priceAndLiq.liquiditySol;
    const liquiditySource = dexLiq !== undefined ? "dex" : priceAndLiq.liquiditySol !== undefined ? "impact" : undefined;
    return { ...priceAndLiq, ...flows, ...balances, ...(liquiditySol !== undefined ? { liquiditySol, liquiditySource } : {}) };
  }

  private async price(cfg: ProjectConfig): Promise<{ price: number; liquiditySol?: number }> {
    let buyQ: JupiterQuote;
    try {
      buyQ = await this.quoter.quote({
        inputMint: WSOL_MINT,
        outputMint: cfg.mint,
        amount: PRICE_QUOTE_LAMPORTS,
        slippageBps: 50,
      });
    } catch (e) {
      throw new FeedError(`buy quote failed for ${cfg.mint}: ${(e as Error).message}`, isTransientHttpError(e), e);
    }
    const buyPrice = buyPriceFromQuote(buyQ, cfg.decimals);
    if (!(buyPrice > 0)) throw new FeedError(`buy quote for ${cfg.mint} returned zero output`, false);

    // Sell the tokens the buy would yield, so both legs reference the same size.
    let sellPrice = buyPrice;
    try {
      const sellQ = await this.quoter.quote({
        inputMint: cfg.mint,
        outputMint: WSOL_MINT,
        amount: buyQ.outAmount,
        slippageBps: 50,
      });
      const p = sellPriceFromQuote(sellQ, cfg.decimals);
      if (p > 0) sellPrice = p;
    } catch (e) {
      // One-sided markets happen on fresh launches; log and fall back to the buy side.
      logger.warn("sell quote failed, using buy side only", { mint: cfg.mint, err: (e as Error).message });
    }
    const price = (buyPrice + sellPrice) / 2;

    // Pool depth moves slowly: one impact quote per minute per project keeps Jupiter calls at ~2 per tick.
    const cached = this.impactCache.get(cfg.mint);
    let liquiditySol: number | undefined = cached && Date.now() - cached.ts < IMPACT_CACHE_MS ? cached.liquiditySol : undefined;
    if (!cached || Date.now() - cached.ts >= IMPACT_CACHE_MS) {
      try {
        const impactQ = await this.quoter.quote({
          inputMint: WSOL_MINT,
          outputMint: cfg.mint,
          amount: IMPACT_QUOTE_LAMPORTS,
          slippageBps: 50,
        });
        liquiditySol = liquidityFromImpact(Number(IMPACT_QUOTE_LAMPORTS) / 1e9, impactQ.priceImpact);
        this.impactCache.set(cfg.mint, { ts: Date.now(), liquiditySol });
      } catch (e) {
        logger.debug("impact quote failed, liquidity unknown", { mint: cfg.mint, err: (e as Error).message });
      }
    }
    return liquiditySol === undefined ? { price } : { price, liquiditySol };
  }

  private async flow(mint: string): Promise<Flow5m> {
    try {
      const body = await fetchJson(`${this.dexBase}/latest/dex/tokens/${mint}`, { method: "GET" }, this.timeoutMs);
      return flowFromDexScreener(body);
    } catch (e) {
      logger.debug("dexscreener unavailable, flow set to 0", { mint, err: (e as Error).message });
      return { buyFlow5mSol: 0, sellFlow5mSol: 0 };
    }
  }
}

export interface SimFeedOptions {
  /** SOL per token at step 0. */
  startPrice: number;
  /** Multiplicative drift per step (0.001 = +0.1% per tick). */
  driftPerStep: number;
  /** Volatility per step as a fraction of price (0.02 = 2% one-sigma). */
  volPerStep: number;
  vaultTokens: bigint;
  vaultLamports: bigint;
  rng: Rng;
  /** Simulated pool depth on the SOL side; defaults to 50 SOL. */
  liquiditySol?: number;
  /** Baseline 5m flow in SOL around which the simulated flow fluctuates; defaults to 2 SOL. */
  baseFlowSol?: number;
}

/**
 * Deterministic simulated market: a geometric random walk with normal-ish shocks from the seeded Rng,
 * 5m flows that lean with the last move, and vault balances that follow the fills applied to it.
 */
export class SimFeed implements PriceFeed {
  private price: number;
  private lastReturn = 0;
  private vaultTokens: bigint;
  private vaultLamports: bigint;
  private readonly drift: number;
  private readonly vol: number;
  private readonly rng: Rng;
  private readonly liquiditySol: number;
  private readonly baseFlowSol: number;
  private ticks = 0;

  constructor(opts: SimFeedOptions) {
    this.price = opts.startPrice;
    this.drift = opts.driftPerStep;
    this.vol = opts.volPerStep;
    this.vaultTokens = opts.vaultTokens;
    this.vaultLamports = opts.vaultLamports;
    this.rng = opts.rng;
    this.liquiditySol = opts.liquiditySol ?? 50;
    this.baseFlowSol = opts.baseFlowSol ?? 2;
  }

  /** Current simulated price, SOL per token. */
  get currentPrice(): number {
    return this.price;
  }

  /** Number of steps taken so far. */
  get tick(): number {
    return this.ticks;
  }

  /** Advance one tick: price *= 1 + drift + vol * z, with z a Box-Muller normal from the Rng. */
  step(): number {
    const u1 = Math.max(this.rng.next(), Number.EPSILON);
    const u2 = this.rng.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const r = this.drift + this.vol * z;
    this.lastReturn = r;
    this.price = Math.max(this.price * (1 + r), Number.MIN_VALUE);
    this.ticks += 1;
    return this.price;
  }

  /** Move simulated vault balances the way a real fill would (buy: SOL out, tokens in; sell: inverse). */
  applyFill(fill: Pick<Fill, "side" | "inAmount" | "outAmount" | "feeLamports">): void {
    if (fill.side === "buy") {
      this.vaultLamports -= fill.inAmount + fill.feeLamports;
      this.vaultTokens += fill.outAmount;
    } else {
      this.vaultTokens -= fill.inAmount;
      this.vaultLamports += fill.outAmount - fill.feeLamports;
    }
    if (this.vaultLamports < 0n) this.vaultLamports = 0n;
    if (this.vaultTokens < 0n) this.vaultTokens = 0n;
  }

  /** Snapshot of the simulated state; does not advance time (call step() for that). */
  async snapshot(_cfg: ProjectConfig): Promise<MarketSnapshot> {
    // Flow leans with the last return: a +2% tick shows more buys than sells. Two Rng draws keep it noisy.
    const tilt = Math.max(-0.9, Math.min(0.9, this.lastReturn / Math.max(this.vol, 1e-9) / 3));
    const total = this.baseFlowSol * (0.5 + this.rng.next());
    const buyShare = 0.5 + tilt / 2 + (this.rng.next() - 0.5) * 0.1;
    const clamped = Math.max(0, Math.min(1, buyShare));
    return {
      price: this.price,
      liquiditySol: this.liquiditySol,
      liquiditySource: "dex",
      buyFlow5mSol: total * clamped,
      sellFlow5mSol: total * (1 - clamped),
      vaultTokens: this.vaultTokens,
      vaultLamports: this.vaultLamports,
    };
  }
}
