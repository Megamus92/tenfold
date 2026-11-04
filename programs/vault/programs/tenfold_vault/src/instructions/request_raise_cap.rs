//! Owner asks for a higher cap. Takes effect 48h later via `apply_raise_cap`,
//! which gives traders two days to see the change on the proof page and react.
//! A new request replaces the old one and restarts the timer.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::VaultError;
use crate::events::CapRaiseRequested;
use crate::math::checked_add_i64;
use crate::state::PendingCapRaise;

use super::lower_cap::OwnerOnly;

pub fn handler(ctx: Context<OwnerOnly>, bps: u16) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(bps <= MAX_DAILY_SELL_CAP_BPS, VaultError::InvalidCap);
    require!(bps > vault.daily_sell_cap_bps, VaultError::CapNotHigher);
    let now = Clock::get()?.unix_timestamp;
    let apply_at = checked_add_i64(now, CAP_RAISE_DELAY_SECS)?;
    vault.pending_cap_raise = Some(PendingCapRaise { bps, apply_at });
    emit!(CapRaiseRequested {
        vault: vault.key(),
        current_bps: vault.daily_sell_cap_bps,
        requested_bps: bps,
        apply_at,
    });
    Ok(())
}
