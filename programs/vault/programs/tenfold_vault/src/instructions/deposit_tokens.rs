//! Anyone may deposit project tokens into a vault (founder, treasury, a
//! second wallet). Deposits are never blocked by pause.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::VaultError;
use crate::events::Deposited;
use crate::state::Vault;

#[derive(Accounts)]
pub struct DepositTokens<'info> {
    pub depositor: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.mint.as_ref(), vault.owner.as_ref()],
        bump = vault.bump,
        has_one = mint @ VaultError::InvalidMint,
        has_one = token_vault @ VaultError::InvalidTokenAccount,
    )]
    pub vault: Account<'info, Vault>,

    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = depositor,
    )]
    pub depositor_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<DepositTokens>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::InvalidAmount);
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.depositor_token_account.to_account_info(),
                to: ctx.accounts.token_vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
    )?;
    emit!(Deposited {
        vault: ctx.accounts.vault.key(),
        kind: 0,
        amount,
        depositor: ctx.accounts.depositor.key(),
    });
    Ok(())
}
