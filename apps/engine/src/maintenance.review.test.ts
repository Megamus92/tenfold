/**
 * Review tests: a live fee sweep must never pay the Tenfold fee twice, whatever happens after the SOL has left the
 * project wallet (referral transfer fails, confirmation lost), and must never move more than what is accrued.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Ledger, parseProjectConfig, DEFAULT_RULES, DEFAULT_STRATEGY, solToLamports } from "@tenfold/core";
import type { Env, ProjectConfig } from "@tenfold/core";
import type { Connection } from "@solana/web3.js";
import type { Signer } from "@tenfold/exec";

/** Replace transferSol with a scripted fake; everything else in @tenfold/exec stays real. */
const transfers: { to: string; lamports: bigint }[] = [];
let script: (() => Promise<{ txSig: string; slot: number }>)[] = [];
vi.mock("@tenfold/exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tenfold/exec")>();
  return {
    ...actual,
    transferSol: vi.fn(async (_c: unknown, _s: unknown, _from: string, to: string, lamports: bigint) => {
      const step = script.shift();
      if (!step) throw new Error("unexpected transfer");
      const res = await step();
      transfers.push({ to, lamports });
      return res;
    }),
  };
});

import { Maintenance } from "./maintenance.js";

const MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const FEE_WALLET = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const REFERRER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

function liveProject(referrer?: string): ProjectConfig {
  return parseProjectConfig({
    id: "live",
    name: "Live",
    mint: MINT,
    decimals: 6,
    walletPubkey: WALLET,
    mode: "live",
    rules: { ...DEFAULT_RULES },
    strategy: { ...DEFAULT_STRATEGY },
    fees: { volumeBps: 50, cashoutBps: 200, referralBps: 1000, discountBps: 1000, ...(referrer ? { referrerWallet: referrer } : {}) },
    createdAt: Date.now(),
    paused: false,
  });
}

function env(): Env {
  return {
    rpcUrl: "https://example.com",
    dbPath: ":memory:",
    keystoreDir: "/tmp/none",
    keystorePassword: "pw",
    jitoTipLamports: 0n,
    priorityFeeMicroLamports: 50_000,
    anthropicModel: "x",
    proofPort: 1,
    proofBaseUrl: "x",
    proofSigningSecret: "",
    onboardPort: 1,
    onboardBaseUrl: "x",
    feeWallet: FEE_WALLET,
  };
}

function maintenance(l: Ledger): Maintenance {
  // The fake transferSol never touches these; the coverage check against this empty connection fails and is caught.
  return new Maintenance({ ledger: l, env: env(), connection: () => ({}) as unknown as Connection, signer: () => ({}) as unknown as Signer });
}

function lostConfirmation(sig: string): Error {
  return Object.assign(new Error(`tx ${sig} outcome unknown`), { txSig: sig, retryable: true, outcomeUnknown: true });
}

beforeEach(() => {
  transfers.length = 0;
  script = [];
});

describe("live fee sweep", () => {
  it("moves exactly the accrued net and referral, once, and leaves fees accrued after the sweep started untouched", async () => {
    const l = new Ledger(":memory:");
    const cfg = liveProject(REFERRER);
    l.upsertProject(cfg);
    l.accrueFee({ projectId: "live", kind: "volume", baseLamports: solToLamports(10), grossLamports: 50_000_000n, discountLamports: 5_000_000n, referralLamports: 4_500_000n, paper: false });
    l.accrueFee({ projectId: "live", kind: "volume", baseLamports: solToLamports(4), grossLamports: 20_000_000n, discountLamports: 2_000_000n, referralLamports: 1_800_000n, paper: false });
    const expectedNet = 40_500_000n + 16_200_000n;
    const expectedRef = 4_500_000n + 1_800_000n;
    script = [
      async () => {
        // A fill lands while the net transfer is in flight: its fee is not part of this sweep.
        l.accrueFee({ projectId: "live", kind: "volume", baseLamports: solToLamports(1), grossLamports: 5_000_000n, discountLamports: 0n, referralLamports: 0n, paper: false });
        return { txSig: "sigNet", slot: 1 };
      },
      async () => ({ txSig: "sigRef", slot: 2 }),
    ];
    const m = maintenance(l);
    l.enqueueCommand("live", "sweep_fees");
    await m.tick();
    expect(transfers).toEqual([
      { to: FEE_WALLET, lamports: expectedNet },
      { to: REFERRER, lamports: expectedRef },
    ]);
    const left = l.unsweptFees("live");
    expect(left.ids).toHaveLength(1);
    expect(left.netLamports).toBe(5_000_000n);
    expect(l.feeSummary("live").sweptLamports).toBe(expectedNet);
    // A second sweep only moves the fee accrued in flight.
    script = [async () => ({ txSig: "sigNet2", slot: 3 })];
    l.enqueueCommand("live", "sweep_fees");
    await m.tick();
    expect(transfers).toHaveLength(3);
    expect(transfers[2]).toEqual({ to: FEE_WALLET, lamports: 5_000_000n });
    expect(l.unsweptFees("live").ids).toHaveLength(0);
    l.close();
  });

  it("never pays the net fee twice when the referral transfer fails after the net transfer landed", async () => {
    const l = new Ledger(":memory:");
    const cfg = liveProject(REFERRER);
    l.upsertProject(cfg);
    l.accrueFee({ projectId: "live", kind: "volume", baseLamports: solToLamports(10), grossLamports: 50_000_000n, discountLamports: 5_000_000n, referralLamports: 4_500_000n, paper: false });
    script = [
      async () => ({ txSig: "sigNet", slot: 1 }),
      async () => {
        throw new Error("referral send failed: insufficient funds for rent");
      },
    ];
    const m = maintenance(l);
    l.enqueueCommand("live", "sweep_fees");
    await m.tick();
    expect(transfers).toEqual([{ to: FEE_WALLET, lamports: 40_500_000n }]);
    // The net fee left the wallet: the rows must be swept now, whatever happened to the referral.
    expect(l.unsweptFees("live").ids).toHaveLength(0);
    expect(l.feeSummary("live").sweptLamports).toBe(40_500_000n);
    // The command reports the failure instead of silently succeeding.
    const cmd = l.db.prepare(`SELECT status, error FROM commands`).get() as { status: string; error: string | null };
    expect(cmd.status).toBe("failed");
    expect(cmd.error).toMatch(/referral/i);
    // Retrying the sweep moves nothing.
    script = [];
    l.enqueueCommand("live", "sweep_fees");
    await m.tick();
    expect(transfers).toHaveLength(1);
    l.close();
  });

  it("does not resend the net fee when its confirmation was lost (outcome unknown, SOL may have moved)", async () => {
    const l = new Ledger(":memory:");
    l.upsertProject(liveProject());
    l.accrueFee({ projectId: "live", kind: "volume", baseLamports: solToLamports(10), grossLamports: 50_000_000n, discountLamports: 0n, referralLamports: 0n, paper: false });
    script = [
      async () => {
        throw lostConfirmation("5igLost");
      },
    ];
    const m = maintenance(l);
    l.enqueueCommand("live", "sweep_fees");
    await m.tick();
    expect(transfers).toHaveLength(0);
    // Marked swept with the signature so an operator can reconcile; never re-sent.
    const rows = l.db.prepare(`SELECT status, sweep_tx FROM fees`).all() as { status: string; sweep_tx: string | null }[];
    expect(rows).toEqual([{ status: "swept", sweep_tx: "5igLost" }]);
    const cmd = l.db.prepare(`SELECT status FROM commands`).get() as { status: string };
    expect(cmd.status).toBe("failed");
    script = [];
    l.enqueueCommand("live", "sweep_fees");
    await m.tick();
    expect(transfers).toHaveLength(0);
    l.close();
  });

  it("a net transfer that failed for sure (nothing sent) leaves the fees accrued for a later sweep", async () => {
    const l = new Ledger(":memory:");
    l.upsertProject(liveProject());
    l.accrueFee({ projectId: "live", kind: "volume", baseLamports: solToLamports(10), grossLamports: 50_000_000n, discountLamports: 0n, referralLamports: 0n, paper: false });
    script = [
      async () => {
        throw new Error("send failed: blockhash not found");
      },
    ];
    const m = maintenance(l);
    l.enqueueCommand("live", "sweep_fees");
    await m.tick();
    expect(l.unsweptFees("live").netLamports).toBe(50_000_000n);
    expect(l.feeSummary("live").sweptLamports).toBe(0n);
    l.close();
  });
});

describe("ledger.markFeesSwept", () => {
  it("is all-or-nothing: a failure mid-way leaves every row accrued", () => {
    const l = new Ledger(":memory:");
    const a = l.accrueFee({ projectId: "p", kind: "volume", baseLamports: 1n, grossLamports: 1n, discountLamports: 0n, referralLamports: 0n, paper: false });
    const b = l.accrueFee({ projectId: "p", kind: "volume", baseLamports: 1n, grossLamports: 1n, discountLamports: 0n, referralLamports: 0n, paper: false });
    // A bogus id that node:sqlite refuses to bind makes the second UPDATE throw.
    expect(() => l.markFeesSwept([a, {} as unknown as number, b], "sig")).toThrow();
    expect(l.unsweptFees("p").ids).toEqual([a, b]);
    l.close();
  });
});
