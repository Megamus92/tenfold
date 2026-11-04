//! Meteora DLMM adapter for `place_lp_asks`.
//!
//! STATUS: STUB. In a production build this adapter always fails with
//! `InvalidSwapInstruction` so that nobody can believe asks were placed when
//! they were not. The cap accounting around it (in `instructions/place_lp_asks.rs`)
//! is final and tested with the `testing` passthrough.
//!
//! Intended design (Meteora DLMM, program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo):
//!   - one DLMM position per vault, PDA-owned: `initialize_position_pda` with
//!     owner = vault PDA (seeds ["lp_position", vault]). Created lazily.
//!   - `add_liquidity_by_strategy` with
//!       StrategyParameters { min_bin_id, max_bin_id, strategy_type: SpotOneSide }
//!     amount_x = tokens (ask side), amount_y = 0, bins strictly above the
//!     active bin so the position is sell-only.
//!   - `remove_liquidity` / `claim_fee` for unwinding; proceeds (SOL side) land
//!     in the vault's WSOL ATA and are unwrapped with `sol::unwrap_all`.
//!   - Account layout to validate once implemented:
//!       position (vault-owned PDA), lb_pair, bin_array_bitmap_extension,
//!       user_token_x == vault.token_vault, user_token_y == vault.wsol_vault,
//!       reserve_x, reserve_y, token_x_mint == vault.mint, token_y_mint == WSOL,
//!       bin_array_lower, bin_array_upper, sender == vault PDA (signer),
//!       token_x_program, token_y_program, event_authority, program.
//!
//! Cap semantics (final): the token amount handed to the position counts
//! against `sold_in_window` at placement. Tokens that come back when the
//! position is reduced are NOT credited back to the window (conservative;
//! over-counting protects founders, never Tenfold).

use anchor_lang::prelude::*;

use crate::constants::METEORA_DLMM_PROGRAM_ID;
use crate::errors::VaultError;

pub fn program_id() -> Pubkey {
    Pubkey::new_from_array(METEORA_DLMM_PROGRAM_ID)
}

pub fn is_dlmm(key: &Pubkey) -> bool {
    key.to_bytes() == METEORA_DLMM_PROGRAM_ID
}

/// Place `amount` tokens on the ask side. Always errors until implemented.
pub fn place_asks<'info>(
    lp_program: &AccountInfo<'info>,
    _lp_accounts: &[AccountInfo<'info>],
    _ix_data: &[u8],
    _vault: &Pubkey,
    _vault_seeds: &[&[u8]],
    _amount: u64,
) -> Result<()> {
    require!(is_dlmm(&lp_program.key()), VaultError::ProgramNotAllowed);
    msg!("tenfold_vault: DLMM adapter not implemented yet; refusing to place asks");
    err!(VaultError::InvalidSwapInstruction)
}
