//! Every state change the proof page cares about emits one of these.
//! Decoded off-chain with the IDL (`program.addEventListener`) or from
//! `Program data:` log lines.

use anchor_lang::prelude::*;

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub delegate: Pubkey,
    pub admin: Pubkey,
    pub daily_sell_cap_bps: u16,
    pub defense_budget_lamports: u64,
    pub withdrawal_delay_secs: u32,
    pub referrer: Option<Pubkey>,
    pub referral_share_bps: u16,
    pub fee_volume_bps: u16,
    pub fee_cashout_bps: u16,
}

#[event]
pub struct Deposited {
    pub vault: Pubkey,
    /// 0 = tokens, 1 = SOL (lamports)
    pub kind: u8,
    pub amount: u64,
    pub depositor: Pubkey,
}

#[event]
pub struct SwapExecuted {
    pub vault: Pubkey,
    /// 0 = buy (SOL -> token), 1 = sell (token -> SOL)
    pub side: u8,
    pub amount_in: u64,
    pub amount_out: u64,
    /// Mirrors `ReasonCode` in packages/core: 0 DEF, 1 DIST, 2 REB, 3 LP, 4 MANUAL
    pub reason: u8,
    pub fee_paid: u64,
    pub referral_paid: u64,
    pub swap_program: Pubkey,
    pub sold_in_window: u64,
    pub defense_spent_lamports: u64,
}

#[event]
pub struct LpAsksPlaced {
    pub vault: Pubkey,
    pub amount: u64,
    pub sold_in_window: u64,
    pub lp_program: Pubkey,
}

#[event]
pub struct CapLowered {
    pub vault: Pubkey,
    pub old_bps: u16,
    pub new_bps: u16,
}

#[event]
pub struct CapRaiseRequested {
    pub vault: Pubkey,
    pub current_bps: u16,
    pub requested_bps: u16,
    pub apply_at: i64,
}

#[event]
pub struct CapRaised {
    pub vault: Pubkey,
    pub old_bps: u16,
    pub new_bps: u16,
}

#[event]
pub struct DefenseBudgetSet {
    pub vault: Pubkey,
    pub old_lamports: u64,
    pub new_lamports: u64,
}

#[event]
pub struct WithdrawalDelaySet {
    pub vault: Pubkey,
    pub old_secs: u32,
    pub new_secs: u32,
    /// Unix time when the new delay becomes effective (now when raising).
    pub effective_at: i64,
}

#[event]
pub struct WithdrawRequested {
    pub vault: Pubkey,
    pub token_amount: u64,
    pub lamports: u64,
    pub request_at: i64,
    pub settle_after: i64,
}

#[event]
pub struct WithdrawSettled {
    pub vault: Pubkey,
    pub token_amount: u64,
    pub lamports: u64,
    pub fee_tokens: u64,
    pub fee_lamports: u64,
    pub referral_tokens: u64,
    pub referral_lamports: u64,
}

#[event]
pub struct WithdrawCancelled {
    pub vault: Pubkey,
}

#[event]
pub struct Paused {
    pub vault: Pubkey,
    pub by: Pubkey,
}

#[event]
pub struct Unpaused {
    pub vault: Pubkey,
}

#[event]
pub struct FeeChangeProposed {
    pub config: Pubkey,
    pub fee_volume_bps: u16,
    pub fee_cashout_bps: u16,
    pub fee_recipient: Pubkey,
    pub apply_at: i64,
}

#[event]
pub struct FeeChangeApplied {
    pub config: Pubkey,
    pub fee_volume_bps: u16,
    pub fee_cashout_bps: u16,
    pub fee_recipient: Pubkey,
}

#[event]
pub struct AllowlistChangeProposed {
    pub allowlist: Pubkey,
    pub programs: Vec<Pubkey>,
    pub apply_at: i64,
}

#[event]
pub struct AllowlistChangeApplied {
    pub allowlist: Pubkey,
    pub programs: Vec<Pubkey>,
}
