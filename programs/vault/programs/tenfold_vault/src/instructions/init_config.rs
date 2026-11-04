//! One-time deployment setup: creates the `Config` and `Allowlist` singletons.
//! The admin multisig must sign so a stranger cannot front-run the deploy and
//! install their own fee recipient.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::VaultError;
use crate::state::{Allowlist, Config, FeeSchedule};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitConfigParams {
    pub fees: FeeSchedule,
    pub allowlist: Vec<Pubkey>,
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    /// Tenfold multisig; becomes `config.admin`.
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = admin,
        space = 8 + Allowlist::INIT_SPACE,
        seeds = [ALLOWLIST_SEED],
        bump
    )]
    pub allowlist: Account<'info, Allowlist>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitConfig>, params: InitConfigParams) -> Result<()> {
    params.fees.validate()?;
    Allowlist::validate_list(&params.allowlist)?;
    require!(!params.allowlist.is_empty(), VaultError::ProgramNotAllowed);

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.fees = params.fees;
    config.pending_fee_change = None;
    config.bump = ctx.bumps.config;
    config._reserved = [0u8; 64];

    let allowlist = &mut ctx.accounts.allowlist;
    allowlist.programs = params.allowlist;
    allowlist.pending = None;
    allowlist.bump = ctx.bumps.allowlist;
    allowlist._reserved = [0u8; 32];
    Ok(())
}
