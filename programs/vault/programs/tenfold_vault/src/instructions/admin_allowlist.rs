//! Allowlist changes: the admin proposes a full replacement list, anyone
//! applies it after the 7 day timelock. The list is replaced wholesale (not
//! patched) so the proposal event shows traders exactly which programs the
//! delegate will be able to call.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::VaultError;
use crate::events::{AllowlistChangeApplied, AllowlistChangeProposed};
use crate::math::checked_add_i64;
use crate::state::{Allowlist, Config, PendingAllowlistChange};

#[derive(Accounts)]
pub struct ProposeAllowlistChange<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ VaultError::NotAdmin,
    )]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [ALLOWLIST_SEED], bump = allowlist.bump)]
    pub allowlist: Account<'info, Allowlist>,
}

pub fn propose(ctx: Context<ProposeAllowlistChange>, programs: Vec<Pubkey>) -> Result<()> {
    Allowlist::validate_list(&programs)?;
    let now = Clock::get()?.unix_timestamp;
    let apply_at = checked_add_i64(now, ADMIN_TIMELOCK_SECS)?;
    let allowlist = &mut ctx.accounts.allowlist;
    allowlist.pending = Some(PendingAllowlistChange {
        programs: programs.clone(),
        apply_at,
    });
    emit!(AllowlistChangeProposed {
        allowlist: allowlist.key(),
        programs,
        apply_at
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ApplyAllowlistChange<'info> {
    #[account(mut, seeds = [ALLOWLIST_SEED], bump = allowlist.bump)]
    pub allowlist: Account<'info, Allowlist>,
}

pub fn apply(ctx: Context<ApplyAllowlistChange>) -> Result<()> {
    let allowlist = &mut ctx.accounts.allowlist;
    let pending = allowlist
        .pending
        .clone()
        .ok_or_else(|| error!(VaultError::NothingPending))?;
    let now = Clock::get()?.unix_timestamp;
    require!(now >= pending.apply_at, VaultError::NotYetDue);
    Allowlist::validate_list(&pending.programs)?;
    allowlist.programs = pending.programs.clone();
    allowlist.pending = None;
    emit!(AllowlistChangeApplied {
        allowlist: allowlist.key(),
        programs: pending.programs
    });
    Ok(())
}

pub fn cancel(ctx: Context<ProposeAllowlistChange>) -> Result<()> {
    let allowlist = &mut ctx.accounts.allowlist;
    require!(allowlist.pending.is_some(), VaultError::NothingPending);
    allowlist.pending = None;
    Ok(())
}
