//! Unpause: owner only. The admin can stop trading but never restart it against
//! the founder's will.

use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::Unpaused;

use super::lower_cap::OwnerOnly;

pub fn handler(ctx: Context<OwnerOnly>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(vault.paused, VaultError::NotPaused);
    vault.paused = false;
    emit!(Unpaused { vault: vault.key() });
    Ok(())
}
