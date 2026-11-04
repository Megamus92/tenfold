//! Delegate places `amount` tokens on the ask side of a concentrated liquidity
//! position (Meteora DLMM). The tokens count against the rolling sell cap AT
//! PLACEMENT, exactly like a market sell: from the trader's point of view the
//! supply is for sale the moment it sits in the book.
//!
//! The DLMM CPI itself is a stub (adapters/dlmm.rs) that fails closed in a
//! production build. With `--features testing` the instruction is forwarded
//! verbatim to any allowlisted program so the cap accounting can be tested.
//!
//! remaining_accounts: [0] LP program (allowlisted), [1..] its instruction accounts.

use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;

use crate::adapters::dlmm;
use crate::constants::*;
use crate::errors::VaultError;
use crate::events::LpAsksPlaced;
use crate::state::{Allowlist, Vault};

#[derive(Accounts)]
pub struct PlaceLpAsks<'info> {
    pub delegate: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.mint.as_ref(), vault.owner.as_ref()],
        bump = vault.bump,
        has_one = delegate @ VaultError::NotDelegate,
        has_one = token_vault @ VaultError::InvalidTokenAccount,
    )]
    pub vault: Account<'info, Vault>,

    #[account(seeds = [ALLOWLIST_SEED], bump = allowlist.bump)]
    pub allowlist: Account<'info, Allowlist>,

    #[account(mut)]
    pub token_vault: Account<'info, TokenAccount>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, PlaceLpAsks<'info>>,
    amount: u64,
    ix_data: Vec<u8>,
) -> Result<()> {
    ctx.accounts.vault.require_not_paused()?;
    require!(amount > 0, VaultError::InvalidAmount);

    let remaining = ctx.remaining_accounts;
    require!(!remaining.is_empty(), VaultError::ProgramNotAllowed);
    let lp_program = &remaining[0];
    let lp_accounts = &remaining[1..];
    require!(
        ctx.accounts.allowlist.contains(&lp_program.key()),
        VaultError::ProgramNotAllowed
    );
    require!(lp_program.executable, VaultError::NotExecutable);

    let now = Clock::get()?.unix_timestamp;
    let vault_key = ctx.accounts.vault.key();
    let mint_key = ctx.accounts.vault.mint;
    let owner_key = ctx.accounts.vault.owner;
    let vault_bump = ctx.accounts.vault.bump;
    let vault_seeds: &[&[u8]] = &[
        VAULT_SEED,
        mint_key.as_ref(),
        owner_key.as_ref(),
        &[vault_bump],
    ];

    ctx.accounts.token_vault.reload()?;
    let token_before = ctx.accounts.token_vault.amount;

    {
        let vault = &mut ctx.accounts.vault;
        vault.roll_window(now);
        vault.record_sale(token_before, amount)?;
    }

    dispatch(
        lp_program,
        lp_accounts,
        &ix_data,
        &vault_key,
        vault_seeds,
        amount,
    )?;

    ctx.accounts.token_vault.reload()?;
    let token_spent = token_before
        .checked_sub(ctx.accounts.token_vault.amount)
        .ok_or_else(|| error!(VaultError::SourceOverspent))?;
    require!(token_spent <= amount, VaultError::SourceOverspent);

    emit!(LpAsksPlaced {
        vault: vault_key,
        amount,
        sold_in_window: ctx.accounts.vault.sold_in_window,
        lp_program: lp_program.key(),
    });
    Ok(())
}

#[cfg(not(feature = "testing"))]
fn dispatch<'info>(
    lp_program: &AccountInfo<'info>,
    lp_accounts: &[AccountInfo<'info>],
    ix_data: &[u8],
    vault_key: &Pubkey,
    vault_seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    dlmm::place_asks(
        lp_program,
        lp_accounts,
        ix_data,
        vault_key,
        vault_seeds,
        amount,
    )
}

/// TEST ONLY: forward verbatim (Memo in the test suite). DLMM still goes through the stub.
#[cfg(feature = "testing")]
fn dispatch<'info>(
    lp_program: &AccountInfo<'info>,
    lp_accounts: &[AccountInfo<'info>],
    ix_data: &[u8],
    vault_key: &Pubkey,
    vault_seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    if dlmm::is_dlmm(&lp_program.key()) {
        return dlmm::place_asks(
            lp_program,
            lp_accounts,
            ix_data,
            vault_key,
            vault_seeds,
            amount,
        );
    }
    crate::adapters::passthrough::invoke(lp_program, lp_accounts, ix_data, vault_key, vault_seeds)
}
