/**
 * Randomness for clip sizes and timing. Cryptographically seeded so a watcher cannot predict the next clip,
 * with a seedable variant for deterministic tests and backtests.
 */
import { randomInt } from "node:crypto";

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
}

// randomInt's range is exclusive and capped at 2^48 - 1, so draw from [0, 2^48 - 1) and scale by 2^48.
const RANGE = 2 ** 48 - 1;
export const secureRng: Rng = {
  next: () => randomInt(0, RANGE) / 2 ** 48,
};

/** Mulberry32, good enough for tests. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** value * (1 ± jitter), uniform. */
export function jitter(value: number, jitterPct: number, rng: Rng): number {
  if (jitterPct <= 0) return value;
  const f = 1 + (rng.next() * 2 - 1) * jitterPct;
  return value * f;
}

/** A clip size between min and max, biased toward the middle, then jittered. */
export function clipSize(minSol: number, maxSol: number, jitterPct: number, rng: Rng): number {
  const mid = (minSol + maxSol) / 2;
  const spread = (maxSol - minSol) / 2;
  // sum of two uniforms gives a triangular distribution around the middle
  const u = (rng.next() + rng.next()) / 2;
  const base = mid + (u * 2 - 1) * spread;
  const j = jitter(base, jitterPct, rng);
  return Math.min(maxSol, Math.max(minSol, j));
}
