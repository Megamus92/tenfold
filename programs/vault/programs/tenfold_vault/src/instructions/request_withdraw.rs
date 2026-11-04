//! Owner announces a withdrawal. Works while paused (otherwise the admin could
//! trap funds by pausing first). The settle time is snapshotted from the delay
//! in force now, so a later delay change can never shorten an in-flight request.

use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;

use crate::constants::*;
use crate::errors::VaultError;
use crate::events::WithdrawRequested;
use crate::math::checked_add_i64;
use crate::sol::available_lamports;
use crate::state::{PendingWithdrawal, Vault};

#[derive(Accounts)]
pub struct RequestWithdraw<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.mint.as_ref(), vault.owner.as_ref()],
        bump = vault.bump,
        has_one = owner @ VaultError::NotOwner,
        has_one = token_vault @ VaultError::InvalidTokenAccount,
        has_one = sol_vault @ VaultError::InvalidTokenAccount,
    )]
    pub vault: Account<'info, Vault>,

    pub token_vault: Account<'info, TokenAccount>,

    #[account(seeds = [SOL_VAULT_SEED, vault.key().as_ref()], bump = vault.sol_vault_bump)]
    pub sol_vault: SystemAccount<'info>,
}

pub fn handler(ctx: Context<RequestWithdraw>, token_amount: u64, lamports: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let available = available_lamports(&ctx.accounts.sol_vault.to_account_info())?;
    let token_balance = ctx.accounts.token_vault.amount;

    let vault = &mut ctx.accounts.vault;
    require!(
        vault.pending_withdrawal.is_none(),
        VaultError::WithdrawalPending
    );
    require!(token_amount > 0 || lamports > 0, VaultError::InvalidAmount);
    require!(token_amount <= token_balance, VaultError::InvalidAmount);
    require!(lamports <= available, VaultError::InvalidAmount);

    vault.sync_withdrawal_delay(now);
    let settle_after = checked_add_i64(now, vault.withdrawal_delay_secs as i64)?;
    vault.pending_withdrawal = Some(PendingWithdrawal {
        token_amount,
        lamports,
        request_at: now,
        settle_after,
    });

    emit!(WithdrawRequested {
        vault: vault.key(),
        token_amount,
        lamports,
        request_at: now,
        settle_after,
    });
    Ok(())
}
