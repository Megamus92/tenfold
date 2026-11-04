//! Create a project's vault: the `Vault` PDA, its lamport PDA and its token
//! ATA. Fee bps are snapshotted from `Config` so a founder can later prove
//! exactly what they signed up for; `Config` can only ever lower them for this
//! vault (see `delegate_swap` / `settle_withdraw`).

use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::errors::VaultError;
use crate::events::VaultInitialized;
use crate::state::{is_valid_delay, Config, Vault};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitVaultParams {
    /// Tenfold trading key for this project.
    pub delegate: Pubkey,
    pub daily_sell_cap_bps: u16,
    pub defense_budget_lamports: u64,
    /// 86400 or 172800
    pub withdrawal_delay_secs: u32,
    pub referrer: Option<Pubkey>,
}

#[derive(Accounts)]
pub struct InitVault<'info> {
    /// Founder. Pays rent for the vault, its lamport PDA and the token ATA.
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = owner,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, mint.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    /// Data-less system account holding the vault's SOL.
    #[account(mut, seeds = [SOL_VAULT_SEED, vault.key().as_ref()], bump)]
    pub sol_vault: SystemAccount<'info>,

    #[account(
        init,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = vault
    )]
    pub token_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitVault>, params: InitVaultParams) -> Result<()> {
    require!(
        params.daily_sell_cap_bps > 0 && params.daily_sell_cap_bps <= MAX_DAILY_SELL_CAP_BPS,
        VaultError::InvalidCap
    );
    require!(
        is_valid_delay(params.withdrawal_delay_secs),
        VaultError::DelayTooShort
    );
    require_keys_neq!(params.delegate, Pubkey::default(), VaultError::NotDelegate);
    // The founder must not be their own delegate: the badge promises that the
    // trading key is bounded by the cap, and the owner could otherwise sell
    // without the public delay that protects traders.
    require_keys_neq!(
        params.delegate,
        ctx.accounts.owner.key(),
        VaultError::NotDelegate
    );
    if let Some(r) = params.referrer {
        require_keys_neq!(r, Pubkey::default(), VaultError::InvalidAmount);
        require_keys_neq!(r, ctx.accounts.owner.key(), VaultError::InvalidAmount);
    }

    // Fund the lamport PDA so it is rent exempt for 0 bytes. This reserve is
    // never spendable (see sol::available_lamports).
    let reserve = Rent::get()?.minimum_balance(0);
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.owner.to_account_info(),
                to: ctx.accounts.sol_vault.to_account_info(),
            },
        ),
        reserve,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let fees = ctx.accounts.config.fees;
    let admin = ctx.accounts.config.admin;
    let owner_key = ctx.accounts.owner.key();
    let mint_key = ctx.accounts.mint.key();
    let token_vault_key = ctx.accounts.token_vault.key();
    let sol_vault_key = ctx.accounts.sol_vault.key();
    let vault_bump = ctx.bumps.vault;
    let sol_vault_bump = ctx.bumps.sol_vault;

    let vault = &mut ctx.accounts.vault;
    vault.owner = owner_key;
    vault.mint = mint_key;
    vault.token_vault = token_vault_key;
    vault.sol_vault = sol_vault_key;
    vault.delegate = params.delegate;
    vault.admin = admin;
    vault.fee_recipient = fees.fee_recipient;
    vault.referrer = params.referrer;

    vault.daily_sell_cap_bps = params.daily_sell_cap_bps;
    vault.cap_window_start = now;
    vault.sold_in_window = 0;
    vault.pending_cap_raise = None;

    vault.defense_budget_lamports = params.defense_budget_lamports;
    vault.defense_spent_lamports = 0;

    vault.withdrawal_delay_secs = params.withdrawal_delay_secs;
    vault.pending_delay_change = None;
    vault.pending_withdrawal = None;

    vault.paused = false;

    vault.referral_share_bps = if params.referrer.is_some() {
        fees.referral_share_bps
    } else {
        0
    };
    vault.fee_volume_bps = fees.fee_volume_bps;
    vault.fee_cashout_bps = fees.fee_cashout_bps;

    vault.bump = vault_bump;
    vault.sol_vault_bump = sol_vault_bump;
    vault._reserved = [0u8; 64];

    emit!(VaultInitialized {
        vault: vault.key(),
        owner: vault.owner,
        mint: vault.mint,
        delegate: vault.delegate,
        admin: vault.admin,
        daily_sell_cap_bps: vault.daily_sell_cap_bps,
        defense_budget_lamports: vault.defense_budget_lamports,
        withdrawal_delay_secs: vault.withdrawal_delay_secs,
        referrer: vault.referrer,
        referral_share_bps: vault.referral_share_bps,
        fee_volume_bps: vault.fee_volume_bps,
        fee_cashout_bps: vault.fee_cashout_bps,
    });
    Ok(())
}
