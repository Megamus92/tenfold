/**
 * Backtest: run a ProjectRunner against SimFeed + PaperExecutor on an in-memory ledger with a fake clock.
 *
 *   node apps/engine/dist/backtest.js <projectId> [--steps 5000] [--seed 42] [--tick 10] [--price 0.0002]
 *                                      [--vol 0.004] [--drift 0] [--tokens 1000000] [--sol 50] [--start-hour 9]
 *
 * `--tick` is the simulated seconds per step. Prints fills by reason, tokens sold vs cap, distribution VWAP vs the
 * token's flow-weighted VWAP in bps, defense SOL spent and the final inventory.
 */
import { Ledger, baseToTokens, dailyCapAmount, lamportsToSol, loadProject, logger, seededRng, solToLamports, tokensToBase } from "@tenfold/core";
import type { Fill, ProjectConfig, Snapshot } from "@tenfold/core";
import { PaperExecutor, SimFeed } from "@tenfold/exec";
import { ProjectRunner } from "./runner.js";
import type { PriceFeed } from "./runner.js";

interface Args {
  projectId: string;
  steps: number;
  seed: number;
  tickSec: number;
  price: number;
  vol: number;
  drift: number;
  tokens: number;
  sol: number;
  startHour: number;
}

/** Parse `<projectId> --flag value ...` into Args with defaults. */
export function parseArgs(argv: string[]): Args {
  const [projectId, ...rest] = argv;
  if (!projectId || projectId.startsWith("--")) {
    throw new Error("usage: backtest.js <projectId> [--steps N] [--seed N] [--tick SEC] [--price P] [--vol V] [--drift D] [--tokens T] [--sol S] [--start-hour H]");
  }
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    const v = rest[i + 1];
    if (!k?.startsWith("--") || v === undefined) throw new Error(`bad flag near "${k ?? ""}"`);
    flags.set(k.slice(2), v);
  }
  const num = (k: string, d: number): number => {
    const raw = flags.get(k);
    if (raw === undefined) return d;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`--${k} must be a number`);
    return n;
  };
  return {
    projectId,
    steps: num("steps", 5000),
    seed: num("seed", 42),
    tickSec: num("tick", 10),
    price: num("price", 0.0002),
    vol: num("vol", 0.004),
    drift: num("drift", 0),
    tokens: num("tokens", 1_000_000),
    sol: num("sol", 50),
    startHour: num("start-hour", 9),
  };
}

export interface BacktestResult {
  steps: number;
  simulatedHours: number;
  fills: number;
  byReason: Record<string, { count: number; tokens: number; sol: number }>;
  rejectedByCode: Record<string, number>;
  soldTokens: number;
  capTokensDay1: number;
  capRolling: number;
  distributionVwap?: number;
  tokenVwap?: number;
  distributionVsTokenBps?: number;
  defenseSolSpent: number;
  defenseBudgetSol: number;
  defenseTokensBought: number;
  priceStart: number;
  priceEnd: number;
  startTokens: number;
  startSol: number;
  endTokens: number;
  endSol: number;
  startValueSol: number;
  endValueSol: number;
  events: Record<string, number>;
}

/** Run the backtest and return its figures; `cfg` is used as-is (paused flag and all). */
export async function runBacktest(cfg: ProjectConfig, a: Args, quiet = true): Promise<BacktestResult> {
  const rng = seededRng(a.seed);
  const startTokens = tokensToBase(a.tokens, cfg.decimals);
  const startLamports = solToLamports(a.sol);
  const sim = new SimFeed({ startPrice: a.price, driftPerStep: a.drift, volPerStep: a.vol, vaultTokens: startTokens, vaultLamports: startLamports, rng });
  const feed: PriceFeed = {
    snapshot: (c) => {
      sim.step();
      return sim.snapshot(c);
    },
  };

  // Fake clock: starts today at `startHour` local time, advances tickSec per step.
  const start = new Date();
  start.setHours(a.startHour, 0, 0, 0);
  let now = start.getTime();
  const clock = (): number => now;

  const ledger = new Ledger(":memory:");
  const executor = new PaperExecutor({ now: clock });
  const runner = new ProjectRunner({
    ledger,
    feed,
    executor,
    rng: seededRng(a.seed + 1),
    cfg,
    now: clock,
    afterFill: (f: Fill) => sim.applyFill(f),
    persistConfig: () => undefined,
  });

  const prevLevel = process.env.TENFOLD_LOG_LEVEL;
  if (quiet) process.env.TENFOLD_LOG_LEVEL = "error";
  const tickMs = a.tickSec * 1000;
  const snapshots: Snapshot[] = [];
  let capDay1 = 0n;
  for (let i = 0; i < a.steps; i++) {
    await runner.tick();
    const snap = ledger.latestSnapshot(cfg.id);
    if (snap) {
      snapshots.push(snap);
      if (i === 0) capDay1 = dailyCapAmount(cfg, snap, ledger.rollingState(cfg.id, now));
    }
    now += tickMs;
  }
  if (quiet) {
    if (prevLevel === undefined) delete process.env.TENFOLD_LOG_LEVEL;
    else process.env.TENFOLD_LOG_LEVEL = prevLevel;
  }

  const fills = ledger.listFills(cfg.id, { limit: 1_000_000 });
  const byReason: BacktestResult["byReason"] = {};
  let soldBase = 0n;
  let defLamports = 0n;
  let defTokens = 0n;
  let distNum = 0;
  let distDen = 0;
  for (const f of fills) {
    const r = (byReason[f.reason] ??= { count: 0, tokens: 0, sol: 0 });
    r.count += 1;
    if (f.side === "sell") {
      r.tokens += baseToTokens(f.inAmount, cfg.decimals);
      r.sol += lamportsToSol(f.outAmount);
      soldBase += f.inAmount;
      if (f.reason === "DIST") {
        const t = baseToTokens(f.inAmount, cfg.decimals);
        distNum += f.price * t;
        distDen += t;
      }
    } else {
      r.tokens += baseToTokens(f.outAmount, cfg.decimals);
      r.sol += lamportsToSol(f.inAmount);
      if (f.reason === "DEF") {
        defLamports += f.inAmount;
        defTokens += f.outAmount;
      }
    }
  }
  let tokNum = 0;
  let tokDen = 0;
  for (const s of snapshots) {
    const w = s.buyFlow5mSol + s.sellFlow5mSol || 1;
    tokNum += s.price * w;
    tokDen += w;
  }
  const tokenVwap = tokDen ? tokNum / tokDen : undefined;
  const distributionVwap = distDen ? distNum / distDen : undefined;

  const rejectedByCode: Record<string, number> = {};
  for (const o of ledger.listOrders(cfg.id, { limit: 1_000_000, status: "rejected" })) {
    const code = o.note?.split(":")[0]?.slice(0, 40) ?? "unknown";
    rejectedByCode[code] = (rejectedByCode[code] ?? 0) + 1;
  }
  const events: Record<string, number> = {};
  for (const e of ledger.listEvents(cfg.id, { limit: 1_000_000 })) {
    events[e.type] = (events[e.type] ?? 0) + 1;
    // Desk decisions and escalations are broken down by kind/topic so a noisy desk shows up in the summary.
    if (e.type === "desk_decision" || e.type === "desk_proposal") events[`  ${e.type}:${String(e.data.kind)}`] = (events[`  ${e.type}:${String(e.data.kind)}`] ?? 0) + 1;
    if (e.type === "desk_escalation") events[`  escalation:${String(e.data.topic)}`] = (events[`  escalation:${String(e.data.topic)}`] ?? 0) + 1;
  }

  const last = snapshots[snapshots.length - 1];
  const first = snapshots[0];
  const endTokens = last ? baseToTokens(last.vaultTokens, cfg.decimals) : a.tokens;
  const endSol = last ? lamportsToSol(last.vaultLamports) : a.sol;
  const rollingEnd = ledger.rollingState(cfg.id, now);
  const result: BacktestResult = {
    steps: a.steps,
    simulatedHours: (a.steps * tickMs) / 3_600_000,
    fills: fills.length,
    byReason,
    rejectedByCode,
    soldTokens: baseToTokens(soldBase, cfg.decimals),
    capTokensDay1: baseToTokens(capDay1, cfg.decimals),
    capRolling: last ? baseToTokens(dailyCapAmount(cfg, last, rollingEnd), cfg.decimals) : 0,
    distributionVwap,
    tokenVwap,
    distributionVsTokenBps: tokenVwap && distributionVwap ? Math.round(((distributionVwap - tokenVwap) / tokenVwap) * 10_000) : undefined,
    defenseSolSpent: lamportsToSol(defLamports),
    defenseBudgetSol: cfg.rules.defenseBudgetSol,
    defenseTokensBought: baseToTokens(defTokens, cfg.decimals),
    priceStart: first?.price ?? a.price,
    priceEnd: last?.price ?? a.price,
    startTokens: a.tokens,
    startSol: a.sol,
    endTokens,
    endSol,
    startValueSol: a.sol + a.tokens * a.price,
    endValueSol: endSol + endTokens * (last?.price ?? a.price),
    events,
  };
  ledger.close();
  return result;
}

function fmt(n: number, digits = 4): string {
  return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: digits }) : "n/a";
}

/** Print the result as a short human-readable report. */
export function printResult(cfg: ProjectConfig, r: BacktestResult): void {
  const lines: string[] = [];
  lines.push(`Backtest ${cfg.id} (${cfg.name}) — ${r.steps} steps, ${fmt(r.simulatedHours, 1)} simulated hours`);
  lines.push(`price ${r.priceStart.toPrecision(5)} -> ${r.priceEnd.toPrecision(5)} (${fmt(((r.priceEnd - r.priceStart) / r.priceStart) * 100, 1)}%)`);
  lines.push("");
  lines.push(`fills: ${r.fills}`);
  for (const [reason, v] of Object.entries(r.byReason)) {
    lines.push(`  ${reason.padEnd(6)} ${String(v.count).padStart(5)}  tokens ${fmt(v.tokens, 0).padStart(14)}  SOL ${fmt(v.sol, 3).padStart(10)}`);
  }
  const rej = Object.entries(r.rejectedByCode);
  if (rej.length) lines.push(`rejected: ${rej.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  lines.push("");
  const windows = Math.max(1, Math.ceil(r.simulatedHours / 24));
  lines.push(
    `tokens sold: ${fmt(r.soldTokens, 0)}  vs cap ${fmt(r.capTokensDay1, 0)} per rolling 24h at start, ${fmt(r.capRolling, 0)} at end` +
      ` (${cfg.rules.dailySellCapPct}% of balance + sold 24h; defense buys raise it)` +
      (windows > 1 ? ` over ${windows} windows` : ""),
  );
  if (r.distributionVwap !== undefined && r.tokenVwap !== undefined) {
    lines.push(`distribution VWAP ${r.distributionVwap.toPrecision(5)} vs token VWAP ${r.tokenVwap.toPrecision(5)}: ${r.distributionVsTokenBps! >= 0 ? "+" : ""}${r.distributionVsTokenBps} bps`);
  } else {
    lines.push("distribution VWAP: no DIST fills");
  }
  lines.push(`defense SOL spent: ${fmt(r.defenseSolSpent, 3)} of ${fmt(r.defenseBudgetSol, 3)} budget (${fmt(r.defenseTokensBought, 0)} tokens bought)`);
  lines.push("");
  lines.push(`inventory: ${fmt(r.startTokens, 0)} tokens + ${fmt(r.startSol, 3)} SOL  ->  ${fmt(r.endTokens, 0)} tokens + ${fmt(r.endSol, 3)} SOL`);
  lines.push(`value at mark: ${fmt(r.startValueSol, 3)} SOL -> ${fmt(r.endValueSol, 3)} SOL`);
  const ev = Object.entries(r.events);
  if (ev.length) lines.push(`events: ${ev.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  process.stdout.write(lines.join("\n") + "\n");
}

const isMain = process.argv[1] !== undefined && /backtest\.(js|ts)$/.test(process.argv[1]);
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const cfg = loadProject(args.projectId);
    const result = await runBacktest(cfg, args);
    printResult(cfg, result);
  } catch (e) {
    logger.error("backtest failed", { err: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  }
}
