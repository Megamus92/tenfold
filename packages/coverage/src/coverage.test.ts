import { describe, it, expect } from "vitest";
import { DEFAULT_RULES, DEFAULT_STRATEGY, Ledger, parseProjectConfig, type Coverage, type ProjectConfig } from "@tenfold/core";
import { computeTier, dangerousExtensionsOf, minTier, MAX_TIER_WITHOUT_VAULT, type TierInput } from "./tiers.js";
import { assessLp, pctOf, runCoverageCheck, PUMPSWAP_PROGRAM, type StoredCoverageData } from "./check.js";
import { badgeStatement, BADGE_MEANING } from "./verify.js";
import { chainReaderFromExec } from "./adapter.js";
import type { ChainReader, Holder, MintInfo, PoolInfo, SellRecord } from "./types.js";

const MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const VAULT = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const FOUNDER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const LINKED = "3yFwqXBfZY4jBVUafQ1YEXw189y2dN3V5KQKpKDgPzNe";
const LOCK_ESCROW = "F1ockEscrow1111111111111111111111111111111111";
const STREAMFLOW = "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUyaFaDHk";
const RAY_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const INCINERATOR = "1nc1nerator11111111111111111111111111111111";
const TX1 = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const TX2 = "2ZE7Rz1sWuq6Lk4wWz9wYyA2a8Vb6rJd3mB5nGq7hT1pXfQ9cN4yJ8kL2vM6sR3tU5wX7zA9bC1dE3fG5hJ7kL9m";
const DAY = 86_400_000;
const SUPPLY = 1_000_000_000_000_000n; // 1e9 tokens at 6 decimals

function cfg(over: Partial<ProjectConfig> = {}): ProjectConfig {
  return parseProjectConfig({
    id: "test",
    name: "Test Token",
    mint: MINT,
    decimals: 6,
    walletPubkey: VAULT,
    mode: "paper",
    rules: { ...DEFAULT_RULES },
    strategy: { ...DEFAULT_STRATEGY },
    declaredWallets: [FOUNDER],
    createdAt: 1_700_000_000_000,
    paused: false,
    ...over,
  });
}

function tierInput(over: Partial<TierInput> = {}): TierInput {
  return {
    mode: "live",
    onChainVault: true,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    lpSecured: true,
    lpReason: "PumpSwap pool, LP held by the pool",
    extensions: [],
    totalSupply: SUPPLY,
    vaultPct: 10,
    insiderWallets: [{ wallet: FOUNDER, pctOfSupply: 0.5, declared: true, locked: false }],
    insiderOutsidePct: 0.5,
    insiderSellCount: 0,
    insiderSellCount30d: 0,
    ...over,
  };
}

/** In-memory chain: balances, holders, sells and linked wallets are plain fields the test mutates. */
class FakeReader implements ChainReader {
  mint: MintInfo = { decimals: 6, supply: SUPPLY, mintAuthority: null, freezeAuthority: null, programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", extensions: [] };
  balances = new Map<string, bigint>([
    [VAULT, SUPPLY / 10n],
    [FOUNDER, SUPPLY / 20n],
    [LINKED, SUPPLY / 50n],
  ]);
  holders: Holder[] = [{ owner: LOCK_ESCROW, amount: SUPPLY / 4n }];
  ownerPrograms = new Map<string, string>([[LOCK_ESCROW, STREAMFLOW]]);
  linked: string[] = [LINKED];
  sells: SellRecord[] = [];
  pool: PoolInfo | undefined = { program: PUMPSWAP_PROGRAM, address: "PoolPda1111111111111111111111111111111111111", lpMint: null };
  slot = 1000;
  failing = false;
  calls: string[] = [];

  private guard(name: string): void {
    this.calls.push(name);
    if (this.failing) throw new Error("rpc down");
  }
  async getMintInfo(mint: string): Promise<MintInfo> {
    this.guard("getMintInfo");
    return mint === MINT ? this.mint : { decimals: 0, supply: 0n, mintAuthority: null, freezeAuthority: null, programId: "x", extensions: [] };
  }
  async getTokenBalances(_mint: string, wallets: string[]): Promise<Map<string, bigint>> {
    this.guard("getTokenBalances");
    return new Map(wallets.map((w) => [w, this.balances.get(w) ?? 0n]));
  }
  async getLargestHolders(): Promise<Holder[]> {
    this.guard("getLargestHolders");
    return this.holders;
  }
  async getRecentSellersOf(_mint: string, wallets: string[], sinceSlot: number): Promise<SellRecord[]> {
    this.guard("getRecentSellersOf");
    return this.sells.filter((s) => wallets.includes(s.wallet) && s.slot > sinceSlot);
  }
  async findLinkedWallets(): Promise<string[]> {
    this.guard("findLinkedWallets");
    return this.linked;
  }
  async getSlot(): Promise<number> {
    return this.slot;
  }
  async getOwnerPrograms(accounts: string[]): Promise<Map<string, string>> {
    return new Map(accounts.filter((a) => this.ownerPrograms.has(a)).map((a) => [a, this.ownerPrograms.get(a) ?? ""]));
  }
  async findPool(): Promise<PoolInfo | undefined> {
    return this.pool;
  }
}

describe("computeTier", () => {
  it("gold when live with the on-chain vault and every check passes", () => {
    const { tier, data } = computeTier(tierInput());
    expect(tier).toBe("gold");
    expect(data.reasons).toContain("Mint authority revoked");
    expect(data.reasons).toContain("LP secured (PumpSwap pool, LP held by the pool)");
    expect(data.reasons).toContain("No insider sell since onboarding");
    expect(data.totalSupply).toBe(SUPPLY.toString());
  });

  it("managed when one gold check fails, with the failed line in reasons", () => {
    expect(computeTier(tierInput({ mintAuthorityRevoked: false })).tier).toBe("managed");
    expect(computeTier(tierInput({ mintAuthorityRevoked: false })).data.reasons).toContain("Mint authority still active: supply can be inflated");
    expect(computeTier(tierInput({ freezeAuthorityRevoked: false })).tier).toBe("managed");
    expect(computeTier(tierInput({ lpSecured: false, lpReason: "LP status unknown" })).tier).toBe("managed");
    expect(computeTier(tierInput({ lpSecured: false, lpReason: "LP status unknown" })).data.reasons).toContain("LP status unknown");
    const ext = computeTier(tierInput({ extensions: ["transferFeeConfig", "metadataPointer"] }));
    expect(ext.tier).toBe("managed");
    expect(ext.data.dangerousExtensions).toEqual(["transferFeeConfig"]);
    const outside = computeTier(tierInput({ insiderOutsidePct: 42 }));
    expect(outside.tier).toBe("managed");
    expect(outside.data.reasons).toContain("Insider supply outside the vault and locks: 42.0% (gold needs at most 1%)");
  });

  it("beta in paper mode and beta without the on-chain vault, never above managed without it", () => {
    const paper = computeTier(tierInput({ mode: "paper" }));
    expect(paper.tier).toBe("beta");
    expect(paper.data.reasons[0]).toMatch(/Paper mode/);
    const noVault = computeTier(tierInput({ onChainVault: false }));
    expect(noVault.tier).toBe("beta");
    expect(noVault.data.reasons.some((r) => r.includes(`tier capped at ${MAX_TIER_WITHOUT_VAULT}`))).toBe(true);
    expect(MAX_TIER_WITHOUT_VAULT).toBe("managed");
    expect(minTier("gold", MAX_TIER_WITHOUT_VAULT)).toBe("managed");
    expect(minTier("flagged", "gold")).toBe("flagged");
  });

  it("flagged whenever an insider sold in the last 30 days, whatever the mode", () => {
    const f = computeTier(tierInput({ insiderSellCount: 2, insiderSellCount30d: 1, lastInsiderSellTs: Date.UTC(2026, 9, 30) }));
    expect(f.tier).toBe("flagged");
    expect(f.data.reasons).toContain("1 insider sell in the last 30 days, last on 2026-10-30");
    expect(computeTier(tierInput({ mode: "paper", insiderSellCount: 1, insiderSellCount30d: 1 })).tier).toBe("flagged");
    const old = computeTier(tierInput({ insiderSellCount: 3, insiderSellCount30d: 0 }));
    expect(old.tier).toBe("gold");
    expect(old.data.reasons).toContain("No insider sell in the last 30 days (3 since onboarding)");
  });

  it("recognises dangerous extensions by normalised name", () => {
    expect(dangerousExtensionsOf(["TransferFeeConfig", "transfer_hook", "PermanentDelegate", "mintCloseAuthority"])).toEqual([
      "TransferFeeConfig",
      "transfer_hook",
      "PermanentDelegate",
    ]);
  });
});

describe("assessLp", () => {
  it("PumpSwap without LP token is secured, Raydium needs burned or locked LP, unknown pools are not secured", async () => {
    const r = new FakeReader();
    expect(await assessLp(r, MINT)).toEqual({ secured: true, reason: "PumpSwap pool, no withdrawable LP token" });

    const lpMint = "LpMint111111111111111111111111111111111111111";
    r.pool = { program: RAY_V4, address: "RayPool11111111111111111111111111111111111111", lpMint };
    const lpInfo: MintInfo = { decimals: 9, supply: 1000n, mintAuthority: null, freezeAuthority: null, programId: "t", extensions: [] };
    r.getMintInfo = async () => lpInfo;
    r.holders = [
      { owner: INCINERATOR, amount: 900n },
      { owner: LOCK_ESCROW, amount: 60n },
      { owner: FOUNDER, amount: 40n },
    ];
    expect(await assessLp(r, MINT)).toEqual({ secured: true, reason: "Raydium AMM v4 pool, 96.0% of LP burned or locked" });
    r.holders = [
      { owner: INCINERATOR, amount: 500n },
      { owner: FOUNDER, amount: 500n },
    ];
    expect(await assessLp(r, MINT)).toEqual({ secured: false, reason: "Raydium AMM v4 pool, only 50.0% of LP burned or locked" });

    r.pool = { program: "SomeOtherDex1111111111111111111111111111111", address: "p", lpMint: null };
    expect((await assessLp(r, MINT)).secured).toBe(false);
    expect((await assessLp(r, MINT)).reason).toMatch(/^LP status unknown/);
    r.pool = undefined;
    expect(await assessLp(r, MINT)).toEqual({ secured: false, reason: "LP status unknown: no pool found" });
    const noFinder: ChainReader = { ...r, findPool: undefined };
    expect(await assessLp(noFinder, MINT)).toEqual({ secured: false, reason: "LP status unknown" });
  });

  it("pctOf is exact bigint division with four decimals", () => {
    expect(pctOf(SUPPLY / 4n, SUPPLY)).toBe(25);
    expect(pctOf(1n, 3n)).toBe(33.3333);
    expect(pctOf(5n, 0n)).toBe(0);
  });
});

describe("runCoverageCheck", () => {
  const now = 1_700_000_000_000 + 10 * DAY;

  it("first run: registers config wallets, links, locks, stores the coverage and announces the badge", async () => {
    const ledger = new Ledger(":memory:");
    const c = cfg();
    const reader = new FakeReader();
    const cov = await runCoverageCheck({ ledger, cfg: c, reader, now });

    expect(cov.tier).toBe("beta");
    expect(cov.data.vaultPct).toBe(10);
    expect(cov.data.mintAuthorityRevoked).toBe(true);
    expect(cov.data.lpSecured).toBe(true);
    // founder 5% declared + linked 2% outside; 25% in a Streamflow escrow counts as locked
    expect(cov.data.insiderOutsidePct).toBe(7);
    expect(cov.data.insiderWallets).toEqual([
      { wallet: FOUNDER, pctOfSupply: 5, declared: true, locked: false },
      { wallet: LINKED, pctOfSupply: 2, declared: false, locked: false },
      { wallet: LOCK_ESCROW, pctOfSupply: 25, declared: false, locked: true },
    ]);
    expect(cov.data.insiderSellCount).toBe(0);
    expect((cov.data as StoredCoverageData).checkedSlot).toBe(1000);
    expect(ledger.listDeclaredWallets("test").map((w) => w.wallet)).toEqual([FOUNDER]);
    expect(ledger.latestCoverage("test")?.tier).toBe("beta");
    const events = ledger.listEvents("test");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "badge_changed", data: { from: null, to: "beta" } });
    expect((events[0]?.data as { reasons: string[] }).reasons.length).toBeGreaterThan(3);
    ledger.close();
  });

  it("a new insider sell flags the project, records the sell once and emits both events; no change, no event", async () => {
    const ledger = new Ledger(":memory:");
    const c = cfg({ mode: "live" });
    const reader = new FakeReader();
    await runCoverageCheck({ ledger, cfg: c, reader, now });
    expect(ledger.listEvents("test")).toHaveLength(1);

    reader.sells = [
      { wallet: LINKED, txSig: TX1, amount: SUPPLY / 100n, ts: now - DAY, slot: 1500 },
      { wallet: LINKED, txSig: TX1, amount: SUPPLY / 100n, ts: now - DAY, slot: 1500 }, // duplicate in the same batch
      { wallet: FOUNDER, txSig: TX2, amount: 10n, ts: c.createdAt - DAY, slot: 900 }, // before onboarding, ignored
    ];
    reader.slot = 2000;
    const flagged = await runCoverageCheck({ ledger, cfg: c, reader, now: now + 3_600_000 });
    expect(flagged.tier).toBe("flagged");
    expect(flagged.data.insiderSellCount).toBe(1);
    expect(flagged.data.reasons).toContain("1 insider sell in the last 30 days, last on " + new Date(now - DAY).toISOString().slice(0, 10));
    expect(ledger.listInsiderSells("test")).toHaveLength(1);
    expect(ledger.listInsiderSells("test")[0]).toMatchObject({ wallet: LINKED, txSig: TX1, pctOfSupply: 1 });
    const events = ledger.listEvents("test", { since: now + 1 });
    expect(events.map((e) => e.type).sort()).toEqual(["badge_changed", "insider_sell"]);
    expect(events.find((e) => e.type === "badge_changed")?.data).toMatchObject({ from: "beta", to: "flagged" });
    expect(events.find((e) => e.type === "insider_sell")?.data).toMatchObject({ wallet: LINKED, txSig: TX1, pctOfSupply: 1, amount: (SUPPLY / 100n).toString() });

    // Third run: the reader returns the same sell again (sinceSlot resumed from checkedSlot = 2000 filters it, and the ledger de-dups anyway).
    reader.sells.push({ wallet: LINKED, txSig: TX1, amount: SUPPLY / 100n, ts: now - DAY, slot: 2500 });
    const again = await runCoverageCheck({ ledger, cfg: c, reader, now: now + 2 * 3_600_000 });
    expect(again.tier).toBe("flagged");
    expect(ledger.listInsiderSells("test")).toHaveLength(1);
    expect(ledger.listEvents("test", { since: now + 3_600_000 + 1 })).toHaveLength(0);
    expect(reader.calls.filter((x) => x === "getRecentSellersOf")).toHaveLength(3);
    ledger.close();
  });

  it("a sell older than 30 days no longer flags but stays counted", async () => {
    const ledger = new Ledger(":memory:");
    const c = cfg({ mode: "live" });
    const reader = new FakeReader();
    reader.sells = [{ wallet: FOUNDER, txSig: TX1, amount: 1n, ts: c.createdAt + DAY, slot: 10 }];
    const cov = await runCoverageCheck({ ledger, cfg: c, reader, now: c.createdAt + 40 * DAY });
    expect(cov.tier).toBe("beta");
    expect(cov.data.insiderSellCount).toBe(1);
    expect(cov.data.reasons).toContain("No insider sell in the last 30 days (1 since onboarding)");
    ledger.close();
  });

  it("gold needs the on-chain vault flag and insiders inside the vault or locks", async () => {
    const ledger = new Ledger(":memory:");
    const c = cfg({ mode: "live" });
    const reader = new FakeReader();
    reader.balances.set(FOUNDER, SUPPLY / 1000n); // 0.1%
    reader.balances.set(LINKED, 0n);
    const gold = await runCoverageCheck({ ledger, cfg: c, reader, now, onChainVault: true });
    expect(gold.tier).toBe("gold");
    expect(gold.data.insiderOutsidePct).toBe(0.1);
    reader.mint = { ...reader.mint, freezeAuthority: FOUNDER };
    const managed = await runCoverageCheck({ ledger, cfg: c, reader, now: now + 1, onChainVault: true });
    expect(managed.tier).toBe("managed");
    expect(ledger.listEvents("test", { since: now + 1 })[0]?.data).toMatchObject({ from: "gold", to: "managed" });
    ledger.close();
  });

  it("never throws on a reader failure: returns the last coverage with a check failed reason, stores nothing", async () => {
    const ledger = new Ledger(":memory:");
    const c = cfg();
    const reader = new FakeReader();
    reader.failing = true;
    const first = await runCoverageCheck({ ledger, cfg: c, reader, now });
    expect(first.tier).toBe("beta");
    expect(first.data.reasons).toEqual(["check failed: rpc down"]);
    expect(ledger.latestCoverage("test")).toBeUndefined();

    reader.failing = false;
    const ok = await runCoverageCheck({ ledger, cfg: c, reader, now: now + 1 });
    reader.failing = true;
    const failed = await runCoverageCheck({ ledger, cfg: c, reader, now: now + 2 });
    expect(failed.ts).toBe(ok.ts);
    expect(failed.tier).toBe(ok.tier);
    expect(failed.data.reasons.at(-1)).toBe("check failed: rpc down");
    expect(ledger.latestCoverage("test")?.ts).toBe(ok.ts);
    expect(ledger.latestCoverage("test")?.data.reasons).not.toContain("check failed: rpc down");
    ledger.close();
  });

  it("uses the supply override and works with no declared wallet at all", async () => {
    const ledger = new Ledger(":memory:");
    const c = cfg({ declaredWallets: undefined });
    const reader = new FakeReader();
    reader.linked = [];
    reader.holders = [];
    const cov = await runCoverageCheck({ ledger, cfg: c, reader, now, supply: SUPPLY / 2n });
    expect(cov.data.vaultPct).toBe(20);
    expect(cov.data.insiderWallets).toEqual([]);
    expect(cov.data.insiderOutsidePct).toBe(0);
    expect(reader.calls).not.toContain("getRecentSellersOf");
    ledger.close();
  });
});

describe("chainReaderFromExec", () => {
  it("loads exec lazily, delegates the slot to the connection and leaves optional helpers soft", async () => {
    const stub = { getSlot: async () => 42 } as unknown as import("@solana/web3.js").Connection;
    const reader = chainReaderFromExec(stub);
    expect(await reader.getSlot?.()).toBe(42);
    // exec has no pool finder yet: unknown, not an error
    expect(await reader.findPool?.(MINT)).toBeUndefined();
    // a real helper exists in exec: the call reaches it (and fails on the stub connection, not on a missing export)
    await expect(reader.getMintInfo(MINT)).rejects.not.toThrow(/does not export/);
  });
});

describe("badgeStatement", () => {
  const base: Coverage = {
    projectId: "test",
    ts: 0,
    tier: "beta",
    data: {
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      lpSecured: true,
      dangerousExtensions: [],
      totalSupply: "1",
      insiderWallets: [],
      insiderOutsidePct: 42,
      vaultPct: 10,
      insiderSellCount: 0,
      reasons: [],
    },
  };

  it("reads as one plain sentence per tier", () => {
    expect(badgeStatement(base, cfg())).toBe(
      "Tenfold Managed, beta: vault cannot dump through the MM (0.5% of vault tokens per day, 24 h withdrawal delay); 42% of supply held by insiders outside the vault; last insider sell: none",
    );
    expect(badgeStatement({ ...base, tier: "gold", data: { ...base.data, insiderOutsidePct: 0.4 } }, cfg())).toMatch(/^Tenfold Managed, gold: .*0\.4% of supply/);
    expect(badgeStatement({ ...base, tier: "managed" }, cfg())).toMatch(/^Tenfold Managed: vault cannot dump/);
    const flagged = badgeStatement({ ...base, tier: "flagged", data: { ...base.data, insiderSellCount: 2 } }, cfg(), { lastSellTs: Date.UTC(2026, 9, 30) });
    expect(flagged).toBe("Tenfold FLAGGED: an insider wallet sold since onboarding (2 sells); 42% of supply held by insiders outside the vault; last insider sell: 2026-10-30");
    expect(badgeStatement({ ...base, data: { ...base.data, insiderSellCount: 1 } }, cfg())).toMatch(/insider sells since onboarding: 1$/);
    expect(BADGE_MEANING).toMatch(/daily sell cap/);
  });
});
