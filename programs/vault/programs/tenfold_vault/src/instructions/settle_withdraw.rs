//! Owner settles a pending withdrawal after the delay. Funds can only go to the
//! owner wallet (and its ATA). Works while paused: the admin can freeze trading,
//! never the founder's exit. Settles min(requested, available) so a delegate
//! that sold during the delay cannot make the exit fail; the owner can always
//! request the remainder.
//!
//! Cashout fee: `min(vault.fee_cashout_bps, config.fee_cashout_bps)` of each
//! leg, taken in kind (tokens to the fee recipient's token account, lamports to
//! the fee recipient wallet). The referrer's share is carved out of the fee.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::errors::VaultError;
use crate::events::WithdrawSettled;
use crate::math::{bps_of, checked_sub_u64, split_fee};
use crate::sol::{available_lamports, transfer_from_sol_vault};
use crate::state::{Config, Vault};
use crate::tokens::{require_token_account_for, transfer_from_vault};

#[derive(Accounts)]
pub struct SettleWithdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.mint.as_ref(), vault.owner.as_ref()],
        bump = vault.bump,
        has_one = owner @ VaultError::NotOwner,
        has_one = mint @ VaultError::InvalidMint,
        has_one = token_vault @ VaultError::InvalidTokenAccount,
        has_one = sol_vault @ VaultError::InvalidTokenAccount,
    )]
    pub vault: Account<'info, Vault>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(mut, seeds = [SOL_VAULT_SEED, vault.key().as_ref()], bump = vault.sol_vault_bump)]
    pub sol_vault: SystemAccount<'info>,

    /// Created on the fly if the founder never held the token in this wallet.
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = owner,
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    /// CHECK: constrained to the current fee recipient in Config; receives lamports only.
    #[account(mut, address = config.fees.fee_recipient @ VaultError::InvalidTokenAccount)]
    pub fee_recipient: UncheckedAccount<'info>,

    /// Required when a token fee is due. Validated in the handler: owner == fee_recipient, mint == vault.mint.
    #[account(mut)]
    pub fee_recipient_token_account: Option<Account<'info, TokenAccount>>,

    /// CHECK: must equal vault.referrer when set; validated in the handler. Receives lamports only.
    #[account(mut)]
    pub referrer: Option<UncheckedAccount<'info>>,

    /// Required when a referral token share is due. Validated in the handler.
    #[account(mut)]
    pub referrer_token_account: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<SettleWithdraw>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pending = ctx
        .accounts
        .vault
        .pending_withdrawal
        .ok_or_else(|| error!(VaultError::NothingPending))?;
    require!(now >= pending.settle_after, VaultError::NotYetDue);

    // Amounts actually available right now.
    let token_amount = pending.token_amount.min(ctx.accounts.token_vault.amount);
    let lamports = pending.lamports.min(available_lamports(
        &ctx.accounts.sol_vault.to_account_info(),
    )?);

    // Effective fee: the founder's snapshot is a ceiling, Config can only lower it.
    let cashout_bps = ctx
        .accounts
        .vault
        .fee_cashout_bps
        .min(ctx.accounts.config.fees.fee_cashout_bps);
    let has_referrer = ctx.accounts.vault.referrer.is_some();
    let referral_share_bps = ctx.accounts.vault.referral_share_bps;

    let fee_tokens = bps_of(token_amount, cashout_bps)?;
    let fee_lamports = bps_of(lamports, cashout_bps)?;
    let (tenfold_tokens, ref_tokens) = split_fee(fee_tokens, referral_share_bps, has_referrer)?;
    let (tenfold_lamports, ref_lamports) = split_fee(fee_lamports, referral_share_bps, has_referrer)?;
    let owner_tokens = checked_sub_u64(token_amount, fee_tokens)?;
    let owner_lamports = checked_sub_u64(lamports, fee_lamports)?;

    // Validate the optional recipients only when something is owed to them.
    let fee_recipient_key = ctx.accounts.fee_recipient.key();
    require_token_account_for(
        ctx.accounts.fee_recipient_token_account.as_ref(),
        &fee_recipient_key,
        &ctx.accounts.vault.mint,
        tenfold_tokens > 0,
    )?;
    if let Some(referrer_key) = ctx.accounts.vault.referrer {
        if ref_lamports > 0 || ref_tokens > 0 {
            let referrer_acc = ctx
                .accounts
                .referrer
                .as_ref()
                .ok_or_else(|| error!(VaultError::MissingReferrerAccount))?;
            require_keys_eq!(
                referrer_acc.key(),
                referrer_key,
                VaultError::MissingReferrerAccount
            );
        }
        require_token_account_for(
            ctx.accounts.referrer_token_account.as_ref(),
            &referrer_key,
            &ctx.accounts.vault.mint,
            ref_tokens > 0,
        )?;
    }

    // --- tokens ---------------------------------------------------------------
    transfer_from_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.vault,
        &ctx.accounts.token_vault,
        &ctx.accounts.owner_token_account.to_account_info(),
        owner_tokens,
    )?;
    if tenfold_tokens > 0 {
        let to = ctx
            .accounts
            .fee_recipient_token_account
            .as_ref()
            .unwrap()
            .to_account_info();
        transfer_from_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.token_vault,
            &to,
            tenfold_tokens,
        )?;
    }
    if ref_tokens > 0 {
        let to = ctx
            .accounts
            .referrer_token_account
            .as_ref()
            .unwrap()
            .to_account_info();
        transfer_from_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.token_vault,
            &to,
            ref_tokens,
        )?;
    }

    // --- lamports -------------------------------------------------------------
    let vault_key = ctx.accounts.vault.key();
    let sol_bump = ctx.accounts.vault.sol_vault_bump;
    let sol_vault_info = ctx.accounts.sol_vault.to_account_info();
    transfer_from_sol_vault(
        &ctx.accounts.system_program,
        &sol_vault_info,
        &ctx.accounts.owner.to_account_info(),
        &vault_key,
        sol_bump,
        owner_lamports,
    )?;
    transfer_from_sol_vault(
        &ctx.accounts.system_program,
        &sol_vault_info,
        &ctx.accounts.fee_recipient.to_account_info(),
        &vault_key,
        sol_bump,
        tenfold_lamports,
    )?;
    if ref_lamports > 0 {
        let to = ctx.accounts.referrer.as_ref().unwrap().to_account_info();
        transfer_from_sol_vault(
            &ctx.accounts.system_program,
            &sol_vault_info,
            &to,
            &vault_key,
            sol_bump,
            ref_lamports,
        )?;
    }

    let vault = &mut ctx.accounts.vault;
    vault.pending_withdrawal = None;

    emit!(WithdrawSettled {
        vault: vault.key(),
        token_amount,
        lamports,
        fee_tokens,
        fee_lamports,
        referral_tokens: ref_tokens,
        referral_lamports: ref_lamports,
    });
    Ok(())
}
