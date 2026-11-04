/**
 * @tenfold/strategies: pure proposal generators (DEF, DIST, REB) and detectors. No execution, no I/O.
 *
 * Invariant for every strategy: an order exists because of inventory, a level or distribution progress.
 * None of them trades to create volume, and each refuses to take the opposite side of a recent own order.
 */
import type { ProjectConfig } from "@tenfold/core";
import type { Strategy } from "./types.js";
import { defenseStrategy } from "./defense.js";
import { distributionStrategy } from "./distribution.js";
import { rebalanceStrategy } from "./rebalance.js";

export * from "./types.js";
export * from "./defense.js";
export * from "./distribution.js";
export * from "./rebalance.js";
export * from "./pressure.js";
export {
  MINUTE,
  HOUR,
  DAY,
  MIN_ORDER_LAMPORTS,
  FEE_RESERVE_LAMPORTS,
  LEVEL_ZONE,
  NO_SELL_ZONE,
  levelTag,
  isLevelOrder,
  levelSpentLamports,
  levelRemainingLamports,
  levelDefendedRecently,
  activeLevels,
  inNoSellZone,
  solShare,
  tokensForSol,
  lamportsForTokens,
  localDayStart,
  buyProposal,
  sellProposal,
  minBig,
  scaleBig,
  msSinceLast,
} from "./util.js";

/** The strategies enabled in this project's config, in the order the engine runs them: DEF, DIST, REB. */
export function allStrategies(cfg: ProjectConfig): Strategy[] {
  const out: Strategy[] = [];
  if (cfg.strategy.defense.enabled) out.push(defenseStrategy);
  if (cfg.strategy.distribution.enabled) out.push(distributionStrategy);
  if (cfg.strategy.rebalance.enabled) out.push(rebalanceStrategy);
  return out;
}
