//! Fee schedule changes: proposed by the admin, applied by anyone after the
//! 7 day timelock. Hard ceilings in `constants.rs` bound every value. Each
//! vault's own fee bps act as a ceiling for that vault (see `delegate_swap` and
//! `settle_withdraw`), so a Config change can only ever LOWER fees for existing
//! vaults; higher fees apply to vaults created after the change.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::VaultError;
use crate::events::{FeeChangeApplied, FeeChangeProposed};
use crate::math::checked_add_i64;
use crate::state::{Config, FeeSchedule, PendingFeeChange};

#[derive(Accounts)]
pub struct ProposeFeeChange<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ VaultError::NotAdmin,
    )]
    pub config: Account<'info, Config>,
}

pub fn propose(ctx: Context<ProposeFeeChange>, fees: FeeSchedule) -> Result<()> {
    fees.validate()?;
    let now = Clock::get()?.unix_timestamp;
    let apply_at = checked_add_i64(now, ADMIN_TIMELOCK_SECS)?;
    let config = &mut ctx.accounts.config;
    config.pending_fee_change = Some(PendingFeeChange {
        schedule: fees,
        apply_at,
    });
    emit!(FeeChangeProposed {
        config: config.key(),
        fee_volume_bps: fees.fee_volume_bps,
        fee_cashout_bps: fees.fee_cashout_bps,
        fee_recipient: fees.fee_recipient,
        apply_at,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ApplyFeeChange<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

pub fn apply(ctx: Context<ApplyFeeChange>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let pending = config
        .pending_fee_change
        .ok_or_else(|| error!(VaultError::NothingPending))?;
    let now = Clock::get()?.unix_timestamp;
    require!(now >= pending.apply_at, VaultError::NotYetDue);
    pending.schedule.validate()?;
    config.fees = pending.schedule;
    config.pending_fee_change = None;
    emit!(FeeChangeApplied {
        config: config.key(),
        fee_volume_bps: config.fees.fee_volume_bps,
        fee_cashout_bps: config.fees.fee_cashout_bps,
        fee_recipient: config.fees.fee_recipient,
    });
    Ok(())
}

/// Admin may withdraw a proposal before it is applied (no timelock needed:
/// cancelling a change keeps the status quo).
pub fn cancel(ctx: Context<ProposeFeeChange>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(
        config.pending_fee_change.is_some(),
        VaultError::NothingPending
    );
    config.pending_fee_change = None;
    Ok(())
}
