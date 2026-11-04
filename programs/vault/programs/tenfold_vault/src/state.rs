//! Account layouts. Three account types:
//!
//! * `Config`     one per deployment, seeds ["config"]: Tenfold admin, fee schedule,
//!                pending (timelocked) fee change.
//! * `Allowlist`  one per deployment, seeds ["allowlist"]: program ids the
//!                delegate may CPI into, pending (timelocked) replacement.
//! * `Vault`      one per project, seeds ["vault", mint, owner].
//!
//! Lamports are held by a separate, data-less system-owned PDA
//! (seeds ["sol", vault]) so the data account's rent never mixes with user
//! funds and so the program can move SOL with a plain `system_program::transfer`
//! signed by that PDA.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::VaultError;
use crate::math::{bps_of, checked_add_u64};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct FeeSchedule {
    /// Fee on every delegate swap, in bps of amount_in (hard ceiling: MAX_FEE_VOLUME_BPS).
    pub fee_volume_bps: u16,
    /// Fee on owner withdrawals, in bps (hard ceiling: MAX_FEE_CASHOUT_BPS).
    pub fee_cashout_bps: u16,
    /// Share of every fee forwarded to the vault's referrer, in bps of the fee.
    pub referral_share_bps: u16,
    pub fee_recipient: Pubkey,
}

impl FeeSchedule {
    pub fn validate(&self) -> Result<()> {
        require!(
            self.fee_volume_bps <= MAX_FEE_VOLUME_BPS,
            VaultError::InvalidFee
        );
        require!(
            self.fee_cashout_bps <= MAX_FEE_CASHOUT_BPS,
            VaultError::InvalidFee
        );
        require!(
            self.referral_share_bps <= MAX_REFERRAL_SHARE_BPS,
            VaultError::InvalidFee
        );
        require_keys_neq!(
            self.fee_recipient,
            Pubkey::default(),
            VaultError::InvalidFee
        );
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct PendingFeeChange {
    pub schedule: FeeSchedule,
    pub apply_at: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Tenfold multisig. Can pause any vault, propose fee / allowlist changes. Cannot move funds.
    pub admin: Pubkey,
    pub fees: FeeSchedule,
    pub pending_fee_change: Option<PendingFeeChange>,
    pub bump: u8,
    pub _reserved: [u8; 64],
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub struct PendingAllowlistChange {
    #[max_len(8)]
    pub programs: Vec<Pubkey>,
    pub apply_at: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Allowlist {
    #[max_len(8)]
    pub programs: Vec<Pubkey>,
    pub pending: Option<PendingAllowlistChange>,
    pub bump: u8,
    pub _reserved: [u8; 32],
}

impl Allowlist {
    pub fn contains(&self, program_id: &Pubkey) -> bool {
        self.programs.iter().any(|p| p == program_id)
    }

    pub fn validate_list(programs: &[Pubkey]) -> Result<()> {
        require!(programs.len() <= MAX_ALLOWLIST, VaultError::AllowlistFull);
        for p in programs {
            require_keys_neq!(*p, Pubkey::default(), VaultError::ProgramNotAllowed);
            // The vault program itself must never be allowlisted (self-CPI).
            require_keys_neq!(*p, crate::ID, VaultError::ProgramNotAllowed);
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct PendingCapRaise {
    pub bps: u16,
    pub apply_at: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct PendingDelayChange {
    pub secs: u32,
    pub apply_at: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct PendingWithdrawal {
    pub token_amount: u64,
    pub lamports: u64,
    pub request_at: i64,
    /// request_at + the withdrawal delay in force at request time. Snapshotted
    /// so a later delay change can never shorten an in-flight withdrawal.
    pub settle_after: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    /// SOL -> token
    Buy,
    /// token -> SOL
    Sell,
}

impl Side {
    pub fn as_u8(self) -> u8 {
        match self {
            Side::Buy => 0,
            Side::Sell => 1,
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    /// Founder. The only key that can withdraw, and only to itself.
    pub owner: Pubkey,
    pub mint: Pubkey,
    /// ATA(mint, authority = vault PDA).
    pub token_vault: Pubkey,
    /// System-owned PDA ["sol", vault] holding the vault's lamports.
    pub sol_vault: Pubkey,
    /// Tenfold trading key. Can only swap / place asks within the cap, budget and allowlist.
    pub delegate: Pubkey,
    /// Copied from Config at init. Can pause, cannot move funds.
    pub admin: Pubkey,
    pub fee_recipient: Pubkey,
    pub referrer: Option<Pubkey>,

    pub daily_sell_cap_bps: u16,
    pub cap_window_start: i64,
    pub sold_in_window: u64,
    pub pending_cap_raise: Option<PendingCapRaise>,

    pub defense_budget_lamports: u64,
    pub defense_spent_lamports: u64,

    pub withdrawal_delay_secs: u32,
    pub pending_delay_change: Option<PendingDelayChange>,
    pub pending_withdrawal: Option<PendingWithdrawal>,

    pub paused: bool,

    pub referral_share_bps: u16,
    pub fee_volume_bps: u16,
    pub fee_cashout_bps: u16,

    pub bump: u8,
    pub sol_vault_bump: u8,
    pub _reserved: [u8; 64],
}

impl Vault {
    pub fn signer_seeds(&self) -> [&[u8]; 4] {
        [
            VAULT_SEED,
            self.mint.as_ref(),
            self.owner.as_ref(),
            std::slice::from_ref(&self.bump),
        ]
    }

    pub fn require_not_paused(&self) -> Result<()> {
        require!(!self.paused, VaultError::Paused);
        Ok(())
    }

    /// Reset the sell window when it has fully elapsed. Fixed, non-sliding
    /// window per spec: see AUDIT-PREP.md "cap window manipulation".
    pub fn roll_window(&mut self, now: i64) {
        if now.saturating_sub(self.cap_window_start) >= CAP_WINDOW_SECS {
            self.cap_window_start = now;
            self.sold_in_window = 0;
        }
    }

    /// cap = (current token balance + sold_in_window) * bps / 10000
    pub fn window_cap(&self, token_balance: u64) -> Result<u64> {
        let cap_base = checked_add_u64(token_balance, self.sold_in_window)?;
        bps_of(cap_base, self.daily_sell_cap_bps)
    }

    /// Enforce and record `amount` tokens leaving the vault on the sell side.
    /// `token_balance` must be the balance observed BEFORE the movement.
    pub fn record_sale(&mut self, token_balance: u64, amount: u64) -> Result<()> {
        require!(
            amount > 0 && amount <= token_balance,
            VaultError::InvalidAmount
        );
        let cap = self.window_cap(token_balance)?;
        let new_sold = checked_add_u64(self.sold_in_window, amount)?;
        require!(new_sold <= cap, VaultError::CapExceeded);
        self.sold_in_window = new_sold;
        Ok(())
    }

    /// Enforce and record lamports spent on a DEF buy.
    pub fn record_defense_spend(&mut self, lamports: u64) -> Result<()> {
        let new_spent = checked_add_u64(self.defense_spent_lamports, lamports)?;
        require!(
            new_spent <= self.defense_budget_lamports,
            VaultError::BudgetExceeded
        );
        self.defense_spent_lamports = new_spent;
        Ok(())
    }

    /// Apply a pending (lowering) delay change once due. Idempotent.
    pub fn sync_withdrawal_delay(&mut self, now: i64) {
        if let Some(p) = self.pending_delay_change {
            if now >= p.apply_at {
                self.withdrawal_delay_secs = p.secs;
                self.pending_delay_change = None;
            }
        }
    }
}

pub fn is_valid_delay(secs: u32) -> bool {
    secs == WITHDRAWAL_DELAY_ONE_DAY || secs == WITHDRAWAL_DELAY_TWO_DAYS
}
