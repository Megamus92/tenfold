/**
 * Tool executors. Each takes {ledger, cfg, projectId}, reads the ledger, and either acts (pause, lower cap, reads)
 * or returns a `needsConfirmation` descriptor whose `apply()` performs the change once the founder taps Yes.
 * The agent never signs anything: changes are project JSON writes plus commands/events in the shared ledger.
 */
import { randomUUID } from "node:crypto";
import {
  WSOL_MINT,
  assess,
  baseToTokens,
  dailyCapAmount,
  dailyCapRemaining,
  defenseBudgetRemainingLamports,
  defenseCostPerHourSol,
  defenseDayRemainingLamports,
  describeMandate,
  lamportsToSol,
  mandateTargets,
  strategyFromMandate,
  loadAllProjects,
  loadProject,
  logger,
  saveProject,
  solToLamports,
  tokensToBase,
} from "@tenfold/core";
import type { DailyReport, Fill, Ledger, Post, ProjectConfig, Snapshot } from "@tenfold/core";
import { fmtChange, fmtHours, fmtPct, fmtPrice, fmtSol, fmtTime, fmtTokens } from "./format.js";
import type { MarketingInput, PostStatusFilter, ToolCall, MandateInput } from "./tools.js";

export const CAP_RAISE_DELAY_MS = 48 * 3_600_000;
/** A snapshot older than this means the engine is probably not running. */
const STALE_SNAPSHOT_MS = 2 * 60_000;

export interface ActionContext {
  ledger: Ledger;
  cfg: ProjectConfig;
  projectId: string;
  /** Injectable clock for tests. */
  now?: number;
}

export interface Confirmation {
  /** One sentence shown next to the Yes/No buttons. */
  summary: string;
  /** Performs the change; called only after the founder taps Yes. */
  apply: () => ActionResult;
}

export interface ActionResult {
  ok: boolean;
  /** Human text, safe to relay to the founder as is. */
  message: string;
  /** Structured details for the model. */
  data?: Record<string, unknown>;
  needsConfirmation?: Confirmation;
}

export interface PendingCapRaise {
  id: string;
  pct: number;
  fromPct: number;
  requestedAt: number;
  applyAt: number;
  status: "pending" | "applied" | "cancelled";
}

// ---------- persistence ----------

type Mutation = (cfg: ProjectConfig) => string | undefined;

/** Re-read the project, mutate, validate, save, mirror into the ledger and tell the engine to reload. */
function persist(ctx: ActionContext, mutate: Mutation, change: Record<string, unknown>): ActionResult {
  let cfg: ProjectConfig;
  try {
    cfg = loadProject(ctx.projectId);
  } catch {
    cfg = structuredClone(ctx.cfg);
  }
  const err = mutate(cfg);
  if (err) return { ok: false, message: err };
  try {
    saveProject(cfg);
  } catch (e) {
    return { ok: false, message: `The change was rejected by the config validator: ${(e as Error).message}` };
  }
  ctx.ledger.upsertProject(cfg);
  ctx.ledger.enqueueCommand(ctx.projectId, "reload");
  ctx.ledger.insertEvent({
    type: "config_changed",
    projectId: ctx.projectId,
    ts: ctx.now ?? Date.now(),
    data: { source: "agent", ...change },
  });
  ctx.cfg = cfg;
  return { ok: true, message: "Applied." };
}

// ---------- pending cap raises (stored as config_changed events) ----------

function isRaise(v: unknown): v is PendingCapRaise {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.pct === "number" && typeof r.applyAt === "number" && typeof r.status === "string";
}

/** Cap raises still waiting for their 48h delay. The latest event per raise id wins (pending -> applied/cancelled). */
export function pendingCapRaises(ledger: Ledger, projectId: string): PendingCapRaise[] {
  // Direct query: every config_changed row is needed, newest first, with no limit.
  const rows = ledger.db
    .prepare(`SELECT data_json FROM events WHERE project_id = ? AND type = 'config_changed' ORDER BY id DESC`)
    .all(projectId) as { data_json: string }[];
  const latest = new Map<string, PendingCapRaise>();
  for (const row of rows) {
    let data: unknown;
    try {
      data = JSON.parse(row.data_json);
    } catch {
      continue;
    }
    const raise = typeof data === "object" && data !== null ? (data as Record<string, unknown>)["pendingCapRaise"] : undefined;
    if (isRaise(raise) && !latest.has(raise.id)) latest.set(raise.id, raise);
  }
  return [...latest.values()].filter((r) => r.status === "pending");
}

function recordRaise(ctx: ActionContext, raise: PendingCapRaise): void {
  ctx.ledger.insertEvent({
    type: "config_changed",
    projectId: ctx.projectId,
    ts: ctx.now ?? Date.now(),
    data: { source: "agent", pendingCapRaise: raise },
  });
}

/** Apply every due cap raise across all projects on disk. Run at startup and hourly. Returns what changed. */
export function applyPendingCapRaises(ledger: Ledger, now = Date.now()): { projectId: string; pct: number }[] {
  const applied: { projectId: string; pct: number }[] = [];
  for (const cfg of loadAllProjects()) {
    for (const raise of pendingCapRaises(ledger, cfg.id)) {
      if (raise.applyAt > now) continue;
      const ctx: ActionContext = { ledger, cfg, projectId: cfg.id, now };
      const res = persist(
        ctx,
        (c) => {
          c.rules.dailySellCapPct = raise.pct;
          return undefined;
        },
        { rules: { dailySellCapPct: raise.pct }, scheduled: true },
      );
      if (!res.ok) {
        logger.error("cap raise failed", { projectId: cfg.id, pct: raise.pct, error: res.message });
        continue;
      }
      recordRaise(ctx, { ...raise, status: "applied" });
      applied.push({ projectId: cfg.id, pct: raise.pct });
      logger.info("cap raise applied", { projectId: cfg.id, pct: raise.pct });
    }
  }
  return applied;
}

// ---------- views ----------

interface FillView {
  ts: string;
  side: string;
  reason: string;
  tokens: number;
  sol: number;
  price: number;
  paper: boolean;
}

function fillView(f: Fill, decimals: number): FillView {
  const tokens = f.side === "sell" ? baseToTokens(f.inAmount, decimals) : baseToTokens(f.outAmount, decimals);
  const sol = f.side === "sell" ? lamportsToSol(f.outAmount) : lamportsToSol(f.inAmount);
  return { ts: fmtTime(f.ts), side: f.side, reason: f.reason, tokens, sol, price: f.price, paper: f.paper };
}

function fmtFill(f: FillView): string {
  const verb = f.side === "buy" ? "bought" : "sold";
  return `${f.ts} ${f.reason} ${verb} ${fmtTokens(f.tokens)} for ${fmtSol(f.sol)} SOL @ ${fmtPrice(f.price)}${f.paper ? " (paper)" : ""}`;
}

/** Everything the founder or the model needs to reason about the project right now. */
export function getStatus(ctx: ActionContext): ActionResult {
  const { ledger, cfg, projectId } = ctx;
  const now = ctx.now ?? Date.now();
  const snap = ledger.latestSnapshot(projectId);
  const rolling = ledger.rollingState(projectId, now);
  const d = cfg.decimals;

  const capTokens = snap ? baseToTokens(dailyCapAmount(cfg, snap, rolling), d) : undefined;
  const capRemaining = snap ? baseToTokens(dailyCapRemaining(cfg, snap, rolling), d) : undefined;
  const soldToday = baseToTokens(rolling.soldLast24h, d);
  const capUsedPct = capTokens ? Math.min(100, (soldToday / capTokens) * 100) : 0;

  const defense = {
    enabled: cfg.strategy.defense.enabled,
    levels: cfg.strategy.defense.levels,
    allocatedSol: cfg.strategy.defense.levels.reduce((a, l) => a + l.budgetSol, 0),
    budgetSol: cfg.rules.defenseBudgetSol,
    spentSol: lamportsToSol(rolling.defenseSpentTotalLamports),
    remainingSol: lamportsToSol(defenseBudgetRemainingLamports(cfg, rolling)),
    maxPerDaySol: cfg.rules.maxDefenseSpendPerDaySol,
    spentTodaySol: lamportsToSol(rolling.defenseSpentLast24hLamports),
    remainingTodaySol: lamportsToSol(defenseDayRemainingLamports(cfg, rolling)),
    costPerHourSol: snap ? defenseCostPerHourSol(snap) : undefined,
  };
  const fills = ledger.listFills(projectId, { limit: 5 }).map((f) => fillView(f, d));
  const raises = pendingCapRaises(ledger, projectId).map((r) => ({ pct: r.pct, appliesAt: fmtTime(r.applyAt), applyAt: r.applyAt }));
  const snapshotAgeMs = snap ? now - snap.ts : undefined;
  const engineStale = snapshotAgeMs === undefined || snapshotAgeMs > STALE_SNAPSHOT_MS;

  const vaultTokens = snap ? baseToTokens(snap.vaultTokens, d) : undefined;
  const vaultSol = snap ? lamportsToSol(snap.vaultLamports) : undefined;
  const vaultTokensValueSol = snap && vaultTokens !== undefined ? vaultTokens * snap.price : undefined;

  const lines: string[] = [];
  lines.push(`${cfg.name} (${cfg.mode}) ${cfg.paused ? "PAUSED" : "running"}`);
  let mandateView: Record<string, unknown> | undefined;
  if (cfg.mandate) {
    const { horizonDays, distributePct } = mandateTargets(cfg.mandate);
    const start = cfg.mandate.startTokens ? BigInt(cfg.mandate.startTokens) : 0n;
    const target = start > 0n ? (start * BigInt(Math.round(distributePct * 100))) / 10_000n : 0n;
    const distributed = ledger
      .listFills(projectId, { since: cfg.mandate.startedAt, limit: 100_000 })
      .filter((f) => f.side === "sell") // every own sell counts toward the share, as the desk and the reports count it
      .reduce((a, f) => a + f.inAmount, 0n);
    const donePct = target > 0n ? Math.min(100, (Number(distributed) / Number(target)) * 100) : undefined;
    const elapsedPct = Math.min(100, Math.max(0, ((now - cfg.mandate.startedAt) / (horizonDays * 86_400_000)) * 100));
    lines.push(`Mandate: ${describeMandate(cfg.mandate)}`);
    if (donePct !== undefined) lines.push(`Horizon: ${fmtPct(donePct)} of the target distributed at ${fmtPct(elapsedPct)} of the time`);
    mandateView = { ...cfg.mandate, horizonDays, distributePct, distributedTokens: baseToTokens(distributed, d), targetTokens: baseToTokens(target, d), donePct, elapsedPct };
  }
  if (snap) {
    const age = snapshotAgeMs !== undefined ? `${Math.round(snapshotAgeMs / 60_000)} min ago` : "";
    lines.push(`Price ${fmtPrice(snap.price)} SOL (${age}${engineStale ? ", engine may be down" : ""})`);
    lines.push(`5m flow: buys ${fmtSol(snap.buyFlow5mSol)} / sells ${fmtSol(snap.sellFlow5mSol)} SOL`);
    lines.push(`Vault: ${fmtTokens(vaultTokens)} tokens (~${fmtSol(vaultTokensValueSol)} SOL) + ${fmtSol(vaultSol)} SOL`);
    lines.push(`Daily cap ${fmtPct(cfg.rules.dailySellCapPct)}: sold ${fmtTokens(soldToday)} / ${fmtTokens(capTokens)} (${fmtPct(capUsedPct)} used)`);
  } else {
    lines.push("No market snapshot yet (engine not running or just started).");
    lines.push(`Daily cap ${fmtPct(cfg.rules.dailySellCapPct)}: sold ${fmtTokens(soldToday)} tokens in the last 24h`);
  }
  lines.push(
    `Defense ${defense.enabled ? "ON" : "OFF"}: budget ${fmtSol(defense.budgetSol)} SOL, left ${fmtSol(defense.remainingSol)}, today ${fmtSol(defense.spentTodaySol)}/${fmtSol(defense.maxPerDaySol)}` +
      (defense.costPerHourSol !== undefined ? `, holding costs ~${fmtSol(defense.costPerHourSol)} SOL/h now` : ""),
  );
  for (const l of defense.levels) lines.push(`  level ${fmtPrice(l.price)}: ${fmtSol(l.budgetSol)} SOL${l.pinned ? " (yours, pinned)" : cfg.mandate ? " (desk)" : ""}`);
  const dist = cfg.strategy.distribution;
  lines.push(
    `Distribution ${dist.enabled ? "ON" : "OFF"}: ${fmtPct(dist.pctOfVaultPerDay)}/day, ${dist.mode}` + (dist.minPrice ? `, floor ${fmtPrice(dist.minPrice)}` : ""),
  );
  for (const r of raises) lines.push(`Pending: cap raise to ${fmtPct(r.pct)} at ${r.appliesAt}`);
  if (fills.length) {
    lines.push("Last fills:");
    for (const f of fills) lines.push("  " + fmtFill(f));
  } else {
    lines.push("No fills yet.");
  }

  return {
    ok: true,
    message: lines.join("\n"),
    data: {
      project: { id: cfg.id, name: cfg.name, mode: cfg.mode, paused: cfg.paused },
      mandate: mandateView,
      engineStale,
      price: snap?.price,
      snapshotAgeSec: snapshotAgeMs !== undefined ? Math.round(snapshotAgeMs / 1000) : undefined,
      buyFlow5mSol: snap?.buyFlow5mSol,
      sellFlow5mSol: snap?.sellFlow5mSol,
      liquiditySol: snap?.liquiditySol,
      vault: { tokens: vaultTokens, sol: vaultSol, tokensValueSol: vaultTokensValueSol },
      rules: cfg.rules,
      dailyCap: { pct: cfg.rules.dailySellCapPct, capTokens, soldTokens: soldToday, remainingTokens: capRemaining, usedPct: capUsedPct },
      defense,
      distribution: dist,
      rebalance: cfg.strategy.rebalance,
      pendingCapRaises: raises,
      lastFills: fills,
    },
  };
}

/** SOL per hour to hold `price` at the current sell pressure, and how long the budgets last. */
export function costToHold(ctx: ActionContext, price: number): ActionResult {
  const { ledger, cfg, projectId } = ctx;
  const snap = ledger.latestSnapshot(projectId);
  if (!snap) return { ok: false, message: "No market snapshot yet, so I cannot price the level. Start the engine first." };
  const rolling = ledger.rollingState(projectId, ctx.now ?? Date.now());
  const costPerHour = defenseCostPerHourSol(snap);
  const level = cfg.strategy.defense.levels.find((l) => Math.abs(l.price - price) / price < 1e-6);
  const remainingSol = lamportsToSol(defenseBudgetRemainingLamports(cfg, rolling));
  const todaySol = lamportsToSol(defenseDayRemainingLamports(cfg, rolling));
  const levelBudgetSol = level ? Math.min(level.budgetSol, remainingSol) : remainingSol;
  const hours = (sol: number) => (costPerHour > 0 ? sol / costPerHour : Infinity);
  const distancePct = ((snap.price - price) / snap.price) * 100;
  const where =
    distancePct > 0.05 ? `${fmtPct(distancePct)} below the current price` : distancePct < -0.05 ? `${fmtPct(-distancePct)} ABOVE the current price (it would buy right now)` : "at the current price";
  const msg =
    `Holding ${fmtPrice(price)} (${where}) costs ~${fmtSol(costPerHour)} SOL/hour at the current pressure ` +
    `(sells ${fmtSol(snap.sellFlow5mSol)} vs buys ${fmtSol(snap.buyFlow5mSol)} SOL over 5 min). ` +
    (level ? `The level's ${fmtSol(level.budgetSol)} SOL lasts ~${fmtHours(hours(levelBudgetSol))} h; ` : `The remaining defense budget (${fmtSol(remainingSol)} SOL) lasts ~${fmtHours(hours(remainingSol))} h; `) +
    `today's limit (${fmtSol(todaySol)} SOL left) lasts ~${fmtHours(hours(todaySol))} h.` +
    (costPerHour === 0 ? " Buyers currently absorb all sells, so holding costs nothing right now." : "");
  return {
    ok: true,
    message: msg,
    data: {
      price,
      currentPrice: snap.price,
      distancePct,
      costPerHourSol: costPerHour,
      levelBudgetSol: level?.budgetSol,
      hoursLevelBudget: hours(levelBudgetSol),
      remainingBudgetSol: remainingSol,
      hoursRemainingBudget: hours(remainingSol),
      remainingTodaySol: todaySol,
      hoursToday: hours(todaySol),
    },
  };
}

/** The last 24h as a short table-like text. */
export interface ReportExtras {
  /** Desk decisions over the window, by kind. */
  desk?: Record<string, number>;
  horizon?: { donePct: number; elapsedPct: number; distributePct: number; horizonDays: number };
}

const DESK_KIND_LABELS: Record<string, string> = {
  place_level: "ladders placed",
  move_level: "ladders trailed up",
  remove_level: "levels removed",
  set_pace: "pace changes",
  set_boost: "boost set",
  distribution_done: "target reached",
  pause: "paused",
};

export function formatDailyReport(r: DailyReport, cfg: ProjectConfig, extras: ReportExtras = {}): string {
  const d = cfg.decimals;
  const sold = baseToTokens(r.soldTokens, d);
  const bought = baseToTokens(r.boughtTokens, d);
  const lines = [
    `${cfg.name}: 24h report (${fmtTime(r.from)} to ${fmtTime(r.to)})`,
    `Price: ${fmtPrice(r.priceOpen)} -> ${fmtPrice(r.priceClose)} ${fmtChange(r.priceOpen, r.priceClose)}`.trimEnd(),
    `Fills: ${r.fills}` + (r.fills ? ` (${Object.entries(r.byReason).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""),
    `Sold: ${fmtTokens(sold)} tokens for ${fmtSol(lamportsToSol(r.soldProceedsLamports))} SOL` +
      (r.distributionVwap !== undefined ? ` @ ${fmtPrice(r.distributionVwap)}` : "") +
      (r.distributionVsTokenBps !== undefined ? ` (${r.distributionVsTokenBps >= 0 ? "+" : ""}${r.distributionVsTokenBps} bps vs token VWAP)` : ""),
    `Bought: ${fmtTokens(bought)} tokens for ${fmtSol(lamportsToSol(r.boughtCostLamports))} SOL (defense ${fmtSol(lamportsToSol(r.defenseLamports))} SOL)`,
    `Fees: ${fmtSol(lamportsToSol(r.feesLamports))} SOL`,
  ];
  if (r.vaultTokens !== undefined && r.vaultLamports !== undefined) {
    lines.push(`Vault: ${fmtTokens(baseToTokens(r.vaultTokens, d))} tokens + ${fmtSol(lamportsToSol(r.vaultLamports))} SOL`);
  }
  if (extras.horizon) {
    const h = extras.horizon;
    lines.push(`Horizon: ${fmtPct(h.donePct)} of the ${h.distributePct}% target distributed at ${fmtPct(h.elapsedPct)} of the ${h.horizonDays} days`);
  }
  if (extras.desk) {
    const parts = Object.entries(extras.desk)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${DESK_KIND_LABELS[k] ?? k.replace(/_/g, " ")}`);
    lines.push(parts.length ? `Desk: ${parts.join(", ")}` : "Desk: no changes needed");
  }
  return lines.join("\n");
}

/** Pull the report extras out of a daily/weekly event's data (numbers only; nothing else is trusted). */
export function reportExtrasFrom(data: Record<string, unknown>): ReportExtras {
  const out: ReportExtras = {};
  const desk = data["desk"];
  if (desk && typeof desk === "object") {
    out.desk = {};
    for (const [k, v] of Object.entries(desk as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) out.desk[k] = v;
  }
  const h = data["horizon"];
  if (h && typeof h === "object") {
    const o = h as Record<string, unknown>;
    const n = (k: string): number | undefined => (typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : undefined);
    const donePct = n("donePct");
    const elapsedPct = n("elapsedPct");
    const distributePct = n("distributePct");
    const horizonDays = n("horizonDays");
    if (donePct !== undefined && elapsedPct !== undefined && distributePct !== undefined && horizonDays !== undefined) out.horizon = { donePct, elapsedPct, distributePct, horizonDays };
  }
  return out;
}

export function dailyReport(ctx: ActionContext): ActionResult {
  const r = ctx.ledger.dailyReport(ctx.projectId, ctx.now ?? Date.now());
  return {
    ok: true,
    message: formatDailyReport(r, ctx.cfg),
    data: JSON.parse(JSON.stringify(r, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))) as Record<string, unknown>,
  };
}

// ---------- parameter changes ----------

export function setDefenseLevel(ctx: ActionContext, input: { price: number; budgetSol: number; action: "add" | "remove" }): ActionResult {
  const { cfg } = ctx;
  const same = (l: { price: number }) => Math.abs(l.price - input.price) / input.price < 1e-6;
  const existing = cfg.strategy.defense.levels.find(same);

  if (input.action === "remove") {
    if (!existing) return { ok: false, message: `There is no defense level at ${fmtPrice(input.price)}.` };
    if (cfg.mandate && !existing.pinned) {
      return { ok: false, message: `The level at ${fmtPrice(input.price)} is the desk's: it would re-place it within minutes. To stop defending, lower the defense budget (set_defense_budget) or pause; to defend elsewhere, add your own level.` };
    }
    return {
      ok: true,
      message: "Awaiting confirmation.",
      needsConfirmation: {
        summary: `Remove the defense level at ${fmtPrice(input.price)} (${fmtSol(existing.budgetSol)} SOL allocated).`,
        apply: () =>
          persist(
            ctx,
            (c) => {
              c.strategy.defense.levels = c.strategy.defense.levels.filter((l) => !same(l));
              // Without a mandate the founder is the only source of levels; with one the desk keeps defense on.
              if (c.strategy.defense.levels.length === 0 && !c.mandate) c.strategy.defense.enabled = false;
              return undefined;
            },
            { defense: { removed: input.price } },
          ),
      },
    };
  }

  const rolling = ctx.ledger.rollingState(ctx.projectId, ctx.now ?? Date.now());
  const remainingSol = lamportsToSol(defenseBudgetRemainingLamports(cfg, rolling));
  if (input.budgetSol > remainingSol + 1e-9) {
    return {
      ok: false,
      message: `Only ${fmtSol(remainingSol)} SOL of defense budget is left (rules allow ${fmtSol(cfg.rules.defenseBudgetSol)} SOL in total). Lower the level's budget or raise the budget with set_defense_budget first.`,
      data: { remainingSol, budgetSol: cfg.rules.defenseBudgetSol },
    };
  }
  const otherAllocated = cfg.strategy.defense.levels.filter((l) => !same(l)).reduce((a, l) => a + l.budgetSol, 0);
  const overAllocated = otherAllocated + input.budgetSol > remainingSol + 1e-9;
  const snap = ctx.ledger.latestSnapshot(ctx.projectId);
  const above = snap && input.price > snap.price;
  const verb = existing ? "Update" : "Add";
  const summary =
    `${verb} defense level ${fmtPrice(input.price)} with ${fmtSol(input.budgetSol)} SOL` +
    (existing ? ` (was ${fmtSol(existing.budgetSol)} SOL)` : "") +
    (snap ? `, current price ${fmtPrice(snap.price)}` : "") +
    (above ? ". WARNING: the level is above the current price, Tenfold would buy immediately" : "") +
    (overAllocated ? `. Note: levels would allocate ${fmtSol(otherAllocated + input.budgetSol)} SOL against ${fmtSol(remainingSol)} SOL left` : "") +
    (!cfg.strategy.defense.enabled ? ". Defense will be switched on" : "") +
    ".";
  return {
    ok: true,
    message: "Awaiting confirmation.",
    data: { remainingSol, otherAllocatedSol: otherAllocated, currentPrice: snap?.price },
    needsConfirmation: {
      summary,
      apply: () =>
        persist(
          ctx,
          (c) => {
            const rem = lamportsToSol(defenseBudgetRemainingLamports(c, ctx.ledger.rollingState(ctx.projectId)));
            if (input.budgetSol > rem + 1e-9) return `Only ${fmtSol(rem)} SOL of defense budget is left now; the level was not added.`;
            const idx = c.strategy.defense.levels.findIndex(same);
            // A level the founder sets himself is pinned: the desk manager never moves or removes it.
            if (idx >= 0) c.strategy.defense.levels[idx] = { price: input.price, budgetSol: input.budgetSol, pinned: true };
            else c.strategy.defense.levels.push({ price: input.price, budgetSol: input.budgetSol, pinned: true });
            c.strategy.defense.levels.sort((a, b) => b.price - a.price);
            c.strategy.defense.enabled = true;
            return undefined;
          },
          { defense: { level: { price: input.price, budgetSol: input.budgetSol } } },
        ),
    },
  };
}

export function setDistribution(
  ctx: ActionContext,
  input: { enabled: boolean; pctOfVaultPerDay: number; mode: "strength" | "twap"; minPrice?: number },
): ActionResult {
  const cap = ctx.cfg.rules.dailySellCapPct;
  const clamped = input.pctOfVaultPerDay > cap;
  const pct = clamped ? cap : input.pctOfVaultPerDay;
  const current = ctx.cfg.strategy.distribution;
  const floor = input.minPrice === undefined ? current.minPrice : input.minPrice > 0 ? input.minPrice : undefined;
  if (ctx.cfg.mandate) {
    // The desk owns pace, mode and boost under a mandate; a founder change there would be undone within the hour.
    if (input.minPrice === undefined || floor === current.minPrice) {
      return {
        ok: false,
        message: "This project runs on a mandate: the desk sets the pace, mode and boost itself. To stop selling, set the mandate's share to 0 (set_mandate distributePct 0); to sell more or faster, change the mandate's share or horizon. Only the floor (minPrice) can be changed here.",
      };
    }
    return {
      ok: true,
      message: "Awaiting confirmation.",
      needsConfirmation: {
        summary: floor ? `Set the selling floor to ${fmtPrice(floor)}: the desk never sells under it.` : "Remove the selling floor.",
        apply: () =>
          persist(
            ctx,
            (c) => {
              if (floor) c.strategy.distribution.minPrice = floor;
              else delete c.strategy.distribution.minPrice;
              return undefined;
            },
            { distribution: { minPrice: floor ?? null } },
          ),
      },
    };
  }
  const summary =
    (input.enabled ? `Turn distribution ON: sell ${fmtPct(pct)} of the vault per day, ${input.mode} mode` : `Turn distribution OFF (settings kept: ${fmtPct(pct)}/day, ${input.mode})`) +
    (floor ? `, floor ${fmtPrice(floor)}` : ", no price floor") +
    (clamped ? `. Requested ${fmtPct(input.pctOfVaultPerDay)} was clamped to the ${fmtPct(cap)} daily cap` : "") +
    ".";
  return {
    ok: true,
    message:
      "Awaiting confirmation." +
      (clamped ? ` Note: ${fmtPct(input.pctOfVaultPerDay)}/day exceeds the daily sell cap of ${fmtPct(cap)}, so the target is clamped to ${fmtPct(cap)}. Raising the cap itself takes 48h (request_raise_daily_cap).` : ""),
    data: { clamped, pctOfVaultPerDay: pct, dailySellCapPct: cap, minPrice: floor },
    needsConfirmation: {
      summary,
      apply: () =>
        persist(
          ctx,
          (c) => {
            c.strategy.distribution = {
              enabled: input.enabled,
              pctOfVaultPerDay: Math.min(pct, c.rules.dailySellCapPct),
              mode: input.mode,
              ...(floor ? { minPrice: floor } : {}),
            };
            return undefined;
          },
          { distribution: { enabled: input.enabled, pctOfVaultPerDay: pct, mode: input.mode, minPrice: floor ?? null } },
        ),
    },
  };
}

export function setDefenseBudget(ctx: ActionContext, input: { budgetSol: number; maxPerDaySol: number }): ActionResult {
  const rolling = ctx.ledger.rollingState(ctx.projectId, ctx.now ?? Date.now());
  const spent = lamportsToSol(rolling.defenseSpentTotalLamports);
  const allocated = ctx.cfg.strategy.defense.levels.reduce((a, l) => a + l.budgetSol, 0);
  const left = Math.max(0, input.budgetSol - spent);
  const notes: string[] = [];
  if (spent > 0) notes.push(`${fmtSol(spent)} SOL already spent, so ${fmtSol(left)} SOL would remain`);
  if (allocated > left) notes.push(`levels allocate ${fmtSol(allocated)} SOL, more than what would remain`);
  if (input.maxPerDaySol > input.budgetSol) notes.push("the daily limit is above the total budget, so the total binds first");
  const summary =
    `Set defense budget to ${fmtSol(input.budgetSol)} SOL total, max ${fmtSol(input.maxPerDaySol)} SOL per day ` +
    `(was ${fmtSol(ctx.cfg.rules.defenseBudgetSol)} / ${fmtSol(ctx.cfg.rules.maxDefenseSpendPerDaySol)})` +
    (notes.length ? `. Note: ${notes.join("; ")}` : "") +
    ".";
  return {
    ok: true,
    message: "Awaiting confirmation.",
    data: { spentSol: spent, allocatedSol: allocated, remainingAfterSol: left },
    needsConfirmation: {
      summary,
      apply: () =>
        persist(
          ctx,
          (c) => {
            c.rules.defenseBudgetSol = input.budgetSol;
            c.rules.maxDefenseSpendPerDaySol = input.maxPerDaySol;
            return undefined;
          },
          { rules: { defenseBudgetSol: input.budgetSol, maxDefenseSpendPerDaySol: input.maxPerDaySol } },
        ),
    },
  };
}

/** Instant: lowering the cap only reduces what can leave the vault. Also cancels pending raises. */
export function lowerDailyCap(ctx: ActionContext, pct: number): ActionResult {
  const current = ctx.cfg.rules.dailySellCapPct;
  if (pct >= current) {
    return { ok: false, message: `The daily cap is ${fmtPct(current)}; ${fmtPct(pct)} is not lower. To raise it use request_raise_daily_cap (48h delay).` };
  }
  const res = persist(
    ctx,
    (c) => {
      c.rules.dailySellCapPct = pct;
      if (c.strategy.distribution.pctOfVaultPerDay > pct) c.strategy.distribution.pctOfVaultPerDay = pct;
      return undefined;
    },
    { rules: { dailySellCapPct: pct } },
  );
  if (!res.ok) return res;
  const cancelled = pendingCapRaises(ctx.ledger, ctx.projectId);
  for (const r of cancelled) recordRaise(ctx, { ...r, status: "cancelled" });
  const distPct = ctx.cfg.strategy.distribution.pctOfVaultPerDay;
  return {
    ok: true,
    message:
      `Daily sell cap lowered to ${fmtPct(pct)} (was ${fmtPct(current)}), effective now.` +
      (distPct === pct ? ` Distribution target clamped to ${fmtPct(pct)}/day.` : "") +
      (cancelled.length ? ` Cancelled ${cancelled.length} pending cap raise(s).` : ""),
    data: { dailySellCapPct: pct, previous: current, cancelledRaises: cancelled.length },
  };
}

/** Records a raise that applies 48h later; the founder confirms the request first. */
export function requestRaiseDailyCap(ctx: ActionContext, pct: number): ActionResult {
  const current = ctx.cfg.rules.dailySellCapPct;
  if (pct <= current) {
    return { ok: false, message: `The daily cap is already ${fmtPct(current)}; ${fmtPct(pct)} is not a raise. Use lower_daily_cap to lower it.` };
  }
  const now = ctx.now ?? Date.now();
  const applyAt = now + CAP_RAISE_DELAY_MS;
  return {
    ok: true,
    message: `Awaiting confirmation. If confirmed, the cap goes from ${fmtPct(current)} to ${fmtPct(pct)} at ${fmtTime(applyAt)} (48h from now), not before.`,
    data: { fromPct: current, toPct: pct, applyAt, appliesAt: fmtTime(applyAt) },
    needsConfirmation: {
      summary: `Schedule a raise of the daily sell cap from ${fmtPct(current)} to ${fmtPct(pct)}, applying at ${fmtTime(applyAt)} (48h delay). You can cancel it before then by lowering the cap.`,
      apply: () => {
        const existing = pendingCapRaises(ctx.ledger, ctx.projectId);
        for (const r of existing) recordRaise(ctx, { ...r, status: "cancelled" });
        recordRaise(ctx, { id: randomUUID(), pct, fromPct: current, requestedAt: now, applyAt, status: "pending" });
        return {
          ok: true,
          message: `Cap raise to ${fmtPct(pct)} scheduled for ${fmtTime(applyAt)}.` + (existing.length ? " The previous pending raise was replaced." : ""),
          data: { pct, applyAt },
        };
      },
    },
  };
}

/** Instant: stopping is always safe. Flags the project paused and tells the engine. */
export function pause(ctx: ActionContext): ActionResult {
  if (ctx.cfg.paused) return { ok: true, message: "Already paused. Nothing is trading." };
  const res = persist(
    ctx,
    (c) => {
      c.paused = true;
      return undefined;
    },
    { paused: true },
  );
  if (!res.ok) return res;
  ctx.ledger.enqueueCommand(ctx.projectId, "pause", { by: "founder" });
  return { ok: true, message: "Paused. No new orders until you resume." };
}

export function resume(ctx: ActionContext): ActionResult {
  if (!ctx.cfg.paused) return { ok: true, message: "The project is not paused." };
  return {
    ok: true,
    message: "Awaiting confirmation.",
    needsConfirmation: {
      summary: "Resume the project: defense, distribution and rebalancing start placing real orders again.",
      apply: () => {
        const res = persist(
          ctx,
          (c) => {
            c.paused = false;
            return undefined;
          },
          { paused: false },
        );
        if (!res.ok) return res;
        ctx.ledger.enqueueCommand(ctx.projectId, "resume", { by: "founder" });
        return { ok: true, message: "Resumed." };
      },
    },
  };
}

/** Pre-checks a founder-requested order with the risk engine, then enqueues it on confirmation. */
export function manualOrder(
  ctx: ActionContext,
  input: { side: "buy" | "sell"; amountSol?: number; amountTokens?: number; note: string },
): ActionResult {
  const { cfg, ledger, projectId } = ctx;
  const now = ctx.now ?? Date.now();
  const snap: Snapshot | undefined = ledger.latestSnapshot(projectId);
  if (!snap) return { ok: false, message: "No market snapshot yet, so I cannot size or check the order. The engine must be running." };
  if (snap.price <= 0) return { ok: false, message: "The latest price is zero; I will not size an order on it." };

  let amountSol = input.amountSol;
  let amountTokens = input.amountTokens;
  let converted = "";
  if (input.side === "buy") {
    if (amountSol === undefined && amountTokens !== undefined) {
      amountSol = amountTokens * snap.price;
      converted = ` (${fmtTokens(amountTokens)} tokens at ${fmtPrice(snap.price)})`;
    }
    if (amountSol === undefined) return { ok: false, message: "A buy needs amountSol." };
    amountTokens = amountSol / snap.price;
  } else {
    if (amountTokens === undefined && amountSol !== undefined) {
      amountTokens = amountSol / snap.price;
      converted = ` (~${fmtSol(amountSol)} SOL at ${fmtPrice(snap.price)})`;
    }
    if (amountTokens === undefined) return { ok: false, message: "A sell needs amountTokens." };
    amountSol = amountTokens * snap.price;
  }

  const amountIn = input.side === "buy" ? solToLamports(amountSol) : tokensToBase(amountTokens, cfg.decimals);
  const verdict = assess(
    { side: input.side, reason: "MANUAL", amountIn, maxSlippageBps: cfg.rules.maxSlippageBps, refPrice: snap.price },
    { cfg, snapshot: snap, rolling: ledger.rollingState(projectId, now), now },
  );
  if (!verdict.ok) {
    const allowed =
      verdict.allowedAmountIn !== undefined && verdict.allowedAmountIn > 0n
        ? input.side === "buy"
          ? ` Up to ${fmtSol(lamportsToSol(verdict.allowedAmountIn))} SOL would pass.`
          : ` Up to ${fmtTokens(baseToTokens(verdict.allowedAmountIn, cfg.decimals))} tokens would pass.`
        : "";
    return { ok: false, message: `The risk engine refuses this order: ${verdict.reason ?? verdict.code}${allowed}`, data: { code: verdict.code } };
  }

  const summary =
    input.side === "buy"
      ? `Manual BUY: spend ${fmtSol(amountSol)} SOL${converted} for ~${fmtTokens(amountTokens)} tokens at ~${fmtPrice(snap.price)}. Note: ${input.note}`
      : `Manual SELL: ${fmtTokens(amountTokens)} tokens${converted} for ~${fmtSol(amountSol)} SOL at ~${fmtPrice(snap.price)}. Note: ${input.note}`;
  const payload: Record<string, unknown> = {
    side: input.side,
    reason: "MANUAL",
    note: input.note,
    refPrice: snap.price,
    inputMint: input.side === "buy" ? WSOL_MINT : cfg.mint,
    outputMint: input.side === "buy" ? cfg.mint : WSOL_MINT,
    amountIn: amountIn.toString(),
    ...(input.side === "buy" ? { amountSol } : { amountTokens }),
  };
  return {
    ok: true,
    message: "Awaiting confirmation.",
    data: { amountSol, amountTokens, price: snap.price },
    needsConfirmation: {
      summary,
      apply: () => {
        const cmd = ledger.enqueueCommand(projectId, "manual_order", payload);
        return { ok: true, message: `Order queued (${cmd.id.slice(0, 8)}). The engine checks it again and fills it; I will tell you when it does.`, data: { commandId: cmd.id } };
      },
    },
  };
}

// ---------- marketing posts ----------

/** Short id shown to the founder: the first 8 characters of the post id. */
export function shortPostId(id: string): string {
  return id.slice(0, 8);
}

/** One line per post, newest first. */
export function formatPost(p: Post): string {
  const when = fmtTime(p.postedAt ?? p.ts);
  const head = `${shortPostId(p.id)} [${p.status}] ${p.channel} ${p.kind} ${when}`;
  const tail = p.status === "failed" && p.error ? ` (error: ${p.error})` : p.status === "posted" && p.externalId ? ` (id ${p.externalId})` : "";
  return `${head}${tail}\n  ${p.text.replace(/\n+/g, " / ")}`;
}

/** The project's post matching an id or an unambiguous prefix (at least 4 characters). */
export function findPost(ledger: Ledger, projectId: string, idOrPrefix: string): { post?: Post; error?: string } {
  const needle = idOrPrefix.trim().toLowerCase();
  if (needle.length < 4) return { error: "Give at least the first 4 characters of the post id." };
  const exact = ledger.getPost(needle);
  if (exact) return exact.projectId === projectId ? { post: exact } : { error: "That post belongs to another project." };
  const matches = ledger.listPosts(projectId, { limit: 500 }).filter((p) => p.id.toLowerCase().startsWith(needle));
  if (matches.length === 0) return { error: `No post starts with "${idOrPrefix}". Use list_posts to see the ids.` };
  if (matches.length > 1) return { error: `${matches.length} posts start with "${idOrPrefix}"; give more characters.` };
  return { post: matches[0] };
}

export function listPosts(ctx: ActionContext, status: PostStatusFilter = "draft"): ActionResult {
  const posts = ctx.ledger.listPosts(ctx.projectId, status === "all" ? { limit: 20 } : { status, limit: 20 });
  const mode = ctx.cfg.marketing?.mode ?? "off";
  const header = `Marketing: ${mode}` + (ctx.cfg.marketing?.xHandle ? `, X @${ctx.cfg.marketing.xHandle}` : "") + (ctx.cfg.marketing?.telegramChannelId ? `, Telegram ${ctx.cfg.marketing.telegramChannelId}` : "");
  if (posts.length === 0) {
    const what = status === "all" ? "posts" : `${status} posts`;
    return { ok: true, message: `${header}\nNo ${what}.`, data: { mode, posts: [] } };
  }
  const lines = [header, status === "all" ? `Last ${posts.length} posts:` : `${posts.length} ${status} post(s):`, ...posts.map(formatPost)];
  return {
    ok: true,
    message: lines.join("\n"),
    data: {
      mode,
      posts: posts.map((p) => ({ id: shortPostId(p.id), status: p.status, channel: p.channel, kind: p.kind, ts: fmtTime(p.ts), text: p.text, externalId: p.externalId, error: p.error })),
    },
  };
}

/** Approving publishes publicly, so the exact text is shown and the founder confirms with a button. */
export function approvePost(ctx: ActionContext, postId: string): ActionResult {
  const { post, error } = findPost(ctx.ledger, ctx.projectId, postId);
  if (!post) return { ok: false, message: error ?? "Unknown post." };
  if (post.status === "posted") return { ok: false, message: `Post ${shortPostId(post.id)} is already published${post.externalId ? ` (id ${post.externalId})` : ""}.` };
  if (post.status === "approved") return { ok: true, message: `Post ${shortPostId(post.id)} is already approved; the marketing process publishes it shortly.` };
  if (post.status === "rejected") return { ok: false, message: `Post ${shortPostId(post.id)} was rejected${post.error ? ` (${post.error})` : ""}; rejected posts are not revived.` };
  if ((ctx.cfg.marketing?.mode ?? "off") === "off") return { ok: false, message: "Marketing is off for this project; turn it on with set_marketing before approving posts." };
  const where = post.channel === "x" ? "X" : `Telegram ${ctx.cfg.marketing?.telegramChannelId ?? "channel"}`;
  return {
    ok: true,
    message: "Awaiting confirmation.",
    data: { id: shortPostId(post.id), channel: post.channel, kind: post.kind, text: post.text },
    needsConfirmation: {
      summary: `Publish on ${where} (${post.kind}${post.status === "failed" ? ", retry" : ""}):\n\n${post.text}`,
      apply: () => {
        const fresh = ctx.ledger.getPost(post.id);
        if (!fresh || (fresh.status !== "draft" && fresh.status !== "failed")) return { ok: false, message: `Post ${shortPostId(post.id)} is no longer ${post.status} (now ${fresh?.status ?? "gone"}).` };
        ctx.ledger.updatePost(post.id, { status: "approved", error: "" });
        return { ok: true, message: `Post ${shortPostId(post.id)} approved. The marketing process publishes it on ${where} within about a minute and I will send you the link.`, data: { id: post.id } };
      },
    },
  };
}

/** Not posting is always safe: instant. */
export function rejectPost(ctx: ActionContext, postId: string): ActionResult {
  const { post, error } = findPost(ctx.ledger, ctx.projectId, postId);
  if (!post) return { ok: false, message: error ?? "Unknown post." };
  if (post.status === "posted") return { ok: false, message: `Post ${shortPostId(post.id)} is already published; it cannot be rejected from here.` };
  if (post.status === "rejected") return { ok: true, message: `Post ${shortPostId(post.id)} was already rejected.` };
  ctx.ledger.updatePost(post.id, { status: "rejected", error: "rejected by founder" });
  return { ok: true, message: `Post ${shortPostId(post.id)} rejected. It will not be published.`, data: { id: post.id } };
}

export function setMarketing(ctx: ActionContext, input: MarketingInput): ActionResult {
  const current = ctx.cfg.marketing ?? { mode: "off" as const };
  const next = {
    mode: input.mode ?? current.mode,
    xHandle: input.xHandle === undefined ? current.xHandle : input.xHandle === "" ? undefined : input.xHandle,
    telegramChannelId: input.telegramChannelId === undefined ? current.telegramChannelId : input.telegramChannelId === "" ? undefined : input.telegramChannelId,
    tone: input.tone === undefined ? current.tone : input.tone === "" ? undefined : input.tone,
  };
  const changes: string[] = [];
  if (next.mode !== current.mode) changes.push(`mode ${current.mode} -> ${next.mode}`);
  if (next.xHandle !== current.xHandle) changes.push(`X handle ${current.xHandle ? "@" + current.xHandle : "none"} -> ${next.xHandle ? "@" + next.xHandle : "none"}`);
  if (next.telegramChannelId !== current.telegramChannelId) changes.push(`Telegram channel ${current.telegramChannelId ?? "none"} -> ${next.telegramChannelId ?? "none"}`);
  if (next.tone !== current.tone) changes.push(`tone ${current.tone ? `"${current.tone}"` : "default"} -> ${next.tone ? `"${next.tone}"` : "default"}`);
  if (changes.length === 0) return { ok: true, message: "Marketing settings are already like that. Nothing to change." };
  const note =
    next.mode === "auto"
      ? " In auto mode posts go out without asking; every post still comes from the ledger (recaps, milestones, levels held, withdrawal notices, badge changes including downgrades)."
      : next.mode === "approve"
        ? " In approve mode I send you each draft with Approve/Reject buttons."
        : next.mode === "off" && current.mode !== "off"
          ? " Pending drafts will expire unpublished."
          : "";
  return {
    ok: true,
    message: "Awaiting confirmation.",
    data: { current, next },
    needsConfirmation: {
      summary: `Marketing: ${changes.join("; ")}.${note}`,
      apply: () =>
        persist(
          ctx,
          (c) => {
            c.marketing = {
              mode: next.mode,
              ...(next.xHandle ? { xHandle: next.xHandle } : {}),
              ...(next.telegramChannelId ? { telegramChannelId: next.telegramChannelId } : {}),
              ...(next.tone ? { tone: next.tone } : {}),
            };
            return undefined;
          },
          { marketing: next },
        ),
    },
  };
}

/** Set or change the mandate. The desk derives the strategy from it on its next run; founder-pinned levels survive. */
export function setMandate(ctx: ActionContext, input: MandateInput): ActionResult {
  const current = ctx.cfg.mandate;
  const now = ctx.now ?? Date.now();
  const profile = input.profile ?? current?.profile;
  if (!profile) return { ok: false, message: "A mandate needs a profile: protect, balanced or distribute." };
  const horizonDays = input.horizonDays ?? current?.horizonDays;
  const distributePct = input.distributePct ?? current?.distributePct;
  // The horizon clock restarts only when what is being distributed changes (profile, share or horizon), not on a
  // re-sent same value, a floor tweak or an autonomy switch.
  const restarts = !current || profile !== current.profile || horizonDays !== current.horizonDays || distributePct !== current.distributePct;
  const next = {
    profile,
    autonomy: input.autonomy ?? current?.autonomy ?? ("auto" as const),
    horizonDays,
    distributePct,
    alertFloor: input.alertFloor === undefined ? current?.alertFloor : input.alertFloor === 0 ? undefined : input.alertFloor,
    acceptedSlowPace: input.acceptSlowPace ?? (restarts ? undefined : current?.acceptedSlowPace),
    startedAt: restarts ? now : current!.startedAt,
    startTokens: restarts ? undefined : current!.startTokens,
  };
  const changes: string[] = [];
  if (!current) changes.push("new mandate");
  if (current && next.profile !== current.profile) changes.push(`profile ${current.profile} -> ${next.profile}`);
  if (current && next.autonomy !== current.autonomy) changes.push(`autonomy ${current.autonomy} -> ${next.autonomy}`);
  if (current && next.horizonDays !== current.horizonDays) changes.push(`horizon ${current.horizonDays ?? "default"} -> ${next.horizonDays ?? "default"} days`);
  if (current && next.distributePct !== current.distributePct) changes.push(`share to distribute ${current.distributePct ?? "default"} -> ${next.distributePct ?? "default"}%`);
  if (current && next.alertFloor !== current.alertFloor) changes.push(`alert floor ${current.alertFloor ?? "none"} -> ${next.alertFloor ?? "none"}`);
  if (current && (next.acceptedSlowPace ?? false) !== (current.acceptedSlowPace ?? false)) changes.push(next.acceptedSlowPace ? "slower pace accepted" : "slower pace no longer accepted");
  if (changes.length === 0) return { ok: true, message: "The mandate is already like that. Nothing to change." };
  const pace = basePaceLine(next, ctx.cfg.rules.dailySellCapPct);
  const clock = restarts ? (current ? " The horizon restarts from today." : "") : " The horizon clock keeps running.";
  return {
    ok: true,
    message: "Awaiting confirmation.",
    data: { current, next, restarts },
    needsConfirmation: {
      summary: `Mandate: ${describeMandate(next)}. ${changes.join("; ")}.${pace}${clock} Levels you set yourself stay; the desk places and moves its own.`,
      apply: () =>
        persist(
          ctx,
          (c) => {
            c.mandate = {
              profile: next.profile,
              autonomy: next.autonomy,
              startedAt: next.startedAt,
              ...(next.horizonDays !== undefined ? { horizonDays: next.horizonDays } : {}),
              ...(next.distributePct !== undefined ? { distributePct: next.distributePct } : {}),
              ...(next.alertFloor !== undefined ? { alertFloor: next.alertFloor } : {}),
              ...(next.startTokens !== undefined ? { startTokens: next.startTokens } : {}),
              ...(next.acceptedSlowPace ? { acceptedSlowPace: true } : {}),
            };
            if (restarts) {
              // A new distribution plan: rebuild the strategy from the profile, keeping the founder's own levels and floor.
              const pinned = c.strategy.defense.levels.filter((l) => l.pinned);
              c.strategy = strategyFromMandate(c.mandate!, c);
              c.strategy.defense.levels = pinned;
              if (pinned.length > 0) c.strategy.defense.enabled = true;
            }
            // Otherwise the strategy stays as the desk left it; it adapts on its next run.
            return undefined;
          },
          { mandate: next },
        ),
    },
  };
}

function basePaceLine(m: { profile: "protect" | "balanced" | "distribute"; horizonDays?: number; distributePct?: number }, capPct: number): string {
  const { horizonDays, distributePct } = mandateTargets({ ...m, autonomy: "auto", startedAt: 0 });
  if (distributePct <= 0) return "";
  const perDay = distributePct / horizonDays;
  if (perDay > capPct * 1.05) return ` Note: ${distributePct}% over ${horizonDays} days needs ${perDay.toFixed(2)}%/day, above the ${capPct}% cap; the desk will go at the cap and tell you.`;
  return ` Pace about ${perDay.toFixed(2)}% of the vault per day.`;
}

/** Dispatch a validated tool call to its executor. */
export function runTool(ctx: ActionContext, call: ToolCall): ActionResult {
  switch (call.name) {
    case "list_posts":
      return listPosts(ctx, call.input.status);
    case "approve_post":
      return approvePost(ctx, call.input.postId);
    case "reject_post":
      return rejectPost(ctx, call.input.postId);
    case "set_marketing":
      return setMarketing(ctx, call.input);
    case "set_mandate":
      return setMandate(ctx, call.input);
    case "get_status":
      return getStatus(ctx);
    case "set_defense_level":
      return setDefenseLevel(ctx, call.input);
    case "set_distribution":
      return setDistribution(ctx, call.input);
    case "set_defense_budget":
      return setDefenseBudget(ctx, call.input);
    case "lower_daily_cap":
      return lowerDailyCap(ctx, call.input.pct);
    case "request_raise_daily_cap":
      return requestRaiseDailyCap(ctx, call.input.pct);
    case "pause":
      return pause(ctx);
    case "resume":
      return resume(ctx);
    case "manual_order":
      return manualOrder(ctx, call.input);
    case "cost_to_hold":
      return costToHold(ctx, call.input.price);
    case "daily_report":
      return dailyReport(ctx);
  }
}
