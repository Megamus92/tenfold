//! Lamport and WSOL plumbing.
//!
//! All of a vault's SOL lives in `sol_vault`, a data-less system-owned PDA
//! (seeds ["sol", vault]). It must stay rent-exempt for 0 bytes
//! (`Rent::minimum_balance(0)`), so `available_lamports` subtracts that
//! reserve from everything the owner or delegate may move.
//!
//! Swaps need WSOL. Rather than keeping a WSOL account alive between swaps
//! (which would need close-then-recreate inside one instruction), each
//! `delegate_swap` uses a scratch PDA token account (seeds ["wsol", vault]):
//!   - created at the top of the instruction by Anchor `init_if_needed`,
//!     rent paid by the delegate;
//!   - funded from `sol_vault` for a buy (`wrap_into_wsol`), or filled by the
//!     venue for a sell;
//!   - closed at the end of the same instruction into `sol_vault`
//!     (`close_wsol_and_refund_rent`), which then refunds the delegate's rent.
//! Between instructions the scratch account does not exist, so the invariant
//! "every lamport of the vault is in `sol_vault`" holds at every tx boundary.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::token::{self, CloseAccount, SyncNative, Token, TokenAccount};

use crate::constants::SOL_VAULT_SEED;
use crate::errors::VaultError;
use crate::state::Vault;

/// Lamports the vault may spend without breaking rent exemption of `sol_vault`.
pub fn available_lamports(sol_vault: &AccountInfo) -> Result<u64> {
    let reserve = Rent::get()?.minimum_balance(0);
    Ok(sol_vault.lamports().saturating_sub(reserve))
}

/// Transfer `lamports` out of `sol_vault`, signed by its PDA seeds. No-op for 0.
pub fn transfer_from_sol_vault<'info>(
    system_program: &Program<'info, System>,
    sol_vault: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    vault_key: &Pubkey,
    sol_vault_bump: u8,
    lamports: u64,
) -> Result<()> {
    if lamports == 0 {
        return Ok(());
    }
    let available = available_lamports(sol_vault)?;
    require!(lamports <= available, VaultError::InvalidAmount);
    let seeds: &[&[u8]] = &[SOL_VAULT_SEED, vault_key.as_ref(), &[sol_vault_bump]];
    system_program::transfer(
        CpiContext::new_with_signer(
            system_program.to_account_info(),
            Transfer {
                from: sol_vault.clone(),
                to: to.clone(),
            },
            &[seeds],
        ),
        lamports,
    )
}

/// Move `lamports` from `sol_vault` into the scratch WSOL account and sync so
/// its token balance reflects them. Used right before a buy.
pub fn wrap_into_wsol<'info>(
    system_program: &Program<'info, System>,
    token_program: &Program<'info, Token>,
    sol_vault: &AccountInfo<'info>,
    wsol_vault: &Account<'info, TokenAccount>,
    vault_key: &Pubkey,
    sol_vault_bump: u8,
    lamports: u64,
) -> Result<()> {
    transfer_from_sol_vault(
        system_program,
        sol_vault,
        &wsol_vault.to_account_info(),
        vault_key,
        sol_vault_bump,
        lamports,
    )?;
    token::sync_native(CpiContext::new(
        token_program.to_account_info(),
        SyncNative {
            account: wsol_vault.to_account_info(),
        },
    ))
}

/// Close the scratch WSOL account into `sol_vault` (unwrapping its whole token
/// balance plus its rent) and refund the rent to `rent_payer` (the delegate).
/// Returns the WSOL amount that was unwrapped.
pub fn close_wsol_and_refund_rent<'info>(
    vault: &Account<'info, Vault>,
    wsol_vault: &mut Account<'info, TokenAccount>,
    sol_vault: &AccountInfo<'info>,
    rent_payer: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    system_program: &Program<'info, System>,
) -> Result<u64> {
    wsol_vault.reload()?;
    let amount = wsol_vault.amount;

    let vault_seeds = vault.signer_seeds();
    let vault_signer: &[&[&[u8]]] = &[&vault_seeds];
    token::close_account(CpiContext::new_with_signer(
        token_program.to_account_info(),
        CloseAccount {
            account: wsol_vault.to_account_info(),
            destination: sol_vault.clone(),
            authority: vault.to_account_info(),
        },
        vault_signer,
    ))?;

    // Give the delegate back exactly the rent it paid to open the scratch account.
    let rent = Rent::get()?.minimum_balance(TokenAccount::LEN);
    let vault_key = vault.key();
    transfer_from_sol_vault(
        system_program,
        sol_vault,
        rent_payer,
        &vault_key,
        vault.sol_vault_bump,
        rent,
    )?;
    Ok(amount)
}
