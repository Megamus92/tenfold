//! Permissionless: anyone (the engine, a cron, the founder) applies a cap raise
//! once its 48h delay has elapsed.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::VaultError;
use crate::events::CapRaised;
use crate::state::Vault;

#[derive(Accounts)]
pub struct Permissionless<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.mint.as_ref(), vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
}

pub fn handler(ctx: Context<Permissionless>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let pending = vault
        .pending_cap_raise
        .ok_or_else(|| error!(VaultError::NothingPending))?;
    let now = Clock::get()?.unix_timestamp;
    require!(now >= pending.apply_at, VaultError::NotYetDue);
    // Defensive: the request path already guarantees this, but a cap can only
    // ever be raised through this instruction, so re-check the bound here.
    require!(
        pending.bps > 0 && pending.bps <= MAX_DAILY_SELL_CAP_BPS,
        VaultError::InvalidCap
    );
    let old = vault.daily_sell_cap_bps;
    vault.daily_sell_cap_bps = pending.bps;
    vault.pending_cap_raise = None;
    emit!(CapRaised {
        vault: vault.key(),
        old_bps: old,
        new_bps: pending.bps
    });
    Ok(())
}
