//! Owner cancels a pending withdrawal. Works while paused.

use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::WithdrawCancelled;

use super::lower_cap::OwnerOnly;

pub fn handler(ctx: Context<OwnerOnly>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(
        vault.pending_withdrawal.is_some(),
        VaultError::NothingPending
    );
    vault.pending_withdrawal = None;
    emit!(WithdrawCancelled { vault: vault.key() });
    Ok(())
}
