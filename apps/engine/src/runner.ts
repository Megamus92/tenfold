/**
 * ProjectRunner: one loop per project. Each tick it snapshots the market, records it, runs the detectors,
 * applies founder commands, then lets each enabled strategy propose at most one order, which goes through the
 * risk engine before it reaches the executor. The runner is the only thing that writes orders, fills and
 * events for its project. Time comes from an injectable clock so backtests can run on a fake one.
 */
import {
  assess,
  baseToTokens,
  computeFee,
  defenseBudgetRemainingLamports,
  feeTermsFor,
  lamportsToSol,
  loadProject,
  logger,
  mandateTargets,
  saveProject,
  solToLamports,
  tokensToBase,
  WSOL_MINT,
} from "@tenfold/core";
import type {
  Command,
  EngineEvent,
  EngineEventType,
  Fill,
  Ledger,
  Order,
  ProjectConfig,
  ReasonCode,
  RiskVerdict,
  Rng,
  RollingState,
  Snapshot,
} from "@tenfold/core";
import {
  allStrategies,
  detectBudgetLow,
  detectCapReached,
  detectLevelHit,
  detectSellPressure,
  levelTag,
} from "@tenfold/strategies";
import type { Proposal, Strategy, StrategyInput } from "@tenfold/strategies";
import { DESK_INTERVAL_MS, decide, strategyChanged } from "./desk.js";
import type { DeskEscalation } from "./desk.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Snapshot history handed to strategies as `recentPrices`. */
const RECENT_PRICES_WINDOW = 15 * MINUTE;
/** Local hour at which the daily report is emitted. */
const DAILY_REPORT_HOUR = 9;
/** Local day of week (0 = Sunday) on which the weekly report goes out, with the daily one. */
const WEEKLY_REPORT_DOW = 1;

/** The feed contract the runner needs (structurally identical to @tenfold/exec's PriceFeed). */
export interface PriceFeed {
  snapshot(cfg: ProjectConfig): Promise<Omit<Snapshot, "projectId" | "ts">>;
}

/** The executor contract the runner needs (structurally identical to @tenfold/exec's Executor). */
export interface Executor {
  execute(order: Order, cfg: ProjectConfig, snapshot: Snapshot): Promise<Fill>;
}

export interface RunnerDeps {
  ledger: Ledger;
  feed: PriceFeed;
  executor: Executor;
  rng: Rng;
  cfg: ProjectConfig;
  /** Interval between ticks when started with start(); default 10 s. */
  tickMs?: number;
  /** Clock, default Date.now; backtests inject a fake one. */
  now?: () => number;
  /** Called after every fill is recorded (the sim feed uses it to move its balances). */
  afterFill?: (fill: Fill) => void;
  /** Persists a changed config to the projects dir; default saveProject. Backtests pass a no-op. */
  persistConfig?: (cfg: ProjectConfig) => void;
  /**
   * Re-reads the project file before the desk writes to it, so an edit the agent just saved is not overwritten;
   * default loadProject. Backtests pass undefined to work on the in-memory config.
   */
  reloadConfig?: (id: string) => ProjectConfig;
}

/** Payload of a `manual_order` command as the agent writes it; `amountIn` (base units, decimal string) is the size. */
export interface ManualOrderPayload {
  side: "buy" | "sell";
  reason?: "MANUAL";
  note?: string;
  refPrice?: number;
  inputMint?: string;
  outputMint?: string;
  /** Base units as a decimal string: lamports for a buy, token base units for a sell. */
  amountIn?: string;
  /** Fallbacks when amountIn is absent, converted at the snapshot price. */
  amountSol?: number;
  amountTokens?: number;
}

const COMMITTED = new Set<Order["status"]>(["approved", "sent", "filled"]);
const RESIZABLE = new Set<NonNullable<RiskVerdict["code"]>>(["cap", "budget", "budget_day"]);

export class ProjectRunner {
  cfg: ProjectConfig;
  readonly tickMs: number;
  private readonly ledger: Ledger;
  private readonly feed: PriceFeed;
  private readonly executor: Executor;
  private readonly rng: Rng;
  private readonly clock: () => number;
  private readonly afterFill?: (fill: Fill) => void;
  private readonly persistConfig: (cfg: ProjectConfig) => void;
  private readonly reloadConfig?: (id: string) => ProjectConfig;

  private timer?: NodeJS.Timeout;
  private running = false;
  private inTick = false;
  /** Orders of this project from the last 24h, newest first, stamped with the runner's own clock. */
  private recentOrders: Order[] = [];
  /** Snapshot prices with their timestamps, oldest first, trimmed to RECENT_PRICES_WINDOW. */
  private recentPrices: { ts: number; price: number }[] = [];
  /** Last five snapshots, for the pressure detector. */
  private recentSnapshots: Snapshot[] = [];
  /** Last time each throttled event key was emitted. */
  private lastEmitted = new Map<string, number>();
  /** Local calendar day (YYYY-MM-DD) of the last daily report. */
  private lastDailyReportDay?: string;
  /** Local calendar day of the last weekly report. */
  private lastWeeklyReportDay?: string;
  /** Desk manager bookkeeping: last run, last level change, last time each escalation topic was raised. */
  private lastDeskRun = 0;
  private lastLevelChangeAt?: number;
  private lastPaceChangeAt?: number;
  /** Timestamps of levels the desk declared lost (last 24h). */
  private lostLevelTimes: number[] = [];
  private lastEscalation = new Map<string, number>();
  private deskForce = false;
  private seeded = false;

  constructor(deps: RunnerDeps) {
    this.ledger = deps.ledger;
    this.feed = deps.feed;
    this.executor = deps.executor;
    this.rng = deps.rng;
    this.cfg = deps.cfg;
    this.tickMs = deps.tickMs ?? 10_000;
    this.clock = deps.now ?? Date.now;
    this.afterFill = deps.afterFill;
    this.persistConfig = deps.persistConfig ?? saveProject;
    this.reloadConfig = deps.reloadConfig === undefined && deps.persistConfig === undefined ? loadProject : deps.reloadConfig;
  }

  /** Current time from the injected clock. */
  now(): number {
    return this.clock();
  }

  /** Begin ticking every tickMs; the first tick runs immediately. */
  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info("runner start", { project: this.cfg.id, mode: this.cfg.mode, tickMs: this.tickMs });
    const loop = async (): Promise<void> => {
      if (!this.running) return;
      await this.tick();
      if (this.running) this.timer = setTimeout(loop, this.tickMs);
    };
    void loop();
  }

  /** Stop ticking; a tick in flight finishes. */
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    logger.info("runner stop", { project: this.cfg.id });
  }

  /** One full cycle: commands, snapshot, detectors, report, strategies. Never throws. */
  async tick(): Promise<void> {
    if (this.inTick) return;
    this.inTick = true;
    try {
      if (!this.seeded) this.seedFromLedger();
      const now = this.now();
      this.pruneMemory(now);

      // Founder commands first, so a pause takes effect before any order of this tick.
      let snapshot: Snapshot | undefined;
      let rolling: RollingState | undefined;
      const cmds = this.ledger.pendingCommands().filter((c) => c.projectId === this.cfg.id);
      const manual: Command[] = [];
      for (const c of cmds) {
        if (c.type === "manual_order") manual.push(c);
        else if (c.type === "pause" || c.type === "resume" || c.type === "reload") this.applyCommand(c, now);
        // sweep_fees, coverage_check and post_approved are owned by other loops; leave them pending.
      }

      try {
        const market = await this.feed.snapshot(this.cfg);
        snapshot = { ...market, projectId: this.cfg.id, ts: now };
      } catch (e) {
        logger.warn("feed failed, skipping tick", { project: this.cfg.id, err: errMsg(e) });
        for (const c of manual) this.ledger.completeCommand(c.id, "no market snapshot this tick, retry");
        return;
      }
      this.ledger.insertSnapshot(snapshot);
      this.recordSnapshot(snapshot);
      rolling = this.rollingState(now);

      this.runDetectors(snapshot, rolling, now);
      this.maybeDailyReport(now);
      this.runDesk(snapshot, rolling, now);

      for (const c of manual) {
        try {
          const proposal = this.manualProposal(c, snapshot);
          const outcome = await this.processProposal(proposal, snapshot, rolling, now);
          snapshot = outcome.snapshot;
          rolling = outcome.rolling;
          this.ledger.completeCommand(c.id, outcome.error);
        } catch (e) {
          this.ledger.completeCommand(c.id, errMsg(e));
          logger.error("manual order failed", { project: this.cfg.id, err: errMsg(e) });
        }
      }

      if (this.cfg.paused) return;

      for (const strategy of allStrategies(this.cfg)) {
        const proposals = this.safePropose(strategy, snapshot, rolling, now);
        const first = proposals[0];
        if (!first) continue;
        const outcome = await this.processProposal(first, snapshot, rolling, now);
        snapshot = outcome.snapshot;
        rolling = outcome.rolling;
      }
    } catch (e) {
      logger.error("tick failed", { project: this.cfg.id, err: errMsg(e) });
    } finally {
      this.inTick = false;
    }
  }

  // ---------- proposal pipeline ----------

  /** insert → assess (resize once on cap/budget) → approve → execute → fill, or reject/fail; returns the updated state. */
  private async processProposal(
    proposal: Proposal,
    snapshot: Snapshot,
    rolling: RollingState,
    now: number,
  ): Promise<{ snapshot: Snapshot; rolling: RollingState; error?: string }> {
    const stored = this.ledger.insertOrder({ ...proposal, status: "proposed" });
    // The ledger stamps real time; the runner's view uses its own clock so backtests stay coherent.
    const order: Order = { ...stored, createdAt: now, updatedAt: now };
    this.recentOrders.unshift(order);

    let verdict = assess(order, { cfg: this.cfg, snapshot, rolling, now });
    if (!verdict.ok && verdict.code && RESIZABLE.has(verdict.code) && verdict.allowedAmountIn && verdict.allowedAmountIn > 0n) {
      const resized = verdict.allowedAmountIn;
      logger.info("order resized", { project: this.cfg.id, orderId: order.id, code: verdict.code, from: order.amountIn, to: resized });
      order.amountIn = resized;
      order.note = `${order.note ?? ""} resized:${verdict.code}`.trim();
      this.ledger.updateOrder(order.id, { amountIn: resized, note: order.note });
      verdict = assess(order, { cfg: this.cfg, snapshot, rolling, now });
    }

    if (!verdict.ok) {
      const reason = verdict.reason ?? verdict.code ?? "rejected";
      order.status = "rejected";
      this.ledger.updateOrder(order.id, { status: "rejected", note: reason });
      logger.info("order rejected", { project: this.cfg.id, orderId: order.id, reason: order.reason, code: verdict.code, why: reason });
      const key = `order_rejected:${verdict.code ?? "unknown"}`;
      const throttle = order.reason === "MANUAL" ? 0 : 10 * MINUTE;
      // `reason` is the risk engine's sentence, `code` its machine code; the order's own ReasonCode travels as `orderReason`.
      this.emit(
        "order_rejected",
        now,
        { orderId: order.id, side: order.side, orderReason: order.reason, code: verdict.code, reason, amountIn: order.amountIn, note: proposal.note },
        key,
        throttle,
      );
      if (verdict.code === "circuit" && rolling.price5mAgo) {
        const movePct = (Math.abs(snapshot.price - rolling.price5mAgo) / rolling.price5mAgo) * 100;
        this.emit("circuit_breaker", now, { movePct, price: snapshot.price, price5mAgo: rolling.price5mAgo, limitPct: this.cfg.rules.circuitBreakerMovePct }, "circuit_breaker", 10 * MINUTE);
      }
      return { snapshot, rolling, error: reason };
    }

    order.status = "approved";
    this.ledger.updateOrder(order.id, { status: "approved" });

    let fill: Fill;
    try {
      fill = await this.executor.execute(order, this.cfg, snapshot);
    } catch (e) {
      const msg = errMsg(e);
      // A transaction that was sent but whose outcome the executor could not learn may still have moved the vault:
      // it stays `sent` (counted against the cap and the budget for 24h) instead of `failed`, which would free them.
      const sentUnknown = outcomeUnknown(e);
      order.status = sentUnknown ? "sent" : "failed";
      if (sentUnknown) order.txSig = (e as { txSig: string }).txSig;
      this.ledger.updateOrder(order.id, { status: order.status, note: msg, ...(order.txSig ? { txSig: order.txSig } : {}) });
      logger.error("order failed", { project: this.cfg.id, orderId: order.id, reason: order.reason, status: order.status, txSig: order.txSig, err: msg });
      this.emit("order_failed", now, { orderId: order.id, side: order.side, reason: order.reason, amountIn: order.amountIn, error: msg, txSig: order.txSig, note: proposal.note });
      return { snapshot, rolling: sentUnknown ? this.rollingState(now) : rolling, error: msg };
    }

    this.ledger.insertFill(fill);
    // Accrue the volume fee on the SOL leg of the trade (buy: SOL spent; sell: SOL received). Held in the ledger
    // until a sweep moves it to the fee wallet; in paper mode it is projected only (never swept).
    const solLeg = fill.side === "buy" ? fill.inAmount : fill.outAmount;
    if (solLeg > 0n) {
      const fee = computeFee(solLeg, feeTermsFor(this.cfg), "volume");
      if (fee.grossLamports > 0n) {
        this.ledger.accrueFee({
          projectId: this.cfg.id,
          kind: "volume",
          orderId: order.id,
          baseLamports: solLeg,
          grossLamports: fee.grossLamports,
          discountLamports: fee.discountLamports,
          referralLamports: fee.referralLamports,
          paper: fill.paper,
          ts: fill.ts,
        });
      }
    }
    order.status = "filled";
    order.txSig = fill.txSig;
    logger.info("order filled", {
      project: this.cfg.id,
      orderId: order.id,
      side: fill.side,
      reason: fill.reason,
      inAmount: fill.inAmount,
      outAmount: fill.outAmount,
      price: fill.price,
      paper: fill.paper,
    });
    this.emit("order_filled", now, {
      orderId: order.id,
      side: fill.side,
      reason: fill.reason,
      inAmount: fill.inAmount,
      outAmount: fill.outAmount,
      price: fill.price,
      feeLamports: fill.feeLamports,
      txSig: fill.txSig,
      paper: fill.paper,
      note: proposal.note,
    });
    this.afterFill?.(fill);

    // Later strategies in this tick see the vault after this fill, so two of them cannot spend the same SOL or tokens.
    const next: Snapshot = { ...snapshot };
    if (fill.side === "buy") {
      next.vaultLamports = snapshot.vaultLamports - fill.inAmount - fill.feeLamports;
      next.vaultTokens = snapshot.vaultTokens + fill.outAmount;
    } else {
      next.vaultTokens = snapshot.vaultTokens - fill.inAmount;
      next.vaultLamports = snapshot.vaultLamports + fill.outAmount - fill.feeLamports;
    }
    if (next.vaultLamports < 0n) next.vaultLamports = 0n;
    if (next.vaultTokens < 0n) next.vaultTokens = 0n;
    return { snapshot: next, rolling: this.rollingState(now) };
  }

  private safePropose(strategy: Strategy, snapshot: Snapshot, rolling: RollingState, now: number): Proposal[] {
    const input: StrategyInput = {
      cfg: this.cfg,
      snapshot,
      rolling,
      now,
      rng: this.rng,
      lastOrders: this.recentOrders,
      recentPrices: this.recentPrices.map((p) => p.price),
    };
    try {
      const out = strategy.propose(input);
      // A strategy may only ever propose its own reason code.
      return out.filter((p) => {
        if (p.reason !== strategy.name) {
          logger.warn("proposal with foreign reason dropped", { project: this.cfg.id, strategy: strategy.name, reason: p.reason });
          return false;
        }
        return true;
      });
    } catch (e) {
      logger.error("strategy threw", { project: this.cfg.id, strategy: strategy.name, err: errMsg(e) });
      return [];
    }
  }

  /** Build a MANUAL proposal from a founder command: `amountIn` (base units) is the size, SOL/token amounts are fallbacks. */
  private manualProposal(cmd: Command, snapshot: Snapshot): Proposal {
    const p = cmd.payload as Partial<ManualOrderPayload>;
    if (p.side !== "buy" && p.side !== "sell") throw new Error("manual_order: side must be 'buy' or 'sell'");
    const note = p.note && p.note.trim() !== "" ? p.note : "manual";
    const price = snapshot.price;
    // Mints are always the project's own pair, whatever the payload says: a MANUAL order never trades another token.
    const inputMint = p.side === "buy" ? WSOL_MINT : this.cfg.mint;
    const outputMint = p.side === "buy" ? this.cfg.mint : WSOL_MINT;
    if (p.inputMint !== undefined && p.inputMint !== inputMint) throw new Error(`manual_order: inputMint must be ${inputMint}`);
    if (p.outputMint !== undefined && p.outputMint !== outputMint) throw new Error(`manual_order: outputMint must be ${outputMint}`);

    let amountIn: bigint;
    if (p.amountIn !== undefined) {
      if (typeof p.amountIn !== "string" || !/^\d+$/.test(p.amountIn)) throw new Error("manual_order: amountIn must be a decimal string of base units");
      amountIn = BigInt(p.amountIn);
    } else if (p.side === "buy") {
      if (p.amountSol !== undefined && p.amountSol > 0) amountIn = solToLamports(p.amountSol);
      else if (p.amountTokens !== undefined && p.amountTokens > 0 && price > 0) amountIn = solToLamports(p.amountTokens * price);
      else throw new Error("manual_order: buy needs amountIn, amountSol or amountTokens > 0");
    } else if (p.amountTokens !== undefined && p.amountTokens > 0) amountIn = tokensToBase(p.amountTokens, this.cfg.decimals);
    else if (p.amountSol !== undefined && p.amountSol > 0 && price > 0) amountIn = tokensToBase(p.amountSol / price, this.cfg.decimals);
    else throw new Error("manual_order: sell needs amountIn, amountTokens or amountSol > 0");
    if (amountIn <= 0n) throw new Error("manual_order: amount is zero");

    return {
      projectId: this.cfg.id,
      side: p.side,
      reason: "MANUAL",
      inputMint,
      outputMint,
      amountIn,
      maxSlippageBps: this.cfg.rules.maxSlippageBps,
      refPrice: price,
      note,
    };
  }

  // ---------- commands ----------

  private applyCommand(cmd: Command, now: number): void {
    try {
      switch (cmd.type) {
        case "pause":
        case "resume": {
          const paused = cmd.type === "pause";
          if (this.cfg.paused !== paused) {
            this.cfg = { ...this.cfg, paused };
            this.persistConfig(this.cfg);
            this.ledger.upsertProject(this.cfg);
          }
          const why = typeof cmd.payload.why === "string" ? cmd.payload.why : typeof cmd.payload.note === "string" ? cmd.payload.note : undefined;
          this.emit(paused ? "paused" : "resumed", now, { by: "founder", why, commandId: cmd.id });
          break;
        }
        case "reload": {
          // The agent already saved the file and upserted the ledger row; we only swap our in-memory config.
          const fresh = loadProject(this.cfg.id);
          const changed = diffKeys(this.cfg, fresh);
          this.cfg = fresh;
          if (changed.length > 0) this.emit("config_changed", now, { source: "engine", changed, commandId: cmd.id });
          break;
        }
        default:
          throw new Error(`unknown command type ${cmd.type}`);
      }
      this.ledger.completeCommand(cmd.id);
      logger.info("command applied", { project: this.cfg.id, type: cmd.type, id: cmd.id });
    } catch (e) {
      this.ledger.completeCommand(cmd.id, errMsg(e));
      logger.error("command failed", { project: this.cfg.id, type: cmd.type, id: cmd.id, err: errMsg(e) });
    }
  }

  // ---------- detectors and reports ----------

  private runDetectors(snapshot: Snapshot, rolling: RollingState, now: number): void {
    const levels = this.cfg.strategy.defense.enabled ? this.cfg.strategy.defense.levels : [];

    const pressure = detectSellPressure(this.recentSnapshots, levels);
    let pressureEmitted = false;
    if (pressure.pressure) {
      const leftLamports = defenseBudgetRemainingLamports(this.cfg, rolling);
      const leftSol = lamportsToSol(leftLamports);
      const hoursLeft = pressure.costPerHourSol > 0 && levels.length > 0 ? leftSol / pressure.costPerHourSol : undefined;
      pressureEmitted = this.emit(
        "sell_pressure",
        now,
        {
          price: snapshot.price,
          level: pressure.nearestLevel?.price,
          costPerHourSol: pressure.costPerHourSol,
          hoursLeft,
          pctAboveLevel: pressure.pctAboveLevel,
          sellFlowSol: pressure.sellFlowSol,
          buyFlowSol: pressure.buyFlowSol,
          defenseBudgetLeftSol: leftSol,
        },
        "sell_pressure",
        10 * MINUTE,
      );
    }

    for (const level of detectLevelHit(snapshot, levels)) {
      this.emit(
        "level_hit",
        now,
        { price: snapshot.price, level: level.price, levelBudgetSol: level.budgetSol, sellFlow5mSol: snapshot.sellFlow5mSol, buyFlow5mSol: snapshot.buyFlow5mSol },
        `level_hit:${levelTag(level)}`,
        10 * MINUTE,
      );
    }

    if (this.cfg.mandate) {
      const maxBelow = this.cfg.strategy.defense.maxDistanceBelowPct ?? 15;
      if (levels.some((l) => !l.pinned && snapshot.price < l.price * (1 - maxBelow / 100))) this.deskForce = true;
      if (pressureEmitted) this.deskForce = true;
    }

    const budget = detectBudgetLow(this.cfg, rolling);
    if (budget.low) {
      if (this.cfg.mandate) this.deskForce = true;
      this.emit("budget_low", now, { leftSol: budget.remainingSol, budgetSol: budget.totalSol, pct: budget.remainingPct }, "budget_low", 6 * HOUR);
    }

    const cap = detectCapReached(this.cfg, snapshot, rolling);
    if (cap.reached) {
      this.emit(
        "cap_reached",
        now,
        { soldTokens: baseToTokens(cap.soldLast24h, this.cfg.decimals), capTokens: baseToTokens(cap.capBase, this.cfg.decimals), capPct: this.cfg.rules.dailySellCapPct },
        "cap_reached",
        DAY,
      );
    }
  }

  private maybeDailyReport(now: number): void {
    const d = new Date(now);
    if (d.getHours() < DAILY_REPORT_HOUR) return;
    const day = localDayKey(now);
    if (this.lastDailyReportDay === day) return;
    this.lastDailyReportDay = day;
    const report = this.ledger.dailyReport(this.cfg.id, now);
    this.emit("daily_report", now, { ...report, ...this.reportExtras(now, DAY) });
    if (d.getDay() === WEEKLY_REPORT_DOW && this.lastWeeklyReportDay !== day) {
      this.lastWeeklyReportDay = day;
      const week = this.ledger.periodReport(this.cfg.id, now - 7 * DAY, now);
      this.emit("weekly_report", now, { ...week, ...this.reportExtras(now, 7 * DAY) });
    }
  }

  /** What the desk did over the window and where the horizon stands, for the founder's report. */
  private reportExtras(now: number, windowMs: number): { desk: Record<string, number>; horizon?: { donePct: number; elapsedPct: number; distributePct: number; horizonDays: number } } {
    const desk: Record<string, number> = {};
    for (const ev of this.ledger.listEvents(this.cfg.id, { types: ["desk_decision"], since: now - windowMs, limit: 5000 })) {
      const kind = typeof ev.data.kind === "string" ? ev.data.kind : "other";
      if (kind === "mandate_started") continue;
      desk[kind] = (desk[kind] ?? 0) + 1;
    }
    const m = this.cfg.mandate;
    if (!m || !m.startTokens) return { desk };
    const { horizonDays, distributePct } = mandateTargets(m);
    const start = BigInt(m.startTokens);
    const target = (start * BigInt(Math.round(distributePct * 100))) / 10_000n;
    const distributed = this.ledger
      .listFills(this.cfg.id, { since: m.startedAt, limit: 100_000 })
      .filter((f) => f.side === "sell" && f.reason === "DIST")
      .reduce((a, f) => a + f.inAmount, 0n);
    const donePct = target > 0n ? Math.min(100, (Number(distributed) / Number(target)) * 100) : 0;
    const elapsedPct = Math.min(100, Math.max(0, ((now - m.startedAt) / (horizonDays * DAY)) * 100));
    return { desk, horizon: { donePct, elapsedPct, distributePct, horizonDays } };
  }

  // ---------- desk manager ----------

  /**
   * Let the desk re-evaluate the strategy: every DESK_INTERVAL_MS, or at once when a detector flagged something
   * (level lost, sell pressure, budget low). Decisions are applied and announced in `auto`, announced only in `ask`.
   */
  private runDesk(snapshot: Snapshot, rolling: RollingState, now: number): void {
    const mandate = this.cfg.mandate;
    if (!mandate) return;
    if (!this.deskForce && now - this.lastDeskRun < DESK_INTERVAL_MS) return;
    this.deskForce = false;
    this.lastDeskRun = now;
    try {
      const lookbackMs = Math.max(HOUR, 6 * HOUR);
      const history = this.ledger.snapshotsSince(this.cfg.id, now - lookbackMs, 5000).filter((s) => s.ts < now);
      const distributed = this.ledger
        .listFills(this.cfg.id, { since: mandate.startedAt, limit: 100_000 })
        .filter((f) => f.side === "sell" && f.reason === "DIST")
        .reduce((a, f) => a + f.inAmount, 0n);
      const insiderSellRecent = this.ledger.listInsiderSells(this.cfg.id, now - DAY, 1).length > 0;
      this.lostLevelTimes = this.lostLevelTimes.filter((t) => t > now - DAY);
      const out = decide({
        cfg: this.cfg,
        snapshot,
        rolling,
        now,
        history,
        recentOrders: this.recentOrders,
        distributedSinceStart: distributed,
        insiderSellRecent,
        lastLevelChangeAt: this.lastLevelChangeAt,
        lastPaceChangeAt: this.lastPaceChangeAt,
        lostLevelsLast24h: this.lostLevelTimes.length,
        lastLostAt: this.lostLevelTimes[this.lostLevelTimes.length - 1],
      });

      const changed = strategyChanged(this.cfg.strategy, out.strategy) || JSON.stringify(out.mandate) !== JSON.stringify(mandate) || out.pause !== undefined;
      if (changed && out.decisions.length > 0) {
        if (mandate.autonomy === "auto") {
          const fresh = this.reloadConfig ? this.reloadConfig(this.cfg.id) : this.cfg;
          // Pinned levels and the founder's rules are taken from the fresh file; the desk only owns strategy + mandate bookkeeping.
          this.cfg = { ...fresh, strategy: out.strategy, mandate: out.mandate };
          if (out.pause) this.cfg = { ...this.cfg, paused: true };
          this.persistConfig(this.cfg);
          this.ledger.upsertProject(this.cfg);
          if (out.decisions.some((d) => d.change.kind === "place_level" || d.change.kind === "move_level")) this.lastLevelChangeAt = now;
          if (out.decisions.some((d) => d.change.kind === "set_pace")) this.lastPaceChangeAt = now;
          for (const d of out.decisions) if (d.change.kind === "remove_level" && d.change.cause === "lost") this.lostLevelTimes.push(now);
          for (const d of out.decisions) this.emit("desk_decision", now, { ...d.change, why: d.why });
          if (out.pause) this.emit("paused", now, { by: "desk", why: out.pause.why });
        } else {
          for (const d of out.decisions) this.emit("desk_proposal", now, { ...d.change, why: d.why });
        }
        logger.info("desk", { project: this.cfg.id, autonomy: mandate.autonomy, decisions: out.decisions.map((d) => d.change.kind) });
      }
      for (const e of out.escalations) this.escalate(e, now);
    } catch (e) {
      logger.error("desk failed", { project: this.cfg.id, err: errMsg(e) });
    }
  }

  private escalate(e: DeskEscalation, now: number): void {
    const last = this.lastEscalation.get(e.topic);
    if (last !== undefined && now - last < e.throttleMs) return;
    this.lastEscalation.set(e.topic, now);
    this.emit("desk_escalation", now, { topic: e.topic, why: e.why, options: e.options });
  }

  // ---------- state ----------

  /** Rolling state from the ledger, with the order pace counted from the runner's own clock-stamped orders. */
  private rollingState(now: number): RollingState {
    const r = this.ledger.rollingState(this.cfg.id, now);
    const ordersLastHour = this.recentOrders.filter((o) => COMMITTED.has(o.status) && o.createdAt > now - HOUR).length;
    return { ...r, ordersLastHour };
  }

  private seedFromLedger(): void {
    this.seeded = true;
    const now = this.now();
    this.recentOrders = this.ledger.listOrders(this.cfg.id, { since: now - DAY, limit: 5000 });
    const snaps = this.ledger.snapshotsSince(this.cfg.id, now - RECENT_PRICES_WINDOW, 1000);
    this.recentPrices = snaps.map((s) => ({ ts: s.ts, price: s.price }));
    this.recentSnapshots = snaps.slice(-5);
    const last = this.ledger.listEvents(this.cfg.id, { types: ["daily_report"], limit: 50 })[0];
    if (last) this.lastDailyReportDay = localDayKey(last.ts);
    const weekly = this.ledger.listEvents(this.cfg.id, { types: ["weekly_report"], limit: 1 })[0];
    if (weekly) this.lastWeeklyReportDay = localDayKey(weekly.ts);
    for (const ev of this.ledger.listEvents(this.cfg.id, { types: ["desk_escalation"], since: now - 7 * DAY, limit: 200 })) {
      const topic = typeof ev.data.topic === "string" ? ev.data.topic : undefined;
      if (topic && (this.lastEscalation.get(topic) ?? 0) < ev.ts) this.lastEscalation.set(topic, ev.ts);
    }
    const deskEvents = this.ledger.listEvents(this.cfg.id, { types: ["desk_decision"], since: now - DAY, limit: 2000 });
    const placed = deskEvents.find((ev) => ev.data.kind === "place_level" || ev.data.kind === "move_level");
    if (placed) this.lastLevelChangeAt = placed.ts;
    const paced = deskEvents.find((ev) => ev.data.kind === "set_pace");
    if (paced) this.lastPaceChangeAt = paced.ts;
    this.lostLevelTimes = deskEvents
      .filter((ev) => ev.data.kind === "remove_level" && ev.data.cause === "lost")
      .map((ev) => ev.ts)
      .sort((a, b) => a - b);
  }

  private recordSnapshot(s: Snapshot): void {
    this.recentPrices.push({ ts: s.ts, price: s.price });
    this.recentSnapshots.push(s);
    if (this.recentSnapshots.length > 5) this.recentSnapshots.shift();
  }

  private pruneMemory(now: number): void {
    this.recentOrders = this.recentOrders.filter((o) => o.createdAt > now - DAY);
    this.recentPrices = this.recentPrices.filter((p) => p.ts > now - RECENT_PRICES_WINDOW);
  }

  /** Insert an event, or skip it when `key` was emitted less than `throttleMs` ago. */
  private emit(type: EngineEventType, ts: number, data: Record<string, unknown>, key?: string, throttleMs = 0): boolean {
    if (key && throttleMs > 0) {
      const last = this.lastEmitted.get(key);
      if (last !== undefined && ts - last < throttleMs) return false;
      this.lastEmitted.set(key, ts);
    }
    const ev: EngineEvent = { type, projectId: this.cfg.id, ts, data };
    this.ledger.insertEvent(ev);
    return true;
  }
}

/** Reason codes the runner accepts from strategies plus the founder's MANUAL. */
export const RUNNER_REASONS: readonly ReasonCode[] = ["DEF", "DIST", "REB", "MANUAL"];

/** Local calendar day as YYYY-MM-DD. */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Top-level keys whose JSON differs between two configs. */
export function diffKeys(a: ProjectConfig, b: ProjectConfig): string[] {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    const av = JSON.stringify((a as unknown as Record<string, unknown>)[k]);
    const bv = JSON.stringify((b as unknown as Record<string, unknown>)[k]);
    if (av !== bv) out.push(k);
  }
  return out;
}

/** Message of an unknown thrown value. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** True for an executor error that says the transaction was sent (`txSig`) but its result could not be determined (`outcomeUnknown`). */
export function outcomeUnknown(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const o = e as { txSig?: unknown; outcomeUnknown?: unknown };
  return typeof o.txSig === "string" && o.txSig !== "" && o.outcomeUnknown === true;
}
