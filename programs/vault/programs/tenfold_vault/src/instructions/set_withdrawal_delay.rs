//! Owner changes the withdrawal delay between the two allowed values.
//! Raising (24h -> 48h) is instant. Lowering (48h -> 24h) is scheduled and only
//! takes effect after the delay currently in force, so a founder cannot
//! shorten the exit window traders are relying on without that window elapsing.

use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::WithdrawalDelaySet;
use crate::math::checked_add_i64;
use crate::state::{is_valid_delay, PendingDelayChange};

use super::lower_cap::OwnerOnly;

pub fn handler(ctx: Context<OwnerOnly>, secs: u32) -> Result<()> {
    require!(is_valid_delay(secs), VaultError::DelayTooShort);
    let vault = &mut ctx.accounts.vault;
    let now = Clock::get()?.unix_timestamp;
    vault.sync_withdrawal_delay(now);

    let old = vault.withdrawal_delay_secs;
    if secs >= old {
        // Raising (or re-asserting the same value): instant, cancels any pending lowering.
        vault.withdrawal_delay_secs = secs;
        vault.pending_delay_change = None;
        emit!(WithdrawalDelaySet {
            vault: vault.key(),
            old_secs: old,
            new_secs: secs,
            effective_at: now
        });
    } else {
        let apply_at = checked_add_i64(now, old as i64)?;
        vault.pending_delay_change = Some(PendingDelayChange { secs, apply_at });
        emit!(WithdrawalDelaySet {
            vault: vault.key(),
            old_secs: old,
            new_secs: secs,
            effective_at: apply_at
        });
    }
    Ok(())
}
