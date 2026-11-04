//! Pause: owner or the current Tenfold admin (from Config, so the multisig can
//! rotate). Pausing only stops `delegate_swap` and `place_lp_asks`. Deposits,
//! cap changes and the whole withdrawal path keep working, so a pause can never
//! trap funds.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::VaultError;
use crate::events::Paused;
use crate::state::{Config, Vault};

#[derive(Accounts)]
pub struct Pause<'info> {
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.mint.as_ref(), vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

pub fn handler(ctx: Context<Pause>) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let vault = &mut ctx.accounts.vault;
    require!(
        signer == vault.owner || signer == ctx.accounts.config.admin,
        VaultError::NotOwnerOrAdmin
    );
    require!(!vault.paused, VaultError::AlreadyPaused);
    vault.paused = true;
    emit!(Paused {
        vault: vault.key(),
        by: signer
    });
    Ok(())
}
