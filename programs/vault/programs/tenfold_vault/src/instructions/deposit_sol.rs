//! Anyone may deposit SOL into a vault's lamport PDA. Never blocked by pause.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::constants::*;
use crate::errors::VaultError;
use crate::events::Deposited;
use crate::state::Vault;

#[derive(Accounts)]
pub struct DepositSol<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, vault.mint.as_ref(), vault.owner.as_ref()],
        bump = vault.bump,
        has_one = sol_vault @ VaultError::InvalidTokenAccount,
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut, seeds = [SOL_VAULT_SEED, vault.key().as_ref()], bump = vault.sol_vault_bump)]
    pub sol_vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DepositSol>, lamports: u64) -> Result<()> {
    require!(lamports > 0, VaultError::InvalidAmount);
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: ctx.accounts.sol_vault.to_account_info(),
            },
        ),
        lamports,
    )?;
    emit!(Deposited {
        vault: ctx.accounts.vault.key(),
        kind: 1,
        amount: lamports,
        depositor: ctx.accounts.depositor.key(),
    });
    Ok(())
}
