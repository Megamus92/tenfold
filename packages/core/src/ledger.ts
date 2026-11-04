/**
 * Ledger: the single SQLite database shared by the engine, the agent and the proof page.
 * Uses the built-in node:sqlite (Node >= 22.13), no native build step.
 *
 * bigint columns are stored as TEXT to stay exact above 2^53.
 */
// Loaded through getBuiltinModule so bundlers and test runners that do not know node:sqlite leave it alone.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
type DatabaseSync = import("node:sqlite").DatabaseSync;
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  BadgeTier,
  CoverageData,
  EngineEvent,
  EngineEventType,
  Fill,
  Order,
  OrderStatus,
  ProjectConfig,
  ReasonCode,
  RollingState,
  Side,
  Snapshot,
} from "./types.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type CommandType =
  | "pause"
  | "resume"
  | "reload" // re-read projects/<id>.json
  | "manual_order" // {side, amountSol | amountTokens, reason:'MANUAL'}
  | "sweep_fees" // transfer accrued fees from the project wallet to the fee wallet (and referral share)
  | "coverage_check" // re-run the badge / supply coverage check now
  | "post_approved"; // {postId} a drafted marketing post the founder approved

export interface Command {
  id: string;
  projectId: string;
  type: CommandType;
  payload: Record<string, unknown>;
  status: "pending" | "applied" | "failed";
  createdAt: number;
  appliedAt?: number;
  error?: string;
}

export class Ledger {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mint TEXT NOT NULL,
        wallet TEXT NOT NULL,
        mode TEXT NOT NULL,
        config_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        price REAL NOT NULL,
        liquidity_sol REAL,
        buy_flow_5m_sol REAL NOT NULL DEFAULT 0,
        sell_flow_5m_sol REAL NOT NULL DEFAULT 0,
        vault_tokens TEXT NOT NULL,
        vault_lamports TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS snapshots_project_ts ON snapshots(project_id, ts);
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        side TEXT NOT NULL,
        reason TEXT NOT NULL,
        input_mint TEXT NOT NULL,
        output_mint TEXT NOT NULL,
        amount_in TEXT NOT NULL,
        max_slippage_bps INTEGER NOT NULL,
        ref_price REAL NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        note TEXT,
        tx_sig TEXT
      );
      CREATE INDEX IF NOT EXISTS orders_project_created ON orders(project_id, created_at);
      CREATE TABLE IF NOT EXISTS fills (
        order_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        side TEXT NOT NULL,
        reason TEXT NOT NULL,
        in_amount TEXT NOT NULL,
        out_amount TEXT NOT NULL,
        price REAL NOT NULL,
        fee_lamports TEXT NOT NULL,
        slot INTEGER,
        ts INTEGER NOT NULL,
        tx_sig TEXT,
        paper INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS fills_project_ts ON fills(project_id, ts);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL,
        ts INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS events_project_ts ON events(project_id, ts);
      CREATE INDEX IF NOT EXISTS events_delivered ON events(delivered, ts);
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        applied_at INTEGER,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS commands_status ON commands(status, created_at);
      CREATE TABLE IF NOT EXISTS deposits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        amount TEXT NOT NULL,
        tx_sig TEXT,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS deposits_project_ts ON deposits(project_id, ts);
      CREATE TABLE IF NOT EXISTS fees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        order_id TEXT,
        base_lamports TEXT NOT NULL,
        gross_lamports TEXT NOT NULL,
        discount_lamports TEXT NOT NULL,
        referral_lamports TEXT NOT NULL,
        net_lamports TEXT NOT NULL,
        status TEXT NOT NULL,
        sweep_tx TEXT,
        paper INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS fees_project_status ON fees(project_id, status, ts);
      CREATE TABLE IF NOT EXISTS declared_wallets (
        project_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        label TEXT,
        signature TEXT,
        declared_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, wallet)
      );
      CREATE TABLE IF NOT EXISTS coverage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        tier TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS coverage_project_ts ON coverage(project_id, ts);
      CREATE TABLE IF NOT EXISTS insider_sells (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        ts INTEGER NOT NULL,
        amount TEXT NOT NULL,
        tx_sig TEXT NOT NULL UNIQUE,
        pct_of_supply REAL
      );
      CREATE INDEX IF NOT EXISTS insider_sells_project_ts ON insider_sells(project_id, ts);
      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        channel TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        external_id TEXT,
        error TEXT,
        posted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS posts_project_status ON posts(project_id, status, ts);
      CREATE TABLE IF NOT EXISTS anchors (
        project_id TEXT NOT NULL,
        day TEXT NOT NULL,
        hash TEXT NOT NULL,
        entries INTEGER NOT NULL,
        tx_sig TEXT,
        ts INTEGER NOT NULL,
        PRIMARY KEY (project_id, day)
      );
    `);
    // Additive columns on existing databases (CREATE TABLE IF NOT EXISTS leaves an old table as it was).
    const snapshotCols = (this.db.prepare(`PRAGMA table_info(snapshots)`).all() as { name: string }[]).map((c) => c.name);
    if (!snapshotCols.includes("liquidity_source")) this.db.exec(`ALTER TABLE snapshots ADD COLUMN liquidity_source TEXT`);
  }

  // ---------- projects ----------

  upsertProject(cfg: ProjectConfig): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, mint, wallet, mode, config_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, mint=excluded.mint, wallet=excluded.wallet,
           mode=excluded.mode, config_json=excluded.config_json, updated_at=excluded.updated_at`,
      )
      .run(cfg.id, cfg.name, cfg.mint, cfg.walletPubkey, cfg.mode, JSON.stringify(cfg), Date.now());
  }

  getProject(id: string): ProjectConfig | undefined {
    const row = this.db.prepare(`SELECT config_json FROM projects WHERE id = ?`).get(id) as
      | { config_json: string }
      | undefined;
    return row ? (JSON.parse(row.config_json) as ProjectConfig) : undefined;
  }

  listProjects(): ProjectConfig[] {
    const rows = this.db.prepare(`SELECT config_json FROM projects ORDER BY id`).all() as { config_json: string }[];
    return rows.map((r) => JSON.parse(r.config_json) as ProjectConfig);
  }

  // ---------- snapshots ----------

  insertSnapshot(s: Snapshot): void {
    this.db
      .prepare(
        `INSERT INTO snapshots (project_id, ts, price, liquidity_sol, liquidity_source, buy_flow_5m_sol, sell_flow_5m_sol, vault_tokens, vault_lamports)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.projectId,
        s.ts,
        s.price,
        s.liquiditySol ?? null,
        s.liquiditySource ?? null,
        s.buyFlow5mSol,
        s.sellFlow5mSol,
        s.vaultTokens.toString(),
        s.vaultLamports.toString(),
      );
  }

  latestSnapshot(projectId: string): Snapshot | undefined {
    const row = this.db
      .prepare(`SELECT * FROM snapshots WHERE project_id = ? ORDER BY ts DESC LIMIT 1`)
      .get(projectId) as SnapshotRow | undefined;
    return row ? rowToSnapshot(row) : undefined;
  }

  /** The most recent snapshot at or before `ts`. */
  snapshotAt(projectId: string, ts: number): Snapshot | undefined {
    const row = this.db
      .prepare(`SELECT * FROM snapshots WHERE project_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`)
      .get(projectId, ts) as SnapshotRow | undefined;
    return row ? rowToSnapshot(row) : undefined;
  }

  /** Snapshots in [since, until], oldest first. When the limit binds, the NEWEST rows are kept (the recent past matters most). */
  snapshotsSince(projectId: string, since: number, limit = 5000, until?: number): Snapshot[] {
    const rows = this.db
      .prepare(`SELECT * FROM snapshots WHERE project_id = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?`)
      .all(projectId, since, until ?? Number.MAX_SAFE_INTEGER, limit) as unknown as SnapshotRow[];
    return rows.map(rowToSnapshot).reverse();
  }

  // ---------- orders ----------

  insertOrder(o: Omit<Order, "id" | "createdAt" | "updatedAt" | "status"> & { status?: OrderStatus }): Order {
    const now = Date.now();
    const order: Order = { ...o, id: randomUUID(), status: o.status ?? "proposed", createdAt: now, updatedAt: now };
    this.db
      .prepare(
        `INSERT INTO orders (id, project_id, side, reason, input_mint, output_mint, amount_in, max_slippage_bps, ref_price, status, created_at, updated_at, note, tx_sig)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        order.id,
        order.projectId,
        order.side,
        order.reason,
        order.inputMint,
        order.outputMint,
        order.amountIn.toString(),
        order.maxSlippageBps,
        order.refPrice,
        order.status,
        order.createdAt,
        order.updatedAt,
        order.note ?? null,
        order.txSig ?? null,
      );
    return order;
  }

  updateOrder(id: string, patch: { status?: OrderStatus; note?: string; txSig?: string; amountIn?: bigint }): void {
    const sets: string[] = ["updated_at = ?"];
    const vals: (string | number | null)[] = [Date.now()];
    if (patch.status) {
      sets.push("status = ?");
      vals.push(patch.status);
    }
    if (patch.note !== undefined) {
      sets.push("note = ?");
      vals.push(patch.note);
    }
    if (patch.txSig !== undefined) {
      sets.push("tx_sig = ?");
      vals.push(patch.txSig);
    }
    if (patch.amountIn !== undefined) {
      sets.push("amount_in = ?");
      vals.push(patch.amountIn.toString());
    }
    vals.push(id);
    this.db.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  getOrder(id: string): Order | undefined {
    const row = this.db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id) as OrderRow | undefined;
    return row ? rowToOrder(row) : undefined;
  }

  listOrders(projectId: string, opts: { since?: number; limit?: number; status?: OrderStatus } = {}): Order[] {
    const since = opts.since ?? 0;
    const limit = opts.limit ?? 200;
    const rows = opts.status
      ? (this.db
          .prepare(
            `SELECT * FROM orders WHERE project_id = ? AND created_at >= ? AND status = ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(projectId, since, opts.status, limit) as unknown as OrderRow[])
      : (this.db
          .prepare(`SELECT * FROM orders WHERE project_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?`)
          .all(projectId, since, limit) as unknown as OrderRow[]);
    return rows.map(rowToOrder);
  }

  // ---------- fills ----------

  insertFill(f: Fill): void {
    this.db
      .prepare(
        `INSERT INTO fills (order_id, project_id, side, reason, in_amount, out_amount, price, fee_lamports, slot, ts, tx_sig, paper)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        f.orderId,
        f.projectId,
        f.side,
        f.reason,
        f.inAmount.toString(),
        f.outAmount.toString(),
        f.price,
        f.feeLamports.toString(),
        f.slot ?? null,
        f.ts,
        f.txSig ?? null,
        f.paper ? 1 : 0,
      );
    this.updateOrder(f.orderId, { status: "filled", txSig: f.txSig });
  }

  listFills(projectId: string, opts: { since?: number; until?: number; limit?: number } = {}): Fill[] {
    const since = opts.since ?? 0;
    const until = opts.until ?? Number.MAX_SAFE_INTEGER;
    const limit = opts.limit ?? 1000;
    const rows = this.db
      .prepare(`SELECT * FROM fills WHERE project_id = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?`)
      .all(projectId, since, until, limit) as unknown as FillRow[];
    return rows.map(rowToFill);
  }

  // ---------- deposits (founder funding, recorded for the report) ----------

  recordDeposit(projectId: string, kind: "token" | "sol", amount: bigint, txSig?: string, note?: string): void {
    this.db
      .prepare(`INSERT INTO deposits (project_id, ts, kind, amount, tx_sig, note) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(projectId, Date.now(), kind, amount.toString(), txSig ?? null, note ?? null);
  }

  listDeposits(projectId: string): { ts: number; kind: "token" | "sol"; amount: bigint; txSig?: string; note?: string }[] {
    const rows = this.db
      .prepare(`SELECT ts, kind, amount, tx_sig, note FROM deposits WHERE project_id = ? ORDER BY ts ASC`)
      .all(projectId) as { ts: number; kind: "token" | "sol"; amount: string; tx_sig: string | null; note: string | null }[];
    return rows.map((r) => ({ ts: r.ts, kind: r.kind, amount: BigInt(r.amount), txSig: r.tx_sig ?? undefined, note: r.note ?? undefined }));
  }

  // ---------- rolling state for the risk engine ----------

  rollingState(projectId: string, now = Date.now()): RollingState {
    const sold = this.db
      .prepare(`SELECT in_amount FROM fills WHERE project_id = ? AND side = 'sell' AND ts > ?`)
      .all(projectId, now - DAY) as { in_amount: string }[];
    const soldLast24h = sold.reduce((acc, r) => acc + BigInt(r.in_amount), 0n);

    const def24 = this.db
      .prepare(`SELECT in_amount FROM fills WHERE project_id = ? AND side = 'buy' AND reason = 'DEF' AND ts > ?`)
      .all(projectId, now - DAY) as { in_amount: string }[];
    const defenseSpentLast24hLamports = def24.reduce((acc, r) => acc + BigInt(r.in_amount), 0n);

    const defAll = this.db
      .prepare(`SELECT in_amount FROM fills WHERE project_id = ? AND side = 'buy' AND reason = 'DEF'`)
      .all(projectId) as { in_amount: string }[];
    const defenseSpentTotalLamports = defAll.reduce((acc, r) => acc + BigInt(r.in_amount), 0n);

    // Pending sells (approved/sent but not yet filled) also count toward the cap, so two strategies cannot double-spend it.
    const pendingSells = this.db
      .prepare(`SELECT amount_in FROM orders WHERE project_id = ? AND side = 'sell' AND status IN ('approved','sent') AND created_at > ?`)
      .all(projectId, now - DAY) as { amount_in: string }[];
    const pendingSold = pendingSells.reduce((acc, r) => acc + BigInt(r.amount_in), 0n);

    // Same for defense buys in flight: SOL that may already have left the vault counts against the budget until the fill lands.
    const pendingDef = this.db
      .prepare(`SELECT amount_in, created_at FROM orders WHERE project_id = ? AND side = 'buy' AND reason = 'DEF' AND status IN ('approved','sent')`)
      .all(projectId) as { amount_in: string; created_at: number }[];
    const pendingDefTotal = pendingDef.reduce((acc, r) => acc + BigInt(r.amount_in), 0n);
    const pendingDef24h = pendingDef.filter((r) => r.created_at > now - DAY).reduce((acc, r) => acc + BigInt(r.amount_in), 0n);

    const ordersLastHour = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM orders WHERE project_id = ? AND status IN ('approved','sent','filled') AND created_at > ?`)
        .get(projectId, now - HOUR) as { c: number }
    ).c;

    const snap5 = this.snapshotAt(projectId, now - 5 * 60_000);

    return {
      soldLast24h: soldLast24h + pendingSold,
      pendingSoldLast24h: pendingSold,
      defenseSpentLast24hLamports: defenseSpentLast24hLamports + pendingDef24h,
      defenseSpentTotalLamports: defenseSpentTotalLamports + pendingDefTotal,
      ordersLastHour,
      price5mAgo: snap5?.price,
    };
  }

  // ---------- events ----------

  insertEvent(ev: EngineEvent): number {
    const res = this.db
      .prepare(`INSERT INTO events (project_id, type, ts, data_json, delivered) VALUES (?, ?, ?, ?, 0)`)
      .run(ev.projectId, ev.type, ev.ts, JSON.stringify(ev.data, bigintReplacer));
    return Number(res.lastInsertRowid);
  }

  listEvents(projectId: string, opts: { since?: number; types?: EngineEventType[]; limit?: number } = {}): (EngineEvent & { id: number })[] {
    const since = opts.since ?? 0;
    const limit = opts.limit ?? 200;
    // The type filter is in SQL so the limit applies to the matching events, not to the newest N of any type.
    const types = opts.types ?? [];
    const sql = `SELECT * FROM events WHERE project_id = ? AND ts >= ?` + (types.length ? ` AND type IN (${types.map(() => "?").join(",")})` : "") + ` ORDER BY ts DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(projectId, since, ...types, limit) as unknown as EventRow[];
    return rows.map(rowToEvent);
  }

  /** Events the agent has not yet relayed to the founder. */
  undeliveredEvents(limit = 100): (EngineEvent & { id: number })[] {
    const rows = this.db.prepare(`SELECT * FROM events WHERE delivered = 0 ORDER BY ts ASC LIMIT ?`).all(limit) as unknown as EventRow[];
    return rows.map(rowToEvent);
  }

  markDelivered(ids: number[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(`UPDATE events SET delivered = 1 WHERE id = ?`);
    for (const id of ids) stmt.run(id);
  }

  // ---------- commands (agent -> engine) ----------

  enqueueCommand(projectId: string, type: CommandType, payload: Record<string, unknown> = {}): Command {
    const cmd: Command = { id: randomUUID(), projectId, type, payload, status: "pending", createdAt: Date.now() };
    this.db
      .prepare(`INSERT INTO commands (id, project_id, type, payload_json, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`)
      .run(cmd.id, cmd.projectId, cmd.type, JSON.stringify(cmd.payload), cmd.createdAt);
    return cmd;
  }

  pendingCommands(limit = 50): Command[] {
    const rows = this.db.prepare(`SELECT * FROM commands WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`).all(limit) as unknown as CommandRow[];
    return rows.map(rowToCommand);
  }

  completeCommand(id: string, error?: string): void {
    this.db
      .prepare(`UPDATE commands SET status = ?, applied_at = ?, error = ? WHERE id = ?`)
      .run(error ? "failed" : "applied", Date.now(), error ?? null, id);
  }

  // ---------- fees (accrued off-chain until the vault program takes them on-chain) ----------

  /** Record a fee accrual. `base` is the SOL leg the fee applies to (buy: SOL in; sell: SOL out; cashout: SOL withdrawn). */
  accrueFee(f: {
    projectId: string;
    kind: "volume" | "cashout";
    orderId?: string;
    baseLamports: bigint;
    grossLamports: bigint;
    discountLamports: bigint;
    referralLamports: bigint;
    paper: boolean;
    ts?: number;
  }): number {
    const net = f.grossLamports - f.discountLamports - f.referralLamports;
    const res = this.db
      .prepare(
        `INSERT INTO fees (project_id, ts, kind, order_id, base_lamports, gross_lamports, discount_lamports, referral_lamports, net_lamports, status, paper)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'accrued', ?)`,
      )
      .run(
        f.projectId,
        f.ts ?? Date.now(),
        f.kind,
        f.orderId ?? null,
        f.baseLamports.toString(),
        f.grossLamports.toString(),
        f.discountLamports.toString(),
        f.referralLamports.toString(),
        (net > 0n ? net : 0n).toString(),
        f.paper ? 1 : 0,
      );
    return Number(res.lastInsertRowid);
  }

  /** Accrued, unswept fees for a project: ids and the totals owed to Tenfold and to the referrer. */
  unsweptFees(projectId: string): { ids: number[]; netLamports: bigint; referralLamports: bigint; paper: boolean } {
    const rows = this.db
      .prepare(`SELECT id, net_lamports, referral_lamports, paper FROM fees WHERE project_id = ? AND status = 'accrued' ORDER BY ts ASC`)
      .all(projectId) as unknown as { id: number; net_lamports: string; referral_lamports: string; paper: number }[];
    let net = 0n;
    let ref = 0n;
    let paper = false;
    for (const r of rows) {
      net += BigInt(r.net_lamports);
      ref += BigInt(r.referral_lamports);
      if (r.paper) paper = true;
    }
    return { ids: rows.map((r) => r.id), netLamports: net, referralLamports: ref, paper };
  }

  /** Mark fee rows swept in one transaction: a partial mark would let the remainder be swept (paid) a second time. */
  markFeesSwept(ids: number[], txSig: string): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(`UPDATE fees SET status = 'swept', sweep_tx = ? WHERE id = ?`);
    this.db.exec("BEGIN");
    try {
      for (const id of ids) stmt.run(txSig, id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * Reserve rows for a sweep before the transfer is sent: accrued -> sweeping, all-or-nothing. unsweptFees only
   * returns accrued rows, so a crash after this point leaves the rows parked in 'sweeping' (never auto-reswept)
   * for the operator to reconcile, instead of being paid again on restart.
   */
  markFeesSweeping(ids: number[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(`UPDATE fees SET status = 'sweeping' WHERE id = ? AND status = 'accrued'`);
    this.db.exec("BEGIN");
    try {
      for (const id of ids) stmt.run(id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Release reserved rows back to accrued when a sweep failed for sure (no funds moved), so it can be retried. */
  revertFeesSweeping(ids: number[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(`UPDATE fees SET status = 'accrued' WHERE id = ? AND status = 'sweeping'`);
    this.db.exec("BEGIN");
    try {
      for (const id of ids) stmt.run(id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Fee totals for the proof page and reports. */
  feeSummary(projectId: string, since = 0): FeeSummary {
    const rows = this.db
      .prepare(`SELECT kind, gross_lamports, discount_lamports, referral_lamports, net_lamports, status FROM fees WHERE project_id = ? AND ts >= ?`)
      .all(projectId, since) as unknown as { kind: string; gross_lamports: string; discount_lamports: string; referral_lamports: string; net_lamports: string; status: string }[];
    const s: FeeSummary = { grossLamports: 0n, discountLamports: 0n, referralLamports: 0n, netLamports: 0n, sweptLamports: 0n, accruedLamports: 0n, byKind: {} };
    for (const r of rows) {
      const g = BigInt(r.gross_lamports);
      const n = BigInt(r.net_lamports);
      s.grossLamports += g;
      s.discountLamports += BigInt(r.discount_lamports);
      s.referralLamports += BigInt(r.referral_lamports);
      s.netLamports += n;
      if (r.status === "swept") s.sweptLamports += n;
      else s.accruedLamports += n;
      s.byKind[r.kind] = (s.byKind[r.kind] ?? 0n) + g;
    }
    return s;
  }

  // ---------- badge: declared wallets, coverage, insider sells ----------

  declareWallet(projectId: string, wallet: string, label?: string, signature?: string): void {
    this.db
      .prepare(
        `INSERT INTO declared_wallets (project_id, wallet, label, signature, declared_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, wallet) DO UPDATE SET label = excluded.label, signature = COALESCE(excluded.signature, declared_wallets.signature)`,
      )
      .run(projectId, wallet, label ?? null, signature ?? null, Date.now());
  }

  listDeclaredWallets(projectId: string): DeclaredWallet[] {
    const rows = this.db
      .prepare(`SELECT wallet, label, signature, declared_at FROM declared_wallets WHERE project_id = ? ORDER BY declared_at ASC`)
      .all(projectId) as unknown as { wallet: string; label: string | null; signature: string | null; declared_at: number }[];
    return rows.map((r) => ({ wallet: r.wallet, label: r.label ?? undefined, signature: r.signature ?? undefined, declaredAt: r.declared_at }));
  }

  insertCoverage(c: Coverage): number {
    const res = this.db
      .prepare(`INSERT INTO coverage (project_id, ts, tier, data_json) VALUES (?, ?, ?, ?)`)
      .run(c.projectId, c.ts, c.tier, JSON.stringify(c.data, bigintReplacer));
    return Number(res.lastInsertRowid);
  }

  latestCoverage(projectId: string): Coverage | undefined {
    const row = this.db.prepare(`SELECT project_id, ts, tier, data_json FROM coverage WHERE project_id = ? ORDER BY ts DESC LIMIT 1`).get(projectId) as
      | { project_id: string; ts: number; tier: BadgeTier; data_json: string }
      | undefined;
    return row ? { projectId: row.project_id, ts: row.ts, tier: row.tier, data: JSON.parse(row.data_json) as CoverageData } : undefined;
  }

  /** Record an insider sell once per transaction; returns false when it was already known. */
  recordInsiderSell(s: { projectId: string; wallet: string; ts: number; amount: bigint; txSig: string; pctOfSupply?: number }): boolean {
    try {
      this.db
        .prepare(`INSERT INTO insider_sells (project_id, wallet, ts, amount, tx_sig, pct_of_supply) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(s.projectId, s.wallet, s.ts, s.amount.toString(), s.txSig, s.pctOfSupply ?? null);
      return true;
    } catch {
      return false;
    }
  }

  listInsiderSells(projectId: string, since = 0, limit = 100): InsiderSell[] {
    const rows = this.db
      .prepare(`SELECT wallet, ts, amount, tx_sig, pct_of_supply FROM insider_sells WHERE project_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?`)
      .all(projectId, since, limit) as unknown as { wallet: string; ts: number; amount: string; tx_sig: string; pct_of_supply: number | null }[];
    return rows.map((r) => ({ wallet: r.wallet, ts: r.ts, amount: BigInt(r.amount), txSig: r.tx_sig, pctOfSupply: r.pct_of_supply ?? undefined }));
  }

  // ---------- marketing posts ----------

  insertPost(p: Omit<Post, "id" | "ts" | "status"> & { status?: Post["status"] }): Post {
    const post: Post = { ...p, id: randomUUID(), ts: Date.now(), status: p.status ?? "draft" };
    this.db
      .prepare(`INSERT INTO posts (id, project_id, ts, channel, kind, text, status) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(post.id, post.projectId, post.ts, post.channel, post.kind, post.text, post.status);
    return post;
  }

  updatePost(id: string, patch: { status?: Post["status"]; externalId?: string; error?: string; text?: string }): void {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    if (patch.status) {
      sets.push("status = ?");
      vals.push(patch.status);
      if (patch.status === "posted") {
        sets.push("posted_at = ?");
        vals.push(Date.now());
      }
    }
    if (patch.externalId !== undefined) {
      sets.push("external_id = ?");
      vals.push(patch.externalId);
    }
    if (patch.error !== undefined) {
      sets.push("error = ?");
      vals.push(patch.error);
    }
    if (patch.text !== undefined) {
      sets.push("text = ?");
      vals.push(patch.text);
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE posts SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  getPost(id: string): Post | undefined {
    const r = this.db.prepare(`SELECT * FROM posts WHERE id = ?`).get(id) as unknown as PostRow | undefined;
    return r ? rowToPost(r) : undefined;
  }

  listPosts(projectId: string, opts: { status?: Post["status"]; limit?: number } = {}): Post[] {
    const limit = opts.limit ?? 100;
    const rows = opts.status
      ? (this.db.prepare(`SELECT * FROM posts WHERE project_id = ? AND status = ? ORDER BY ts DESC LIMIT ?`).all(projectId, opts.status, limit) as unknown as PostRow[])
      : (this.db.prepare(`SELECT * FROM posts WHERE project_id = ? ORDER BY ts DESC LIMIT ?`).all(projectId, limit) as unknown as PostRow[]);
    return rows.map(rowToPost);
  }

  // ---------- tamper-proof daily log anchors ----------

  /** Canonical daily log for a project: every fill of that UTC day, in order; the hash of it is what goes on-chain. */
  dailyLog(projectId: string, day: string): { entries: string[]; hash: string } {
    const start = Date.parse(`${day}T00:00:00Z`);
    const end = start + DAY;
    const fills = this.listFills(projectId, { since: start, until: end - 1, limit: 100_000 }).reverse();
    const entries = fills.map((f) => [f.ts, f.side, f.reason, f.inAmount.toString(), f.outAmount.toString(), f.price.toPrecision(12), f.txSig ?? "paper"].join("|"));
    const hash = createHash("sha256").update(entries.join("\n")).digest("hex");
    return { entries, hash };
  }

  insertAnchor(a: { projectId: string; day: string; hash: string; entries: number; txSig?: string }): void {
    this.db
      .prepare(
        `INSERT INTO anchors (project_id, day, hash, entries, tx_sig, ts) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, day) DO UPDATE SET hash = excluded.hash, entries = excluded.entries, tx_sig = COALESCE(excluded.tx_sig, anchors.tx_sig), ts = excluded.ts`,
      )
      .run(a.projectId, a.day, a.hash, a.entries, a.txSig ?? null, Date.now());
  }

  listAnchors(projectId: string, limit = 60): Anchor[] {
    const rows = this.db
      .prepare(`SELECT project_id, day, hash, entries, tx_sig, ts FROM anchors WHERE project_id = ? ORDER BY day DESC LIMIT ?`)
      .all(projectId, limit) as unknown as { project_id: string; day: string; hash: string; entries: number; tx_sig: string | null; ts: number }[];
    return rows.map((r) => ({ projectId: r.project_id, day: r.day, hash: r.hash, entries: r.entries, txSig: r.tx_sig ?? undefined, ts: r.ts }));
  }

  // ---------- reports ----------

  dailyReport(projectId: string, dayEnd = Date.now()): DailyReport {
    return this.periodReport(projectId, dayEnd - DAY, dayEnd);
  }

  /** Same numbers as the daily report over any window; the weekly report is periodReport(now - 7 days, now). */
  periodReport(projectId: string, from: number, to: number): DailyReport {
    const dayStart = from;
    const dayEnd = to;
    const fills = this.listFills(projectId, { since: dayStart, until: dayEnd, limit: 100_000 });
    let soldTokens = 0n;
    let soldProceedsLamports = 0n;
    let boughtTokens = 0n;
    let boughtCostLamports = 0n;
    let defenseLamports = 0n;
    let feesLamports = 0n;
    const byReason: Record<string, number> = {};
    let sellVwapNum = 0;
    let sellVwapDen = 0;
    for (const f of fills) {
      byReason[f.reason] = (byReason[f.reason] ?? 0) + 1;
      feesLamports += f.feeLamports;
      if (f.side === "sell") {
        soldTokens += f.inAmount;
        soldProceedsLamports += f.outAmount;
        const tokens = Number(f.inAmount);
        sellVwapNum += f.price * tokens;
        sellVwapDen += tokens;
      } else {
        boughtTokens += f.outAmount;
        boughtCostLamports += f.inAmount;
        if (f.reason === "DEF") defenseLamports += f.inAmount;
      }
    }
    const snaps = this.snapshotsSince(projectId, dayStart, 100_000, dayEnd);
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    // Token VWAP proxy over the day: average of snapshot prices (flow-weighted when flow is known).
    let tokVwapNum = 0;
    let tokVwapDen = 0;
    for (const s of snaps) {
      const w = s.buyFlow5mSol + s.sellFlow5mSol || 1;
      tokVwapNum += s.price * w;
      tokVwapDen += w;
    }
    const tokenVwap = tokVwapDen ? tokVwapNum / tokVwapDen : undefined;
    const distributionVwap = sellVwapDen ? sellVwapNum / sellVwapDen : undefined;
    return {
      projectId,
      from: dayStart,
      to: dayEnd,
      fills: fills.length,
      byReason,
      soldTokens,
      soldProceedsLamports,
      boughtTokens,
      boughtCostLamports,
      defenseLamports,
      feesLamports,
      priceOpen: first?.price,
      priceClose: last?.price,
      tokenVwap,
      distributionVwap,
      distributionVsTokenBps:
        tokenVwap && distributionVwap ? Math.round(((distributionVwap - tokenVwap) / tokenVwap) * 10_000) : undefined,
      vaultTokens: last?.vaultTokens,
      vaultLamports: last?.vaultLamports,
    };
  }
}

export interface DailyReport {
  projectId: string;
  from: number;
  to: number;
  fills: number;
  byReason: Record<string, number>;
  soldTokens: bigint;
  soldProceedsLamports: bigint;
  boughtTokens: bigint;
  boughtCostLamports: bigint;
  defenseLamports: bigint;
  feesLamports: bigint;
  priceOpen?: number;
  priceClose?: number;
  tokenVwap?: number;
  distributionVwap?: number;
  /** Positive = Tenfold sold above the token's own VWAP. */
  distributionVsTokenBps?: number;
  vaultTokens?: bigint;
  vaultLamports?: bigint;
}

// ---------- row mapping ----------

interface SnapshotRow {
  project_id: string;
  ts: number;
  price: number;
  liquidity_sol: number | null;
  liquidity_source: string | null;
  buy_flow_5m_sol: number;
  sell_flow_5m_sol: number;
  vault_tokens: string;
  vault_lamports: string;
}
function rowToSnapshot(r: SnapshotRow): Snapshot {
  return {
    projectId: r.project_id,
    ts: r.ts,
    price: r.price,
    liquiditySol: r.liquidity_sol ?? undefined,
    ...(r.liquidity_source === "dex" || r.liquidity_source === "impact" ? { liquiditySource: r.liquidity_source } : {}),
    buyFlow5mSol: r.buy_flow_5m_sol,
    sellFlow5mSol: r.sell_flow_5m_sol,
    vaultTokens: BigInt(r.vault_tokens),
    vaultLamports: BigInt(r.vault_lamports),
  };
}

interface OrderRow {
  id: string;
  project_id: string;
  side: Side;
  reason: ReasonCode;
  input_mint: string;
  output_mint: string;
  amount_in: string;
  max_slippage_bps: number;
  ref_price: number;
  status: OrderStatus;
  created_at: number;
  updated_at: number;
  note: string | null;
  tx_sig: string | null;
}
function rowToOrder(r: OrderRow): Order {
  return {
    id: r.id,
    projectId: r.project_id,
    side: r.side,
    reason: r.reason,
    inputMint: r.input_mint,
    outputMint: r.output_mint,
    amountIn: BigInt(r.amount_in),
    maxSlippageBps: r.max_slippage_bps,
    refPrice: r.ref_price,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    note: r.note ?? undefined,
    txSig: r.tx_sig ?? undefined,
  };
}

interface FillRow {
  order_id: string;
  project_id: string;
  side: Side;
  reason: ReasonCode;
  in_amount: string;
  out_amount: string;
  price: number;
  fee_lamports: string;
  slot: number | null;
  ts: number;
  tx_sig: string | null;
  paper: number;
}
function rowToFill(r: FillRow): Fill {
  return {
    orderId: r.order_id,
    projectId: r.project_id,
    side: r.side,
    reason: r.reason,
    inAmount: BigInt(r.in_amount),
    outAmount: BigInt(r.out_amount),
    price: r.price,
    feeLamports: BigInt(r.fee_lamports),
    slot: r.slot ?? undefined,
    ts: r.ts,
    txSig: r.tx_sig ?? undefined,
    paper: r.paper === 1,
  };
}

interface EventRow {
  id: number;
  project_id: string;
  type: EngineEventType;
  ts: number;
  data_json: string;
}
function rowToEvent(r: EventRow): EngineEvent & { id: number } {
  return { id: r.id, projectId: r.project_id, type: r.type, ts: r.ts, data: JSON.parse(r.data_json) };
}

interface CommandRow {
  id: string;
  project_id: string;
  type: CommandType;
  payload_json: string;
  status: Command["status"];
  created_at: number;
  applied_at: number | null;
  error: string | null;
}
function rowToCommand(r: CommandRow): Command {
  return {
    id: r.id,
    projectId: r.project_id,
    type: r.type,
    payload: JSON.parse(r.payload_json),
    status: r.status,
    createdAt: r.created_at,
    appliedAt: r.applied_at ?? undefined,
    error: r.error ?? undefined,
  };
}

export interface FeeSummary {
  grossLamports: bigint;
  discountLamports: bigint;
  referralLamports: bigint;
  /** What Tenfold keeps after discount and referral. */
  netLamports: bigint;
  sweptLamports: bigint;
  accruedLamports: bigint;
  byKind: Record<string, bigint>;
}

export interface DeclaredWallet {
  wallet: string;
  label?: string;
  /** Base58 signature of the declaration message by that wallet, when the founder signed it (web onboarding). */
  signature?: string;
  declaredAt: number;
}

export interface Coverage {
  projectId: string;
  ts: number;
  tier: BadgeTier;
  data: CoverageData;
}

export interface InsiderSell {
  wallet: string;
  ts: number;
  amount: bigint;
  txSig: string;
  pctOfSupply?: number;
}

export interface Post {
  id: string;
  projectId: string;
  ts: number;
  channel: "x" | "telegram";
  /** daily_recap | milestone | level_defended | withdrawal_notice | badge_change */
  kind: string;
  text: string;
  status: "draft" | "approved" | "posted" | "failed" | "rejected";
  externalId?: string;
  error?: string;
  postedAt?: number;
}

export interface Anchor {
  projectId: string;
  day: string;
  hash: string;
  entries: number;
  txSig?: string;
  ts: number;
}

interface PostRow {
  id: string;
  project_id: string;
  ts: number;
  channel: "x" | "telegram";
  kind: string;
  text: string;
  status: Post["status"];
  external_id: string | null;
  error: string | null;
  posted_at: number | null;
}
function rowToPost(r: PostRow): Post {
  return {
    id: r.id,
    projectId: r.project_id,
    ts: r.ts,
    channel: r.channel,
    kind: r.kind,
    text: r.text,
    status: r.status,
    externalId: r.external_id ?? undefined,
    error: r.error ?? undefined,
    postedAt: r.posted_at ?? undefined,
  };
}

export function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}
