//! Owner sets the lifetime defense budget (lamports the delegate may spend on
//! DEF buys). Raising and lowering are both instant: this only limits what Tenfold
//! can do with the founder's SOL, so there is no trader-facing promise to
//! protect with a delay. `defense_spent_lamports` is never reset.

use anchor_lang::prelude::*;

use crate::events::DefenseBudgetSet;

use super::lower_cap::OwnerOnly;

pub fn handler(ctx: Context<OwnerOnly>, lamports: u64) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let old = vault.defense_budget_lamports;
    vault.defense_budget_lamports = lamports;
    emit!(DefenseBudgetSet {
        vault: vault.key(),
        old_lamports: old,
        new_lamports: lamports
    });
    Ok(())
}
