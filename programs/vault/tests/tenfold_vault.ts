/**
 * Tenfold vault test suite (anchor-mocha).
 *
 * Two modes:
 *
 *   anchor test
 *     Production-flag build. Every case that needs time to pass (24h window,
 *     48h cap raise, withdrawal delay, 7 day admin timelock) or a no-op venue
 *     (the Memo program standing in for Jupiter) is SKIPPED and prints why.
 *     The cases that still run cover: init + deposit, authorization
 *     (delegate cannot withdraw / change cap, stranger cannot propose fees),
 *     allowlist rejection, pause blocking swaps, "blocked before delay" paths
 *     and the admin-cannot-trap-funds guarantees that do not require settling.
 *
 *   TENFOLD_TEST_CLOCK=1 anchor test -- --features testing
 *     `testing` build: one "day" is 10 seconds and any allowlisted program is
 *     accepted as a swap venue. The suite then literally waits (10 s, 20 s and
 *     70 s) and covers the full spec list. Tests that wait are tagged [CLOCK].
 *     Tests that need the Memo venue are tagged [MEMO]. Both use the same flag.
 *
 * Why no bankrun / warp: the instruction handlers read Clock::unix_timestamp,
 * and `solana-test-validator --warp-slot` only moves the slot, not wall time.
 * Literal waiting against a 10 s day is the simplest honest approach.
 */

import * as anchor from "@coral-xyz/anchor";
import { AnchorError, BN, Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { expect } from "chai";
import { TenfoldVault } from "../target/types/tenfold_vault";

// ---------------------------------------------------------------------------
// mode
// ---------------------------------------------------------------------------

const FULL = process.env.TENFOLD_TEST_CLOCK === "1";
/** Seconds in one "day" as compiled into the program. */
const DAY = FULL ? 10 : 86_400;
/** Runs only in full mode. */
const itFull = FULL ? it : it.skip;

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const sleep = (secs: number) => new Promise((r) => setTimeout(r, secs * 1000));

async function expectError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e: unknown) {
    if (e instanceof AnchorError) {
      expect(e.error.errorCode.code, `anchor error code (got "${e.error.errorMessage}")`).to.equal(code);
      return;
    }
    const text = `${String(e)} ${JSON.stringify((e as { logs?: string[] }).logs ?? [])}`;
    expect(text, "error text").to.include(code);
    return;
  }
  expect.fail(`expected error ${code}, call succeeded`);
}

// ---------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------

describe("tenfold_vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.TenfoldVault as Program<TenfoldVault>;
  const connection = provider.connection;

  /** The provider wallet plays the Tenfold admin multisig. */
  const admin = provider.wallet;
  const owner = Keypair.generate();
  const delegate = Keypair.generate();
  const referrer = Keypair.generate();
  const feeRecipient = Keypair.generate();
  const stranger = Keypair.generate();

  let mint: PublicKey;
  let ownerAta: PublicKey;
  let feeRecipientAta: PublicKey;
  let referrerAta: PublicKey;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const [allowlistPda] = PublicKey.findProgramAddressSync([Buffer.from("allowlist")], program.programId);
  let vaultPda: PublicKey;
  let solVaultPda: PublicKey;
  let wsolPda: PublicKey;
  let tokenVault: PublicKey;

  const FEES = {
    feeVolumeBps: 50, // 0.5 %
    feeCashoutBps: 100, // 1 %
    referralShareBps: 2000, // 20 % of the fee
    feeRecipient: feeRecipient.publicKey,
  };
  const CAP_BPS = 1000; // 10 % per day
  const DEFENSE_BUDGET = new BN(0.1 * LAMPORTS_PER_SOL);

  async function airdrop(pk: PublicKey, sol: number) {
    const sig = await connection.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
    const bh = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  }

  const lamportsOf = async (pk: PublicKey) => connection.getBalance(pk, "confirmed");
  const tokensOf = async (ata: PublicKey) => Number((await getAccount(connection, ata, "confirmed")).amount);

  function swapAccounts(withReferrer = true) {
    return {
      delegate: delegate.publicKey,
      vault: vaultPda,
      config: configPda,
      allowlist: allowlistPda,
      mint,
      wsolMint: NATIVE_MINT,
      tokenVault,
      wsolVault: wsolPda,
      solVault: solVaultPda,
      feeRecipient: feeRecipient.publicKey,
      referrer: withReferrer ? referrer.publicKey : null,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    };
  }

  const memoVenue = [{ pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false }];

  function sell(amount: number, reason = 1) {
    return program.methods
      .delegateSwap(new BN(amount), new BN(0), { sell: {} }, reason, Buffer.from("tenfold:sell"))
      .accountsStrict(swapAccounts())
      .remainingAccounts(memoVenue)
      .signers([delegate])
      .rpc();
  }

  function buy(lamports: number, reason: number) {
    return program.methods
      .delegateSwap(new BN(lamports), new BN(0), { buy: {} }, reason, Buffer.from("tenfold:buy"))
      .accountsStrict(swapAccounts())
      .remainingAccounts(memoVenue)
      .signers([delegate])
      .rpc();
  }

  function ownerOnly() {
    return { owner: owner.publicKey, vault: vaultPda };
  }

  // -------------------------------------------------------------------------

  before(async () => {
    await Promise.all([
      airdrop(owner.publicKey, 20),
      airdrop(delegate.publicKey, 2),
      airdrop(referrer.publicKey, 1),
      airdrop(feeRecipient.publicKey, 1),
      airdrop(stranger.publicKey, 1),
    ]);

    // 0-decimal mint keeps the arithmetic in the assertions readable.
    mint = await createMint(connection, owner, owner.publicKey, null, 0);
    ownerAta = (await getOrCreateAssociatedTokenAccount(connection, owner, mint, owner.publicKey)).address;
    feeRecipientAta = (await getOrCreateAssociatedTokenAccount(connection, owner, mint, feeRecipient.publicKey)).address;
    referrerAta = (await getOrCreateAssociatedTokenAccount(connection, owner, mint, referrer.publicKey)).address;
    await mintTo(connection, owner, mint, ownerAta, owner, 1_000_000);

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), mint.toBuffer(), owner.publicKey.toBuffer()],
      program.programId,
    );
    [solVaultPda] = PublicKey.findProgramAddressSync([Buffer.from("sol"), vaultPda.toBuffer()], program.programId);
    [wsolPda] = PublicKey.findProgramAddressSync([Buffer.from("wsol"), vaultPda.toBuffer()], program.programId);
    tokenVault = getAssociatedTokenAddressSync(mint, vaultPda, true);
  });

  // -------------------------------------------------------------------------
  // deployment
  // -------------------------------------------------------------------------

  it("init_config: admin creates Config + Allowlist", async () => {
    await program.methods
      .initConfig({ fees: FEES, allowlist: [MEMO_PROGRAM_ID] })
      .accountsStrict({
        admin: admin.publicKey,
        config: configPda,
        allowlist: allowlistPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const config = await program.account.config.fetch(configPda);
    expect(config.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(config.fees.feeVolumeBps).to.equal(50);
    expect(config.fees.feeCashoutBps).to.equal(100);
    expect(config.pendingFeeChange).to.be.null;

    const allowlist = await program.account.allowlist.fetch(allowlistPda);
    expect(allowlist.programs.map((p) => p.toBase58())).to.deep.equal([MEMO_PROGRAM_ID.toBase58()]);
  });

  it("init_config: cannot run twice", async () => {
    await expectError(
      program.methods
        .initConfig({ fees: FEES, allowlist: [MEMO_PROGRAM_ID] })
        .accountsStrict({
          admin: admin.publicKey,
          config: configPda,
          allowlist: allowlistPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      "already in use",
    );
  });

  // -------------------------------------------------------------------------
  // init + deposit
  // -------------------------------------------------------------------------

  it("init_vault + deposit_tokens + deposit_sol", async () => {
    await program.methods
      .initVault({
        delegate: delegate.publicKey,
        dailySellCapBps: CAP_BPS,
        defenseBudgetLamports: DEFENSE_BUDGET,
        withdrawalDelaySecs: DAY,
        referrer: referrer.publicKey,
      })
      .accountsStrict({
        owner: owner.publicKey,
        config: configPda,
        mint,
        vault: vaultPda,
        solVault: solVaultPda,
        tokenVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    let vault = await program.account.vault.fetch(vaultPda);
    expect(vault.owner.toBase58()).to.equal(owner.publicKey.toBase58());
    expect(vault.delegate.toBase58()).to.equal(delegate.publicKey.toBase58());
    expect(vault.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(vault.dailySellCapBps).to.equal(CAP_BPS);
    expect(vault.soldInWindow.toNumber()).to.equal(0);
    expect(vault.withdrawalDelaySecs).to.equal(DAY);
    expect(vault.paused).to.be.false;
    expect(vault.feeVolumeBps).to.equal(50);
    expect(vault.feeCashoutBps).to.equal(100);
    expect(vault.referralShareBps).to.equal(2000);
    expect(vault.referrer?.toBase58()).to.equal(referrer.publicKey.toBase58());
    expect(vault.pendingWithdrawal).to.be.null;

    await program.methods
      .depositTokens(new BN(1_000))
      .accountsStrict({
        depositor: owner.publicKey,
        vault: vaultPda,
        mint,
        tokenVault,
        depositorTokenAccount: ownerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([owner])
      .rpc();
    expect(await tokensOf(tokenVault)).to.equal(1_000);

    const solBefore = await lamportsOf(solVaultPda);
    await program.methods
      .depositSol(new BN(2 * LAMPORTS_PER_SOL))
      .accountsStrict({
        depositor: owner.publicKey,
        vault: vaultPda,
        solVault: solVaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();
    expect((await lamportsOf(solVaultPda)) - solBefore).to.equal(2 * LAMPORTS_PER_SOL);

    vault = await program.account.vault.fetch(vaultPda);
    expect(vault.tokenVault.toBase58()).to.equal(tokenVault.toBase58());
    expect(vault.solVault.toBase58()).to.equal(solVaultPda.toBase58());
  });

  it("init_vault: rejects a bad delay and a zero cap", async () => {
    const other = Keypair.generate();
    await airdrop(other.publicKey, 1);
    const [v] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), mint.toBuffer(), other.publicKey.toBuffer()],
      program.programId,
    );
    const [sv] = PublicKey.findProgramAddressSync([Buffer.from("sol"), v.toBuffer()], program.programId);
    const accounts = {
      owner: other.publicKey,
      config: configPda,
      mint,
      vault: v,
      solVault: sv,
      tokenVault: getAssociatedTokenAddressSync(mint, v, true),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };
    const base = {
      delegate: delegate.publicKey,
      dailySellCapBps: CAP_BPS,
      defenseBudgetLamports: new BN(0),
      withdrawalDelaySecs: DAY,
      referrer: null as PublicKey | null,
    };
    await expectError(
      program.methods.initVault({ ...base, withdrawalDelaySecs: 3600 }).accountsStrict(accounts).signers([other]).rpc(),
      "DelayTooShort",
    );
    await expectError(
      program.methods.initVault({ ...base, dailySellCapBps: 0 }).accountsStrict(accounts).signers([other]).rpc(),
      "InvalidCap",
    );
  });

  // -------------------------------------------------------------------------
  // authorization
  // -------------------------------------------------------------------------

  it("delegate cannot withdraw, lower the cap or unpause", async () => {
    await expectError(
      program.methods
        .requestWithdraw(new BN(1), new BN(0))
        .accountsStrict({ owner: delegate.publicKey, vault: vaultPda, tokenVault, solVault: solVaultPda })
        .signers([delegate])
        .rpc(),
      "NotOwner",
    );
    await expectError(
      program.methods.lowerCap(500).accountsStrict({ owner: delegate.publicKey, vault: vaultPda }).signers([delegate]).rpc(),
      "NotOwner",
    );
    await expectError(
      program.methods.unpause().accountsStrict({ owner: delegate.publicKey, vault: vaultPda }).signers([delegate]).rpc(),
      "NotOwner",
    );
  });

  it("stranger cannot swap, pause or propose fees", async () => {
    await expectError(
      program.methods
        .delegateSwap(new BN(1), new BN(0), { sell: {} }, 1, Buffer.from("x"))
        .accountsStrict({ ...swapAccounts(), delegate: stranger.publicKey })
        .remainingAccounts(memoVenue)
        .signers([stranger])
        .rpc(),
      "NotDelegate",
    );
    await expectError(
      program.methods
        .pause()
        .accountsStrict({ signer: stranger.publicKey, vault: vaultPda, config: configPda })
        .signers([stranger])
        .rpc(),
      "NotOwnerOrAdmin",
    );
    await expectError(
      program.methods
        .proposeFeeChange(FEES)
        .accountsStrict({ admin: stranger.publicKey, config: configPda })
        .signers([stranger])
        .rpc(),
      "NotAdmin",
    );
  });

  // -------------------------------------------------------------------------
  // allowlist + pause
  // -------------------------------------------------------------------------

  it("non-allowlisted program is rejected", async () => {
    await expectError(
      program.methods
        .delegateSwap(new BN(10), new BN(0), { sell: {} }, 1, Buffer.from("x"))
        .accountsStrict(swapAccounts())
        .remainingAccounts([{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false }])
        .signers([delegate])
        .rpc(),
      "ProgramNotAllowed",
    );
    await expectError(
      program.methods
        .placeLpAsks(new BN(10), Buffer.from("x"))
        .accountsStrict({ delegate: delegate.publicKey, vault: vaultPda, allowlist: allowlistPda, tokenVault })
        .remainingAccounts([{ pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }])
        .signers([delegate])
        .rpc(),
      "ProgramNotAllowed",
    );
  });

  it("pause blocks delegate_swap; owner unpauses", async () => {
    await program.methods.pause().accountsStrict({ signer: owner.publicKey, vault: vaultPda, config: configPda }).signers([owner]).rpc();
    expect((await program.account.vault.fetch(vaultPda)).paused).to.be.true;
    await expectError(sell(10), "Paused");
    await program.methods.unpause().accountsStrict(ownerOnly()).signers([owner]).rpc();
    expect((await program.account.vault.fetch(vaultPda)).paused).to.be.false;
  });

  // -------------------------------------------------------------------------
  // sell cap  [MEMO] [CLOCK]
  // -------------------------------------------------------------------------

  itFull("[MEMO] sell cap: 10% of 1000 enforced, counts declared amount", async () => {
    // The Memo venue moves no tokens, so the vault balance stays 1000 and the
    // cap base grows by sold_in_window: base = balance + sold.
    const delegateBefore = await lamportsOf(delegate.publicKey);
    await sell(100); // cap = 1000 * 10% = 100
    let vault = await program.account.vault.fetch(vaultPda);
    expect(vault.soldInWindow.toNumber()).to.equal(100);
    // Scratch WSOL rent went out and came back: the delegate's balance is unchanged.
    expect(await lamportsOf(delegate.publicKey)).to.equal(delegateBefore);
    // Scratch account does not exist between transactions.
    expect(await connection.getAccountInfo(wsolPda)).to.be.null;

    // base = 1000 + 100 = 1100, cap = 110: 100 + 11 > 110
    await expectError(sell(11), "CapExceeded");
    await sell(10);
    vault = await program.account.vault.fetch(vaultPda);
    expect(vault.soldInWindow.toNumber()).to.equal(110);
    await expectError(sell(1), "CapExceeded");
  });

  itFull("[CLOCK] sell cap resets after the 24h window", async () => {
    await sleep(DAY + 2);
    await sell(100); // fresh window: base 1000, cap 100
    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.soldInWindow.toNumber()).to.equal(100);
    await expectError(sell(11), "CapExceeded");
  });

  itFull("[MEMO] place_lp_asks counts against the same window", async () => {
    // Window currently holds 100 of a 110 cap (base 1100).
    await expectError(
      program.methods
        .placeLpAsks(new BN(11), Buffer.from("tenfold:asks"))
        .accountsStrict({ delegate: delegate.publicKey, vault: vaultPda, allowlist: allowlistPda, tokenVault })
        .remainingAccounts(memoVenue)
        .signers([delegate])
        .rpc(),
      "CapExceeded",
    );
    await program.methods
      .placeLpAsks(new BN(10), Buffer.from("tenfold:asks"))
      .accountsStrict({ delegate: delegate.publicKey, vault: vaultPda, allowlist: allowlistPda, tokenVault })
      .remainingAccounts(memoVenue)
      .signers([delegate])
      .rpc();
    expect((await program.account.vault.fetch(vaultPda)).soldInWindow.toNumber()).to.equal(110);
  });

  // -------------------------------------------------------------------------
  // defense budget + volume fee  [MEMO]
  // -------------------------------------------------------------------------

  itFull("[MEMO] DEF buy enforces the defense budget and pays the volume fee split", async () => {
    const half = 0.05 * LAMPORTS_PER_SOL;
    const feeBefore = await lamportsOf(feeRecipient.publicKey);
    const refBefore = await lamportsOf(referrer.publicKey);
    const solBefore = await lamportsOf(solVaultPda);

    await buy(half, 0); // DEF
    let vault = await program.account.vault.fetch(vaultPda);
    expect(vault.defenseSpentLamports.toNumber()).to.equal(half);

    // fee = 0.5 % of 0.05 SOL = 250_000 lamports, 20 % of which to the referrer
    expect((await lamportsOf(feeRecipient.publicKey)) - feeBefore).to.equal(200_000);
    expect((await lamportsOf(referrer.publicKey)) - refBefore).to.equal(50_000);
    // Memo moved nothing: the vault only lost the fee (the wrapped SOL came back).
    expect(solBefore - (await lamportsOf(solVaultPda))).to.equal(250_000);

    await expectError(buy(0.06 * LAMPORTS_PER_SOL, 0), "BudgetExceeded");
    // Non-DEF buys are not budget bound (spec), only cap/allowlist/min_out bound.
    await buy(0.06 * LAMPORTS_PER_SOL, 2); // REB
    vault = await program.account.vault.fetch(vaultPda);
    expect(vault.defenseSpentLamports.toNumber()).to.equal(half);

    // Sell with reason DEF is nonsense and refused.
    await expectError(sell(1, 0), "InvalidReason");
  });

  // -------------------------------------------------------------------------
  // cap raise (48h)  [CLOCK]
  // -------------------------------------------------------------------------

  it("request_raise_cap sets a pending raise; apply is blocked before 48h", async () => {
    await expectError(program.methods.requestRaiseCap(CAP_BPS).accountsStrict(ownerOnly()).signers([owner]).rpc(), "CapNotHigher");
    await program.methods.requestRaiseCap(2000).accountsStrict(ownerOnly()).signers([owner]).rpc();
    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.dailySellCapBps).to.equal(CAP_BPS);
    expect(vault.pendingCapRaise?.bps).to.equal(2000);
    const now = Math.floor(Date.now() / 1000);
    expect(vault.pendingCapRaise!.applyAt.toNumber()).to.be.closeTo(now + 2 * DAY, 30);
    await expectError(program.methods.applyRaiseCap().accountsStrict({ vault: vaultPda }).rpc(), "NotYetDue");
  });

  itFull("[CLOCK] apply_raise_cap works after 48h, by anyone", async () => {
    await sleep(2 * DAY + 2);
    await program.methods.applyRaiseCap().accountsStrict({ vault: vaultPda }).signers([]).rpc();
    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.dailySellCapBps).to.equal(2000);
    expect(vault.pendingCapRaise).to.be.null;
    await expectError(program.methods.applyRaiseCap().accountsStrict({ vault: vaultPda }).rpc(), "NothingPending");
  });

  it("lower_cap is instant, only downwards, and drops a pending raise", async () => {
    const before = (await program.account.vault.fetch(vaultPda)).dailySellCapBps;
    await program.methods.requestRaiseCap(before + 1000).accountsStrict(ownerOnly()).signers([owner]).rpc();
    await program.methods.lowerCap(before - 500).accountsStrict(ownerOnly()).signers([owner]).rpc();
    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.dailySellCapBps).to.equal(before - 500);
    expect(vault.pendingCapRaise).to.be.null;
    await expectError(program.methods.lowerCap(before - 500).accountsStrict(ownerOnly()).signers([owner]).rpc(), "CapNotLower");
    await expectError(program.methods.lowerCap(0).accountsStrict(ownerOnly()).signers([owner]).rpc(), "InvalidCap");
  });

  // -------------------------------------------------------------------------
  // withdrawal delay changes
  // -------------------------------------------------------------------------

  it("set_withdrawal_delay: raising is instant, lowering is scheduled", async () => {
    await program.methods.setWithdrawalDelay(2 * DAY).accountsStrict(ownerOnly()).signers([owner]).rpc();
    let vault = await program.account.vault.fetch(vaultPda);
    expect(vault.withdrawalDelaySecs).to.equal(2 * DAY);
    expect(vault.pendingDelayChange).to.be.null;

    await program.methods.setWithdrawalDelay(DAY).accountsStrict(ownerOnly()).signers([owner]).rpc();
    vault = await program.account.vault.fetch(vaultPda);
    expect(vault.withdrawalDelaySecs).to.equal(2 * DAY); // still the old one
    expect(vault.pendingDelayChange?.secs).to.equal(DAY);

    await expectError(program.methods.setWithdrawalDelay(60).accountsStrict(ownerOnly()).signers([owner]).rpc(), "DelayTooShort");

    // Re-raising cancels the scheduled lowering.
    await program.methods.setWithdrawalDelay(2 * DAY).accountsStrict(ownerOnly()).signers([owner]).rpc();
    vault = await program.account.vault.fetch(vaultPda);
    expect(vault.pendingDelayChange).to.be.null;
    // Back to one day for the withdrawal tests below: schedule it, it applies after 2*DAY.
    await program.methods.setWithdrawalDelay(DAY).accountsStrict(ownerOnly()).signers([owner]).rpc();
  });

  // -------------------------------------------------------------------------
  // withdrawals
  // -------------------------------------------------------------------------

  const settleAccounts = () => ({
    owner: owner.publicKey,
    vault: vaultPda,
    config: configPda,
    mint,
    tokenVault,
    solVault: solVaultPda,
    ownerTokenAccount: ownerAta,
    feeRecipient: feeRecipient.publicKey,
    feeRecipientTokenAccount: feeRecipientAta,
    referrer: referrer.publicKey,
    referrerTokenAccount: referrerAta,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  });

  it("request_withdraw: validated, single pending, blocked before delay, cancellable", async () => {
    await expectError(
      program.methods
        .requestWithdraw(new BN(0), new BN(0))
        .accountsStrict({ owner: owner.publicKey, vault: vaultPda, tokenVault, solVault: solVaultPda })
        .signers([owner])
        .rpc(),
      "InvalidAmount",
    );
    await expectError(
      program.methods
        .requestWithdraw(new BN(1_000_000), new BN(0))
        .accountsStrict({ owner: owner.publicKey, vault: vaultPda, tokenVault, solVault: solVaultPda })
        .signers([owner])
        .rpc(),
      "InvalidAmount",
    );
    await expectError(program.methods.settleWithdraw().accountsStrict(settleAccounts()).signers([owner]).rpc(), "NothingPending");

    await program.methods
      .requestWithdraw(new BN(500), new BN(0.5 * LAMPORTS_PER_SOL))
      .accountsStrict({ owner: owner.publicKey, vault: vaultPda, tokenVault, solVault: solVaultPda })
      .signers([owner])
      .rpc();
    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.pendingWithdrawal?.tokenAmount.toNumber()).to.equal(500);
    const delay = vault.withdrawalDelaySecs; // 2*DAY (the lowering is still pending)
    expect(vault.pendingWithdrawal!.settleAfter.toNumber() - vault.pendingWithdrawal!.requestAt.toNumber()).to.equal(delay);

    await expectError(
      program.methods
        .requestWithdraw(new BN(1), new BN(0))
        .accountsStrict({ owner: owner.publicKey, vault: vaultPda, tokenVault, solVault: solVaultPda })
        .signers([owner])
        .rpc(),
      "WithdrawalPending",
    );
    await expectError(program.methods.settleWithdraw().accountsStrict(settleAccounts()).signers([owner]).rpc(), "NotYetDue");

    // Admin pause does not block request or cancel.
    await program.methods.pause().accountsStrict({ signer: admin.publicKey, vault: vaultPda, config: configPda }).rpc();
    await program.methods.cancelWithdraw().accountsStrict(ownerOnly()).signers([owner]).rpc();
    expect((await program.account.vault.fetch(vaultPda)).pendingWithdrawal).to.be.null;
    await program.methods
      .requestWithdraw(new BN(500), new BN(0.5 * LAMPORTS_PER_SOL))
      .accountsStrict({ owner: owner.publicKey, vault: vaultPda, tokenVault, solVault: solVaultPda })
      .signers([owner])
      .rpc();
    // Admin cannot unpause (owner only); leave it paused for the settle test.
    await expectError(program.methods.unpause().accountsStrict({ owner: admin.publicKey, vault: vaultPda }).rpc(), "NotOwner");
  });

  itFull("[CLOCK] settle_withdraw works after the delay, while admin-paused, with fee split", async () => {
    const vault0 = await program.account.vault.fetch(vaultPda);
    expect(vault0.paused).to.be.true;
    const wait = vault0.pendingWithdrawal!.settleAfter.toNumber() - Math.floor(Date.now() / 1000) + 2;
    await sleep(Math.max(wait, 1));

    const ownerSolBefore = await lamportsOf(owner.publicKey);
    const feeSolBefore = await lamportsOf(feeRecipient.publicKey);
    const refSolBefore = await lamportsOf(referrer.publicKey);
    const ownerTokBefore = await tokensOf(ownerAta);
    const feeTokBefore = await tokensOf(feeRecipientAta);
    const refTokBefore = await tokensOf(referrerAta);

    await program.methods.settleWithdraw().accountsStrict(settleAccounts()).signers([owner]).rpc();

    // 1 % cashout fee, 20 % of it to the referrer. Tokens: 500 -> 5 fee (1 ref, 4 tenfold), 495 to owner.
    expect((await tokensOf(ownerAta)) - ownerTokBefore).to.equal(495);
    expect((await tokensOf(feeRecipientAta)) - feeTokBefore).to.equal(4);
    expect((await tokensOf(referrerAta)) - refTokBefore).to.equal(1);
    // Lamports: 0.5 SOL -> 5_000_000 fee (1_000_000 ref, 4_000_000 tenfold), 495_000_000 to owner.
    // The provider wallet pays the tx fee, so the owner's delta is exact.
    expect((await lamportsOf(owner.publicKey)) - ownerSolBefore).to.equal(495_000_000);
    expect((await lamportsOf(feeRecipient.publicKey)) - feeSolBefore).to.equal(4_000_000);
    expect((await lamportsOf(referrer.publicKey)) - refSolBefore).to.equal(1_000_000);

    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.pendingWithdrawal).to.be.null;
    expect(vault.paused).to.be.true; // still paused: settle never touches the flag

    await program.methods.unpause().accountsStrict(ownerOnly()).signers([owner]).rpc();
  });

  // -------------------------------------------------------------------------
  // admin timelocks (7 days)  [CLOCK]
  // -------------------------------------------------------------------------

  it("admin proposals are timelocked and bounded", async () => {
    await expectError(
      program.methods
        .proposeFeeChange({ ...FEES, feeVolumeBps: 101 })
        .accountsStrict({ admin: admin.publicKey, config: configPda })
        .rpc(),
      "InvalidFee",
    );
    await program.methods
      .proposeFeeChange({ ...FEES, feeVolumeBps: 30 })
      .accountsStrict({ admin: admin.publicKey, config: configPda })
      .rpc();
    await expectError(program.methods.applyFeeChange().accountsStrict({ config: configPda }).rpc(), "NotYetDue");

    await expectError(
      program.methods
        .proposeAllowlistChange([program.programId])
        .accountsStrict({ admin: admin.publicKey, config: configPda, allowlist: allowlistPda })
        .rpc(),
      "ProgramNotAllowed",
    );
    await program.methods
      .proposeAllowlistChange([MEMO_PROGRAM_ID, TOKEN_PROGRAM_ID])
      .accountsStrict({ admin: admin.publicKey, config: configPda, allowlist: allowlistPda })
      .rpc();
    await expectError(program.methods.applyAllowlistChange().accountsStrict({ allowlist: allowlistPda }).rpc(), "NotYetDue");

    const config = await program.account.config.fetch(configPda);
    expect(config.fees.feeVolumeBps).to.equal(50); // unchanged until applied
    expect(config.pendingFeeChange?.schedule.feeVolumeBps).to.equal(30);
  });

  itFull("[CLOCK] fee + allowlist changes apply after 7 days, by anyone", async () => {
    await sleep(7 * DAY + 2);
    await program.methods.applyFeeChange().accountsStrict({ config: configPda }).rpc();
    await program.methods.applyAllowlistChange().accountsStrict({ allowlist: allowlistPda }).rpc();
    const config = await program.account.config.fetch(configPda);
    expect(config.fees.feeVolumeBps).to.equal(30);
    expect(config.pendingFeeChange).to.be.null;
    const allowlist = await program.account.allowlist.fetch(allowlistPda);
    expect(allowlist.programs.length).to.equal(2);

    // Existing vault keeps its 50 bps snapshot as a ceiling and now pays min(50, 30) = 30 bps.
    const feeBefore = await lamportsOf(feeRecipient.publicKey);
    const refBefore = await lamportsOf(referrer.publicKey);
    await buy(0.1 * LAMPORTS_PER_SOL, 2); // fee = 0.3 % of 0.1 SOL = 300_000, 20 % to referrer
    expect((await lamportsOf(feeRecipient.publicKey)) - feeBefore).to.equal(240_000);
    expect((await lamportsOf(referrer.publicKey)) - refBefore).to.equal(60_000);
  });
});
