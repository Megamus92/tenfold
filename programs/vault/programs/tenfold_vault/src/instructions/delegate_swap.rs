//! The only way tokens or SOL leave a vault other than an owner withdrawal.
//!
//! The delegate (Tenfold trading key) asks the vault to swap through an
//! allowlisted venue. The vault:
//!   1. refuses while paused;
//!   2. checks the venue program (remaining_accounts[0]) is on the `Allowlist`;
//!   3. on a SELL, rolls the 24h window and enforces
//!        sold_in_window + amount_in <= (token_balance + sold_in_window) * cap_bps / 10000
//!   4. on a DEF BUY, enforces defense_spent + amount_in <= defense_budget;
//!   5. hands exactly `amount_in` of the source leg to the venue, signs only for
//!      the vault's own two token accounts, and verifies by balance deltas that
//!      the venue took no more than `amount_in` and returned at least `min_out`;
//!   6. takes the volume fee in SOL (buy: on amount_in before the swap;
//!      sell: on the SOL received) and splits it with the referrer.
//!
//! WSOL: a scratch token account (PDA ["wsol", vault]) is created by
//! `init_if_needed` at the top of the instruction (rent paid by the delegate)
//! and closed at the bottom into `sol_vault`, which refunds the rent. It never
//! exists between transactions. See `sol.rs`.
//!
//! remaining_accounts layout:
//!   [0]   venue program (must be allowlisted and executable)
//!   [1..] the venue instruction's accounts, in order (see adapters/jupiter.rs)
//!
//! `route_data` is the venue instruction's raw data (for Jupiter: the
//! `swapInstruction.data` from /v6/swap-instructions).

use anchor_lang::prelude::*;
use anchor_spl::token::{spl_token, Mint, Token, TokenAccount};

use crate::adapters::{jupiter, SwapLegs};
use crate::constants::*;
use crate::errors::VaultError;
use crate::events::SwapExecuted;
use crate::math::{bps_of, checked_add_u64, split_fee};
use crate::sol::{
    available_lamports, close_wsol_and_refund_rent, transfer_from_sol_vault, wrap_into_wsol,
};
use crate::state::{Allowlist, Config, Side, Vault};

#[derive(Accounts)]
pub struct DelegateSwap<'info> {
    /// Tenfold trading key. Pays (and gets back) the scratch WSOL account rent.
    #[account(mut)]
    pub delegate: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.mint.as_ref(), vault.owner.as_ref()],
        bump = vault.bump,
        has_one = delegate @ VaultError::NotDelegate,
        has_one = mint @ VaultError::InvalidMint,
        has_one = token_vault @ VaultError::InvalidTokenAccount,
        has_one = sol_vault @ VaultError::InvalidTokenAccount,
    )]
    pub vault: Account<'info, Vault>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(seeds = [ALLOWLIST_SEED], bump = allowlist.bump)]
    pub allowlist: Account<'info, Allowlist>,

    pub mint: Account<'info, Mint>,

    #[account(address = spl_token::native_mint::ID)]
    pub wsol_mint: Account<'info, Mint>,

    #[account(mut)]
    pub token_vault: Account<'info, TokenAccount>,

    /// Scratch WSOL account for this swap only; closed before the instruction returns.
    #[account(
        init_if_needed,
        payer = delegate,
        seeds = [WSOL_SEED, vault.key().as_ref()],
        bump,
        token::mint = wsol_mint,
        token::authority = vault,
    )]
    pub wsol_vault: Account<'info, TokenAccount>,

    #[account(mut, seeds = [SOL_VAULT_SEED, vault.key().as_ref()], bump = vault.sol_vault_bump)]
    pub sol_vault: SystemAccount<'info>,

    /// CHECK: constrained to the current fee recipient in Config; receives lamports only.
    #[account(mut, address = config.fees.fee_recipient @ VaultError::InvalidTokenAccount)]
    pub fee_recipient: UncheckedAccount<'info>,

    /// CHECK: must equal vault.referrer when a referral fee is due; validated in the handler.
    #[account(mut)]
    pub referrer: Option<UncheckedAccount<'info>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// Harmless if the Anchor version in use no longer needs it for token `init`.
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, DelegateSwap<'info>>,
    amount_in: u64,
    min_out: u64,
    side: Side,
    reason: u8,
    route_data: Vec<u8>,
) -> Result<()> {
    ctx.accounts.vault.require_not_paused()?;
    require!(amount_in > 0, VaultError::InvalidAmount);
    require!(reason <= REASON_MAX, VaultError::InvalidReason);
    if side == Side::Sell {
        require!(reason != REASON_DEF, VaultError::InvalidReason);
    }

    // --- venue --------------------------------------------------------------
    let remaining = ctx.remaining_accounts;
    require!(!remaining.is_empty(), VaultError::ProgramNotAllowed);
    let swap_program = &remaining[0];
    let route_accounts = &remaining[1..];
    require!(
        ctx.accounts.allowlist.contains(&swap_program.key()),
        VaultError::ProgramNotAllowed
    );
    require!(swap_program.executable, VaultError::NotExecutable);

    // --- bookkeeping snapshot --------------------------------------------------
    let now = Clock::get()?.unix_timestamp;
    let vault_key = ctx.accounts.vault.key();
    let mint_key = ctx.accounts.vault.mint;
    let owner_key = ctx.accounts.vault.owner;
    let vault_bump = ctx.accounts.vault.bump;
    let sol_bump = ctx.accounts.vault.sol_vault_bump;
    let vault_seeds: &[&[u8]] = &[
        VAULT_SEED,
        mint_key.as_ref(),
        owner_key.as_ref(),
        &[vault_bump],
    ];

    let volume_bps = ctx
        .accounts
        .vault
        .fee_volume_bps
        .min(ctx.accounts.config.fees.fee_volume_bps);
    let referral_share_bps = ctx.accounts.vault.referral_share_bps;
    let referrer_key = ctx.accounts.vault.referrer;

    ctx.accounts.token_vault.reload()?;
    ctx.accounts.wsol_vault.reload()?;
    let token_before = ctx.accounts.token_vault.amount;
    let wsol_before = ctx.accounts.wsol_vault.amount; // 0 unless someone pre-funded the scratch PDA

    let sol_vault_info = ctx.accounts.sol_vault.to_account_info();
    let delegate_info = ctx.accounts.delegate.to_account_info();

    let (amount_out, fee_total, referral_paid) = match side {
        // ---------------------------------------------------------------- BUY
        Side::Buy => {
            // Fee is charged on top of amount_in so `amount_in` is exactly what the
            // venue receives and exactly what the defense budget is debited.
            let fee = bps_of(amount_in, volume_bps)?;
            let (tenfold_fee, ref_fee) = split_fee(fee, referral_share_bps, referrer_key.is_some())?;
            let total = checked_add_u64(amount_in, fee)?;
            // The rent refund at the end also comes out of sol_vault (it is paid in by the
            // close), so only amount_in + fee need to be available up front.
            require!(
                total <= available_lamports(&sol_vault_info)?,
                VaultError::InvalidAmount
            );

            if reason == REASON_DEF {
                ctx.accounts.vault.record_defense_spend(amount_in)?;
            }

            wrap_into_wsol(
                &ctx.accounts.system_program,
                &ctx.accounts.token_program,
                &sol_vault_info,
                &ctx.accounts.wsol_vault,
                &vault_key,
                sol_bump,
                amount_in,
            )?;

            let legs = SwapLegs {
                vault: vault_key,
                source: ctx.accounts.wsol_vault.key(),
                destination: ctx.accounts.token_vault.key(),
            };
            dispatch(
                swap_program,
                route_accounts,
                &route_data,
                &legs,
                vault_seeds,
            )?;

            ctx.accounts.token_vault.reload()?;
            ctx.accounts.wsol_vault.reload()?;
            let amount_out = ctx
                .accounts
                .token_vault
                .amount
                .checked_sub(token_before)
                .ok_or_else(|| error!(VaultError::SourceOverspent))?;
            require!(amount_out >= min_out, VaultError::SlippageExceeded);
            // The venue may consume at most the amount_in we just wrapped.
            require!(
                ctx.accounts.wsol_vault.amount >= wsol_before,
                VaultError::SourceOverspent
            );

            // Unspent WSOL (and the scratch rent) go back to the lamport PDA.
            close_wsol_and_refund_rent(
                &ctx.accounts.vault,
                &mut ctx.accounts.wsol_vault,
                &sol_vault_info,
                &delegate_info,
                &ctx.accounts.token_program,
                &ctx.accounts.system_program,
            )?;

            pay_sol_fees(
                &ctx,
                &sol_vault_info,
                &vault_key,
                sol_bump,
                tenfold_fee,
                ref_fee,
                referrer_key,
            )?;
            (amount_out, fee, ref_fee)
        }

        // --------------------------------------------------------------- SELL
        Side::Sell => {
            {
                let vault = &mut ctx.accounts.vault;
                vault.roll_window(now);
                vault.record_sale(token_before, amount_in)?;
            }

            let legs = SwapLegs {
                vault: vault_key,
                source: ctx.accounts.token_vault.key(),
                destination: ctx.accounts.wsol_vault.key(),
            };
            dispatch(
                swap_program,
                route_accounts,
                &route_data,
                &legs,
                vault_seeds,
            )?;

            ctx.accounts.token_vault.reload()?;
            ctx.accounts.wsol_vault.reload()?;
            let token_spent = token_before
                .checked_sub(ctx.accounts.token_vault.amount)
                .ok_or_else(|| error!(VaultError::SourceOverspent))?;
            require!(token_spent <= amount_in, VaultError::SourceOverspent);
            let wsol_out = ctx
                .accounts
                .wsol_vault
                .amount
                .checked_sub(wsol_before)
                .ok_or_else(|| error!(VaultError::SlippageExceeded))?;
            require!(wsol_out >= min_out, VaultError::SlippageExceeded);

            close_wsol_and_refund_rent(
                &ctx.accounts.vault,
                &mut ctx.accounts.wsol_vault,
                &sol_vault_info,
                &delegate_info,
                &ctx.accounts.token_program,
                &ctx.accounts.system_program,
            )?;

            // Volume fee on the SOL leg so Tenfold never ends up holding project tokens.
            let fee = bps_of(wsol_out, volume_bps)?;
            let (tenfold_fee, ref_fee) = split_fee(fee, referral_share_bps, referrer_key.is_some())?;
            pay_sol_fees(
                &ctx,
                &sol_vault_info,
                &vault_key,
                sol_bump,
                tenfold_fee,
                ref_fee,
                referrer_key,
            )?;
            (wsol_out, fee, ref_fee)
        }
    };

    let vault = &ctx.accounts.vault;
    emit!(SwapExecuted {
        vault: vault_key,
        side: side.as_u8(),
        amount_in,
        amount_out,
        reason,
        fee_paid: fee_total,
        referral_paid,
        swap_program: swap_program.key(),
        sold_in_window: vault.sold_in_window,
        defense_spent_lamports: vault.defense_spent_lamports,
    });
    Ok(())
}

/// Pay the Tenfold and referral shares of a SOL-denominated fee out of the lamport PDA.
fn pay_sol_fees<'info>(
    ctx: &Context<'_, '_, 'info, 'info, DelegateSwap<'info>>,
    sol_vault_info: &AccountInfo<'info>,
    vault_key: &Pubkey,
    sol_bump: u8,
    tenfold_fee: u64,
    ref_fee: u64,
    referrer_key: Option<Pubkey>,
) -> Result<()> {
    transfer_from_sol_vault(
        &ctx.accounts.system_program,
        sol_vault_info,
        &ctx.accounts.fee_recipient.to_account_info(),
        vault_key,
        sol_bump,
        tenfold_fee,
    )?;
    if ref_fee > 0 {
        let expected = referrer_key.ok_or_else(|| error!(VaultError::MissingReferrerAccount))?;
        let referrer = ctx
            .accounts
            .referrer
            .as_ref()
            .ok_or_else(|| error!(VaultError::MissingReferrerAccount))?;
        require_keys_eq!(referrer.key(), expected, VaultError::MissingReferrerAccount);
        transfer_from_sol_vault(
            &ctx.accounts.system_program,
            sol_vault_info,
            &referrer.to_account_info(),
            vault_key,
            sol_bump,
            ref_fee,
        )?;
    }
    Ok(())
}

/// Route the CPI to the adapter that knows this venue's account layout.
fn dispatch<'info>(
    swap_program: &AccountInfo<'info>,
    route_accounts: &[AccountInfo<'info>],
    route_data: &[u8],
    legs: &SwapLegs,
    vault_seeds: &[&[u8]],
) -> Result<()> {
    if jupiter::is_jupiter(&swap_program.key()) {
        return jupiter::invoke(swap_program, route_accounts, route_data, legs, vault_seeds);
    }
    fallback(swap_program, route_accounts, route_data, legs, vault_seeds)
}

/// Allowlisted but no adapter: refuse. Production builds only.
#[cfg(not(feature = "testing"))]
fn fallback<'info>(
    _swap_program: &AccountInfo<'info>,
    _route_accounts: &[AccountInfo<'info>],
    _route_data: &[u8],
    _legs: &SwapLegs,
    _vault_seeds: &[&[u8]],
) -> Result<()> {
    err!(VaultError::InvalidSwapInstruction)
}

/// TEST ONLY: forward verbatim to any allowlisted program (the tests use Memo).
#[cfg(feature = "testing")]
fn fallback<'info>(
    swap_program: &AccountInfo<'info>,
    route_accounts: &[AccountInfo<'info>],
    route_data: &[u8],
    legs: &SwapLegs,
    vault_seeds: &[&[u8]],
) -> Result<()> {
    crate::adapters::passthrough::invoke(
        swap_program,
        route_accounts,
        route_data,
        &legs.vault,
        vault_seeds,
    )
}
