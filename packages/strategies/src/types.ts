/**
 * Strategy contract. A strategy is a pure function from market + inventory state to proposals.
 * It never executes, never emits events and never looks at anything but its input, so it can be
 * replayed in tests and backtests exactly.
 */
import type { Order, ProjectConfig, ReasonCode, Rng, RollingState, Snapshot } from "@tenfold/core";

export interface StrategyInput {
  cfg: ProjectConfig;
  snapshot: Snapshot;
  rolling: RollingState;
  /** Unix ms, injected so backtests can run on a fake clock. */
  now: number;
  rng: Rng;
  /** Orders of this project from the last 24h, newest first. */
  lastOrders: Order[];
  /** Snapshot prices from the last 15 minutes, newest last; used for rolling means. */
  recentPrices?: number[];
}

/** An order before it has an id or a status: what a strategy hands to the engine. `note` says why. */
export type Proposal = Omit<Order, "id" | "createdAt" | "updatedAt" | "status" | "projectId"> & {
  projectId: string;
  note: string;
};

export interface Strategy {
  /** The reason code every proposal of this strategy carries. */
  name: ReasonCode;
  /** Proposals for this tick, best first; the engine processes at most one per strategy per tick. */
  propose(input: StrategyInput): Proposal[];
}
