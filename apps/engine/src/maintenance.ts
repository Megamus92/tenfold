/**
 * Maintenance loop: the periodic, per-project jobs that sit beside the trading runners.
 *  - hourly badge / supply-coverage check (and on a `coverage_check` command);
 *  - once a day, hash yesterday's trade log and post that hash on-chain (a memo), so the record is tamper-proof;
 *  - on a `sweep_fees` command, move the accrued net fee to the fee wallet and the referral share to the referrer.
 *
 * It reads `sweep_fees` and `coverage_check` commands that the runners leave pending. `post_approved` is left for
 * the marketing process.
 */
import { feeTermsFor, lamportsToSol, loadProject, logger } from "@tenfold/core";
import type { Command, Env, Ledger, ProjectConfig } from "@tenfold/core";
import { runCoverageCheck, chainReaderFromExec } from "@tenfold/coverage";
import type { ChainReader } from "@tenfold/coverage";
import { postMemo, transferSol } from "@tenfold/exec";
import type { Connection } from "@solana/web3.js";
import type { Signer } from "@tenfold/exec";
import { outcomeUnknown } from "./runner.js";

const HOUR = 3_600_000;
const COVERAGE_EVERY_MS = HOUR;
const ANCHOR_CHECK_EVERY_MS = HOUR; // the daily guard inside decides when to actually post

/** UTC day string (YYYY-MM-DD) for a timestamp. */
function dayStr(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export interface MaintenanceDeps {
  ledger: Ledger;
  env: Env;
  /** Live RPC + signer, lazily created; undefined in pure-sim runs. */
  connection?: () => Connection;
  signer?: () => Signer;
}

export class Maintenance {
  private readonly ledger: Ledger;
  private readonly env: Env;
  private readonly getConn?: () => Connection;
  private readonly getSigner?: () => Signer;
  private reader?: ChainReader;
  private readonly lastCoverage = new Map<string, number>();
  private readonly lastAnchorDay = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(deps: MaintenanceDeps) {
    this.ledger = deps.ledger;
    this.env = deps.env;
    this.getConn = deps.connection;
    this.getSigner = deps.signer;
  }

  start(everyMs = 60_000): void {
    this.timer = setInterval(() => void this.run(), everyMs);
    this.timer.unref?.();
    void this.run();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Run one maintenance pass now (used by tests and the startup kick). */
  async tick(): Promise<void> {
    await this.run();
  }

  /** A chain reader for coverage, built lazily from the live connection. Undefined when there is no RPC. */
  private chainReader(): ChainReader | undefined {
    if (this.reader) return this.reader;
    if (!this.getConn) return undefined;
    try {
      this.reader = chainReaderFromExec(this.getConn());
      return this.reader;
    } catch (e) {
      logger.warn("coverage reader unavailable", { err: errMsg(e) });
      return undefined;
    }
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const projects = this.ledger.listProjects();
      // Commands first (sweeps, forced coverage checks).
      const cmds = this.ledger.pendingCommands().filter((c) => c.type === "sweep_fees" || c.type === "coverage_check");
      for (const c of cmds) await this.applyCommand(c);
      // Then the periodic jobs.
      const now = Date.now();
      for (const cfg of projects) {
        await this.maybeCoverage(cfg, now);
        await this.maybeAnchor(cfg, now);
      }
    } catch (e) {
      logger.error("maintenance run failed", { err: errMsg(e) });
    } finally {
      this.running = false;
    }
  }

  private async applyCommand(cmd: Command): Promise<void> {
    const cfg = this.ledger.getProject(cmd.projectId) ?? safeLoad(cmd.projectId);
    if (!cfg) {
      this.ledger.completeCommand(cmd.id, "unknown project");
      return;
    }
    try {
      if (cmd.type === "coverage_check") {
        await this.coverage(cfg, Date.now());
      } else if (cmd.type === "sweep_fees") {
        await this.sweep(cfg);
      }
      this.ledger.completeCommand(cmd.id);
    } catch (e) {
      this.ledger.completeCommand(cmd.id, errMsg(e));
      logger.error("maintenance command failed", { project: cfg.id, type: cmd.type, err: errMsg(e) });
    }
  }

  private async maybeCoverage(cfg: ProjectConfig, now: number): Promise<void> {
    if (now - (this.lastCoverage.get(cfg.id) ?? 0) < COVERAGE_EVERY_MS) return;
    await this.coverage(cfg, now);
  }

  private async coverage(cfg: ProjectConfig, now: number): Promise<void> {
    this.lastCoverage.set(cfg.id, now);
    const reader = this.chainReader();
    if (!reader) {
      logger.debug("coverage skipped: no chain reader (sim run)", { project: cfg.id });
      return;
    }
    await runCoverageCheck({ ledger: this.ledger, cfg, reader, now, onChainVault: false });
  }

  private async maybeAnchor(cfg: ProjectConfig, now: number): Promise<void> {
    // Anchor yesterday's completed log, once, after the UTC day rolls over.
    const yesterday = dayStr(now - 24 * HOUR);
    if (this.lastAnchorDay.get(cfg.id) === yesterday) return;
    const existing = this.ledger.listAnchors(cfg.id, 400).find((a) => a.day === yesterday);
    if (existing?.txSig || (existing && cfg.mode === "paper")) {
      this.lastAnchorDay.set(cfg.id, yesterday);
      return;
    }
    const { entries, hash } = this.ledger.dailyLog(cfg.id, yesterday);
    if (entries.length === 0) {
      this.lastAnchorDay.set(cfg.id, yesterday);
      return; // nothing happened that day, nothing to anchor
    }
    let txSig: string | undefined;
    if (cfg.mode === "live" && this.getConn && this.getSigner) {
      try {
        const memo = `TENFOLD|${cfg.id}|${yesterday}|${hash}`;
        const res = await postMemo(this.getConn(), this.getSigner(), cfg.walletPubkey, memo);
        txSig = res.txSig;
      } catch (e) {
        logger.warn("anchor memo post failed, will retry next hour", { project: cfg.id, day: yesterday, err: errMsg(e) });
        return; // leave lastAnchorDay unset so we retry
      }
    }
    this.ledger.insertAnchor({ projectId: cfg.id, day: yesterday, hash, entries: entries.length, txSig });
    this.ledger.insertEvent({ type: "anchor_posted", projectId: cfg.id, ts: now, data: { day: yesterday, hash, entries: entries.length, txSig: txSig ?? null } });
    this.lastAnchorDay.set(cfg.id, yesterday);
    logger.info("daily log anchored", { project: cfg.id, day: yesterday, entries: entries.length, hash, txSig: txSig ?? "(paper)" });
  }

  private async sweep(cfg: ProjectConfig): Promise<void> {
    const owed = this.ledger.unsweptFees(cfg.id);
    if (owed.ids.length === 0 || owed.netLamports + owed.referralLamports <= 0n) {
      logger.info("sweep: nothing to sweep", { project: cfg.id });
      return;
    }
    // Paper, or no fee wallet configured: record the intent but do not move funds, and keep fees shown as accrued.
    if (owed.paper || cfg.mode === "paper" || !this.env.feeWallet || !this.getConn || !this.getSigner) {
      logger.info("sweep skipped (paper or no fee wallet); fees stay accrued", { project: cfg.id, netSol: lamportsToSol(owed.netLamports) });
      return;
    }
    const conn = this.getConn();
    const signer = this.getSigner();
    const terms = feeTermsFor(cfg);
    // Reserve the rows before sending: accrued -> sweeping. unsweptFees ignores sweeping rows, so a crash in the
    // window between the transfer confirming and marking swept leaves them parked, never paid twice on restart.
    this.ledger.markFeesSweeping(owed.ids);
    // Net fee to the Tenfold fee wallet.
    let netTx: string;
    try {
      const netRes = await transferSol(conn, signer, cfg.walletPubkey, this.env.feeWallet, owed.netLamports, {
        memo: `TENFOLD fee ${cfg.id}`,
        priorityFeeMicroLamports: this.env.priorityFeeMicroLamports,
      });
      netTx = netRes.txSig;
    } catch (e) {
      // Sent but not confirmed: the SOL may have left the wallet. Mark the rows swept with that signature so the next
      // sweep cannot charge the founder again; the operator reconciles from the event. A sure failure is released
      // back to accrued so it can be retried.
      if (outcomeUnknown(e)) {
        const sig = (e as { txSig: string }).txSig;
        this.ledger.markFeesSwept(owed.ids, sig);
        this.ledger.insertEvent({
          type: "fees_swept",
          projectId: cfg.id,
          ts: Date.now(),
          data: { netSol: lamportsToSol(owed.netLamports), referralSol: lamportsToSol(owed.referralLamports), txSig: sig, refTx: null, paper: false, outcomeUnknown: true },
        });
        logger.error("fee sweep outcome unknown: rows marked swept, reconcile against the chain", { project: cfg.id, txSig: sig, netSol: lamportsToSol(owed.netLamports) });
      } else {
        this.ledger.revertFeesSweeping(owed.ids);
      }
      throw e;
    }
    // The net fee has left the wallet: mark the rows swept now, before anything else can fail, so no later error
    // (referral transfer, ledger write) can lead to the same fee being swept twice.
    this.ledger.markFeesSwept(owed.ids, netTx);
    // Referral share to the referrer, when there is one.
    let refTx: string | undefined;
    let refError: string | undefined;
    if (owed.referralLamports > 0n && terms.referrerWallet) {
      try {
        const refRes = await transferSol(conn, signer, cfg.walletPubkey, terms.referrerWallet, owed.referralLamports, {
          memo: `TENFOLD referral ${cfg.id}`,
          priorityFeeMicroLamports: this.env.priorityFeeMicroLamports,
        });
        refTx = refRes.txSig;
      } catch (e) {
        refError = errMsg(e);
        logger.error("referral payout failed; fee rows already swept, referral owed off-ledger", { project: cfg.id, referrer: terms.referrerWallet, referralSol: lamportsToSol(owed.referralLamports), err: refError });
      }
    }
    this.ledger.insertEvent({
      type: "fees_swept",
      projectId: cfg.id,
      ts: Date.now(),
      data: { netSol: lamportsToSol(owed.netLamports), referralSol: lamportsToSol(owed.referralLamports), txSig: netTx, refTx: refTx ?? null, paper: false, ...(refError ? { refError } : {}) },
    });
    logger.info("fees swept", { project: cfg.id, netSol: lamportsToSol(owed.netLamports), referralSol: lamportsToSol(owed.referralLamports), txSig: netTx });
    if (refError) throw new Error(`net fee swept (${netTx}) but the referral payout of ${lamportsToSol(owed.referralLamports)} SOL failed: ${refError}`);
  }
}

function safeLoad(id: string): ProjectConfig | undefined {
  try {
    return loadProject(id);
  } catch {
    return undefined;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
