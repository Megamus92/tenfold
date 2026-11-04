/**
 * The hourly coverage check: declared + linked insider wallets, their balances, mint and LP facts, new insider
 * sells, then the tier. Writes the coverage row and the badge_changed / insider_sell events to the ledger.
 * Never throws on a reader failure: it logs and returns the last coverage with a "check failed" reason.
 */
import { logger, type Coverage, type CoverageData, type Ledger, type ProjectConfig } from "@tenfold/core";
import { computeTier, FLAG_WINDOW_MS, LOCKER_PROGRAMS } from "./tiers.js";
import type { ChainReader, Holder, SellRecord } from "./types.js";

/** PumpSwap AMM: LP stays in the pool PDA, nobody can pull it. */
export const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

/** Raydium pool programs whose LP token can be burned or locked. */
export const RAYDIUM_PROGRAMS: ReadonlyMap<string, string> = new Map([
  ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "Raydium AMM v4"],
  ["CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", "Raydium CPMM"],
  ["CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", "Raydium CLMM"],
]);

/** Addresses nobody controls; LP sent there is gone for good. */
export const BURN_ADDRESSES: ReadonlySet<string> = new Set(["1nc1nerator11111111111111111111111111111111", "11111111111111111111111111111111"]);

/** Share of a Raydium LP supply that must be burned or locked for the LP to count as secured. */
export const LP_SECURED_MIN_PCT = 95;

/** How many funding hops away from the declared wallets a wallet still counts as linked. */
export const LINK_DEPTH = 2;

/** Top holders scanned for balances parked in public lockers. */
export const TOP_HOLDERS = 20;

const SELLS_LIMIT = 100_000;

export interface CoverageCheckInput {
  ledger: Ledger;
  cfg: ProjectConfig;
  reader: ChainReader;
  now?: number;
  /** Total supply in base units when the caller already has it; otherwise read from the mint. */
  supply?: bigint;
  /** True once the project's funds sit in the audited on-chain vault program; false for every project today. */
  onChainVault?: boolean;
}

/** CoverageData plus the slot the check scanned up to, stored in the same JSON so the next check resumes from it. */
export interface StoredCoverageData extends CoverageData {
  checkedSlot?: number;
}

/** amount / supply in %, four decimals, exact bigint division first. */
export function pctOf(amount: bigint, supply: bigint): number {
  if (supply <= 0n || amount <= 0n) return 0;
  return Number((amount * 1_000_000n) / supply) / 10_000;
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function short(s: string): string {
  return s.length <= 9 ? s : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** A coverage with nothing verified, used when the very first check fails. */
function emptyData(reason: string): CoverageData {
  return {
    mintAuthorityRevoked: false,
    freezeAuthorityRevoked: false,
    lpSecured: false,
    dangerousExtensions: [],
    totalSupply: "0",
    insiderWallets: [],
    insiderOutsidePct: 0,
    vaultPct: 0,
    insiderSellCount: 0,
    reasons: [reason],
  };
}

/** Whether an account is a public locker: the locker program itself or an account it owns. */
function lockedBy(account: string, ownerPrograms: ReadonlyMap<string, string>): string | undefined {
  return LOCKER_PROGRAMS.get(account) ?? LOCKER_PROGRAMS.get(ownerPrograms.get(account) ?? "");
}

/** Owner program of each account when the reader can tell, else an empty map (nothing is locked). */
async function ownerProgramsOf(reader: ChainReader, accounts: string[]): Promise<Map<string, string>> {
  if (!reader.getOwnerPrograms || accounts.length === 0) return new Map();
  return reader.getOwnerPrograms(uniq(accounts));
}

/** LP security: PumpSwap LP in the pool PDA, Raydium LP burned or locked; anything else is unknown (not secured). */
export async function assessLp(reader: ChainReader, mint: string): Promise<{ secured: boolean; reason: string }> {
  if (!reader.findPool) return { secured: false, reason: "LP status unknown" };
  const pool = await reader.findPool(mint);
  if (!pool) return { secured: false, reason: "LP status unknown: no pool found" };

  if (pool.program === PUMPSWAP_PROGRAM) {
    if (pool.lpMint === null) return { secured: true, reason: "PumpSwap pool, no withdrawable LP token" };
    const holders = await reader.getLargestHolders(pool.lpMint, TOP_HOLDERS);
    const outside = holders.filter((h) => h.amount > 0n && h.owner !== pool.address && !BURN_ADDRESSES.has(h.owner) && !LOCKER_PROGRAMS.has(h.owner));
    return outside.length === 0
      ? { secured: true, reason: "PumpSwap pool, LP held by the pool" }
      : { secured: false, reason: `PumpSwap pool, LP held outside the pool by ${outside.length} account${outside.length === 1 ? "" : "s"}` };
  }

  const raydium = RAYDIUM_PROGRAMS.get(pool.program);
  if (raydium) {
    if (pool.lpMint === null) return { secured: false, reason: `${raydium} pool, LP mint unknown` };
    const lp = await reader.getMintInfo(pool.lpMint);
    if (lp.supply === 0n) return { secured: true, reason: `${raydium} pool, LP supply fully burned` };
    const holders: Holder[] = await reader.getLargestHolders(pool.lpMint, TOP_HOLDERS);
    const owners = await ownerProgramsOf(reader, holders.map((h) => h.owner));
    let safe = 0n;
    for (const h of holders) if (BURN_ADDRESSES.has(h.owner) || lockedBy(h.owner, owners)) safe += h.amount;
    const pct = pctOf(safe, lp.supply);
    return pct >= LP_SECURED_MIN_PCT
      ? { secured: true, reason: `${raydium} pool, ${pct.toFixed(1)}% of LP burned or locked` }
      : { secured: false, reason: `${raydium} pool, only ${pct.toFixed(1)}% of LP burned or locked` };
  }

  return { secured: false, reason: `LP status unknown: pool program ${short(pool.program)}` };
}

/** Run the check once. Safe to call every hour; returns the stored coverage, or the previous one on a reader failure. */
export async function runCoverageCheck(input: CoverageCheckInput): Promise<Coverage> {
  const { ledger, cfg } = input;
  const now = input.now ?? Date.now();
  const previous = ledger.latestCoverage(cfg.id);
  try {
    return await check(input, now, previous);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn("coverage check failed", { projectId: cfg.id, error: msg });
    const reason = `check failed: ${msg}`;
    if (previous) return { ...previous, data: { ...previous.data, reasons: [...previous.data.reasons, reason] } };
    return { projectId: cfg.id, ts: now, tier: "beta", data: emptyData(reason) };
  }
}

async function check(input: CoverageCheckInput, now: number, previous: Coverage | undefined): Promise<Coverage> {
  const { ledger, cfg, reader } = input;
  const vault = cfg.walletPubkey;

  // Declared wallets: the ledger is the record; wallets only present in the config file are registered there once.
  const inLedger = ledger.listDeclaredWallets(cfg.id).map((w) => w.wallet);
  for (const w of cfg.declaredWallets ?? []) if (!inLedger.includes(w)) ledger.declareWallet(cfg.id, w, "config");
  const declared = uniq([...inLedger, ...(cfg.declaredWallets ?? [])]).filter((w) => w !== vault);

  const mintInfo = await reader.getMintInfo(cfg.mint);
  const supply = input.supply ?? mintInfo.supply;

  const seeds = uniq([...declared, vault]);
  const linked = uniq(await reader.findLinkedWallets(cfg.mint, seeds, LINK_DEPTH)).filter((w) => !seeds.includes(w));
  const insiders = [...declared, ...linked];

  const balances = await reader.getTokenBalances(cfg.mint, [vault, ...insiders]);
  const holders = await reader.getLargestHolders(cfg.mint, TOP_HOLDERS);
  const owners = await ownerProgramsOf(reader, [...insiders, ...holders.map((h) => h.owner)]);

  const insiderWallets: CoverageData["insiderWallets"] = insiders.map((w) => ({
    wallet: w,
    pctOfSupply: pctOf(balances.get(w) ?? 0n, supply),
    declared: declared.includes(w),
    locked: lockedBy(w, owners) !== undefined,
  }));
  // Supply parked in a public locker is accounted for as locked, whoever put it there.
  for (const h of holders) {
    if (h.owner === vault || insiders.includes(h.owner) || h.amount <= 0n) continue;
    if (lockedBy(h.owner, owners)) insiderWallets.push({ wallet: h.owner, pctOfSupply: pctOf(h.amount, supply), declared: false, locked: true });
  }
  const vaultPct = pctOf(balances.get(vault) ?? 0n, supply);
  const insiderOutsidePct = round4(insiderWallets.filter((w) => !w.locked).reduce((acc, w) => acc + w.pctOfSupply, 0));

  const lp = await assessLp(reader, cfg.mint);

  // New insider sells since the last scanned slot, once per transaction, since onboarding only.
  const sinceSlot = (previous?.data as StoredCoverageData | undefined)?.checkedSlot ?? 0;
  const sells: SellRecord[] = insiders.length > 0 ? await reader.getRecentSellersOf(cfg.mint, insiders, sinceSlot) : [];
  const seen = new Set<string>();
  let maxSlot = sinceSlot;
  let newSells = 0;
  for (const s of sells) {
    maxSlot = Math.max(maxSlot, s.slot);
    if (s.ts < cfg.createdAt || seen.has(s.txSig)) continue;
    seen.add(s.txSig);
    const pctOfSupply = pctOf(s.amount, supply);
    const isNew = ledger.recordInsiderSell({ projectId: cfg.id, wallet: s.wallet, ts: s.ts, amount: s.amount, txSig: s.txSig, pctOfSupply });
    if (isNew) {
      newSells++;
      ledger.insertEvent({
        type: "insider_sell",
        projectId: cfg.id,
        ts: now,
        data: { wallet: s.wallet, amount: s.amount.toString(), pctOfSupply, txSig: s.txSig, soldAt: s.ts },
      });
    }
  }
  const checkedSlot = reader.getSlot ? await reader.getSlot() : maxSlot;

  const allSells = ledger.listInsiderSells(cfg.id, 0, SELLS_LIMIT);
  const recentSells = allSells.filter((s) => s.ts >= now - FLAG_WINDOW_MS);

  const { tier, data } = computeTier({
    mode: cfg.mode,
    onChainVault: input.onChainVault ?? false,
    mintAuthorityRevoked: mintInfo.mintAuthority === null,
    freezeAuthorityRevoked: mintInfo.freezeAuthority === null,
    lpSecured: lp.secured,
    lpReason: lp.reason,
    extensions: mintInfo.extensions,
    totalSupply: supply,
    vaultPct,
    insiderWallets,
    insiderOutsidePct,
    insiderSellCount: allSells.length,
    insiderSellCount30d: recentSells.length,
    lastInsiderSellTs: allSells[0]?.ts,
  });

  const stored: StoredCoverageData = { ...data, checkedSlot };
  const coverage: Coverage = { projectId: cfg.id, ts: now, tier, data: stored };
  ledger.insertCoverage(coverage);
  if (!previous || previous.tier !== tier) {
    ledger.insertEvent({ type: "badge_changed", projectId: cfg.id, ts: now, data: { from: previous?.tier ?? null, to: tier, reasons: data.reasons } });
  }
  logger.info("coverage check", { projectId: cfg.id, tier, vaultPct, insiderOutsidePct, newSells });
  return coverage;
}
