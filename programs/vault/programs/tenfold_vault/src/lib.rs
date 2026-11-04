//! Tenfold vault. On-chain guard rails that make the "Managed by Tenfold" badge
//! verifiable: a founder's tokens and SOL sit in a PDA that Tenfold's trading key
//! can only use within a daily sell cap, a defense budget and a venue
//! allowlist, while the founder can only exit through a public 24/48h delay.
//!
//! lib.rs is the dispatcher only. One file per instruction under
//! `instructions/`, state in `state.rs`, errors in `errors.rs`, events in
//! `events.rs`, venue adapters in `adapters/`.

#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;

pub mod adapters;
pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod sol;
pub mod state;
pub mod tokens;

use instructions::*;
use state::{FeeSchedule, Side};

declare_id!("ZeuPBsa2uZjspXRs3VgqjTtaBwW9CU6ZPyVzeyrZTNo");

#[program]
pub mod tenfold_vault {
    use super::*;

    // ---- deployment ---------------------------------------------------------

    pub fn init_config(ctx: Context<InitConfig>, params: InitConfigParams) -> Result<()> {
        instructions::init_config::handler(ctx, params)
    }

    // ---- vault lifecycle (owner) ---------------------------------------------

    pub fn init_vault(ctx: Context<InitVault>, params: InitVaultParams) -> Result<()> {
        instructions::init_vault::handler(ctx, params)
    }

    pub fn deposit_tokens(ctx: Context<DepositTokens>, amount: u64) -> Result<()> {
        instructions::deposit_tokens::handler(ctx, amount)
    }

    pub fn deposit_sol(ctx: Context<DepositSol>, lamports: u64) -> Result<()> {
        instructions::deposit_sol::handler(ctx, lamports)
    }

    pub fn lower_cap(ctx: Context<OwnerOnly>, bps: u16) -> Result<()> {
        instructions::lower_cap::handler(ctx, bps)
    }

    pub fn request_raise_cap(ctx: Context<OwnerOnly>, bps: u16) -> Result<()> {
        instructions::request_raise_cap::handler(ctx, bps)
    }

    pub fn apply_raise_cap(ctx: Context<Permissionless>) -> Result<()> {
        instructions::apply_raise_cap::handler(ctx)
    }

    pub fn set_defense_budget(ctx: Context<OwnerOnly>, lamports: u64) -> Result<()> {
        instructions::set_defense_budget::handler(ctx, lamports)
    }

    pub fn set_withdrawal_delay(ctx: Context<OwnerOnly>, secs: u32) -> Result<()> {
        instructions::set_withdrawal_delay::handler(ctx, secs)
    }

    pub fn request_withdraw(
        ctx: Context<RequestWithdraw>,
        token_amount: u64,
        lamports: u64,
    ) -> Result<()> {
        instructions::request_withdraw::handler(ctx, token_amount, lamports)
    }

    pub fn settle_withdraw(ctx: Context<SettleWithdraw>) -> Result<()> {
        instructions::settle_withdraw::handler(ctx)
    }

    pub fn cancel_withdraw(ctx: Context<OwnerOnly>) -> Result<()> {
        instructions::cancel_withdraw::handler(ctx)
    }

    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::pause::handler(ctx)
    }

    pub fn unpause(ctx: Context<OwnerOnly>) -> Result<()> {
        instructions::unpause::handler(ctx)
    }

    // ---- trading (delegate) -------------------------------------------------

    /// remaining_accounts: [0] venue program, [1..] venue instruction accounts.
    pub fn delegate_swap<'info>(
        ctx: Context<'_, '_, 'info, 'info, DelegateSwap<'info>>,
        amount_in: u64,
        min_out: u64,
        side: Side,
        reason: u8,
        route_data: Vec<u8>,
    ) -> Result<()> {
        instructions::delegate_swap::handler(ctx, amount_in, min_out, side, reason, route_data)
    }

    /// remaining_accounts: [0] LP program, [1..] its instruction accounts.
    pub fn place_lp_asks<'info>(
        ctx: Context<'_, '_, 'info, 'info, PlaceLpAsks<'info>>,
        amount: u64,
        ix_data: Vec<u8>,
    ) -> Result<()> {
        instructions::place_lp_asks::handler(ctx, amount, ix_data)
    }

    // ---- admin (7 day timelock) ---------------------------------------------

    pub fn propose_fee_change(ctx: Context<ProposeFeeChange>, fees: FeeSchedule) -> Result<()> {
        instructions::admin_fees::propose(ctx, fees)
    }

    pub fn apply_fee_change(ctx: Context<ApplyFeeChange>) -> Result<()> {
        instructions::admin_fees::apply(ctx)
    }

    pub fn cancel_fee_change(ctx: Context<ProposeFeeChange>) -> Result<()> {
        instructions::admin_fees::cancel(ctx)
    }

    pub fn propose_allowlist_change(
        ctx: Context<ProposeAllowlistChange>,
        programs: Vec<Pubkey>,
    ) -> Result<()> {
        instructions::admin_allowlist::propose(ctx, programs)
    }

    pub fn apply_allowlist_change(ctx: Context<ApplyAllowlistChange>) -> Result<()> {
        instructions::admin_allowlist::apply(ctx)
    }

    pub fn cancel_allowlist_change(ctx: Context<ProposeAllowlistChange>) -> Result<()> {
        instructions::admin_allowlist::cancel(ctx)
    }
}
