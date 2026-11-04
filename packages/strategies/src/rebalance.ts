/**
 * REB: inventory rebalance. Keeps the SOL share of vault value inside [target - band, target + band].
 * Below the band it sells tokens, above it buys, each order closing at most a quarter of the gap, sells never
 * above the daily cap and never into the project's own defense. Inside the band it is silent.
 */
import { dailyCapRemaining, lamportsToSol, solToLamports } from "@tenfold/core";
import type { Order } from "@tenfold/core";
import type { Proposal, Strategy, StrategyInput } from "./types.js";
import {
  FEE_RESERVE_LAMPORTS,
  MIN_ORDER_LAMPORTS,
  activeLevels,
  buyProposal,
  inNoSellZone,
  lamportsForTokens,
  minBig,
  msSinceLast,
  sellProposal,
  solShare,
  tokensForSol,
} from "./util.js";

/** Minimum gap between two REB orders. */
export const REB_MIN_GAP_MS = 10 * 60_000;
/** Fraction of the gap to the target closed by one order. */
export const REB_GAP_FRACTION = 0.25;
/** REB never trades opposite to an own order younger than this, so it never completes a round trip. */
export const REB_OPPOSITE_SIDE_COOLDOWN_MS = 5 * 60_000;

const COMMITTED = new Set<Order["status"]>(["filled", "approved", "sent"]);

/** Total vault value in SOL at the snapshot price. */
export function vaultValueSol(input: Pick<StrategyInput, "cfg" | "snapshot">): number {
  const { snapshot, cfg } = input;
  return lamportsToSol(snapshot.vaultLamports) + lamportsToSol(lamportsForTokens(snapshot.vaultTokens, snapshot.price, cfg.decimals));
}

/** REB proposals for this tick: one order when the SOL share is outside the band, none inside it. */
export function proposeRebalance(input: StrategyInput): Proposal[] {
  const { cfg, snapshot, rolling, now, lastOrders } = input;
  const reb = cfg.strategy.rebalance;
  if (!reb.enabled || cfg.paused) return [];
  if (!(snapshot.price > 0)) return [];

  const share = solShare(snapshot, cfg.decimals);
  if (share === undefined) return [];
  const lower = reb.targetSolShare - reb.band;
  const upper = reb.targetSolShare + reb.band;
  if (share >= lower && share <= upper) return [];

  if (msSinceLast(lastOrders, now, (o) => o.reason === "REB") < REB_MIN_GAP_MS) return [];

  const total = vaultValueSol(input);
  const gapSol = Math.abs(reb.targetSolShare - share) * total;
  // One rebalance order closes a quarter of the gap, but never more than one clip, so REB cannot move the market in a single step.
  const stepSol = Math.min(gapSol * REB_GAP_FRACTION, cfg.strategy.clip.maxSol);
  if (!(stepSol > 0)) return [];

  if (share < lower) {
    // Too little SOL: sell tokens worth `stepSol`, within the cap, outside any defended zone, not right after an own buy.
    if (msSinceLast(lastOrders, now, (o) => o.side === "buy" && COMMITTED.has(o.status)) < REB_OPPOSITE_SIDE_COOLDOWN_MS) return [];
    if (inNoSellZone(snapshot.price, activeLevels(cfg, rolling, snapshot, lastOrders))) return [];
    const minPrice = cfg.strategy.distribution.minPrice;
    if (minPrice !== undefined && snapshot.price < minPrice) return [];
    const capRemaining = dailyCapRemaining(cfg, snapshot, rolling);
    const tokens = minBig(tokensForSol(stepSol, snapshot.price, cfg.decimals), capRemaining, snapshot.vaultTokens);
    if (tokens <= 0n || lamportsForTokens(tokens, snapshot.price, cfg.decimals) < MIN_ORDER_LAMPORTS) return [];
    return [sellProposal(cfg, snapshot, "REB", tokens, `solShare=${(share * 100).toFixed(1)}% target=${(reb.targetSolShare * 100).toFixed(0)}% sell`)];
  }

  // Too much SOL: buy tokens with `stepSol`, keeping the fee reserve, not right after an own sell.
  if (msSinceLast(lastOrders, now, (o) => o.side === "sell" && COMMITTED.has(o.status)) < REB_OPPOSITE_SIDE_COOLDOWN_MS) return [];
  const spendable = snapshot.vaultLamports - FEE_RESERVE_LAMPORTS;
  const lamports = minBig(solToLamports(stepSol), spendable > 0n ? spendable : 0n);
  if (lamports < MIN_ORDER_LAMPORTS) return [];
  return [buyProposal(cfg, snapshot, "REB", lamports, `solShare=${(share * 100).toFixed(1)}% target=${(reb.targetSolShare * 100).toFixed(0)}% buy`)];
}

export const rebalanceStrategy: Strategy = { name: "REB", propose: proposeRebalance };
