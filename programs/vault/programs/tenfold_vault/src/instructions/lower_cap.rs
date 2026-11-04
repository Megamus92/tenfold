//! Owner lowers the daily sell cap. Instant, and only downwards. Any pending
//! raise is dropped: lowering is a defensive move and must not be undone
//! silently by an earlier request.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::VaultError;
use crate::events::CapLowered;
use crate::state::Vault;

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.mint.as_ref(), vault.owner.as_ref()],
        bump = vault.bump,
        has_one = owner @ VaultError::NotOwner,
    )]
    pub vault: Account<'info, Vault>,
}

pub fn handler(ctx: Context<OwnerOnly>, bps: u16) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(bps > 0, VaultError::InvalidCap);
    require!(bps < vault.daily_sell_cap_bps, VaultError::CapNotLower);
    let old = vault.daily_sell_cap_bps;
    vault.daily_sell_cap_bps = bps;
    vault.pending_cap_raise = None;
    emit!(CapLowered {
        vault: vault.key(),
        old_bps: old,
        new_bps: bps
    });
    Ok(())
}
