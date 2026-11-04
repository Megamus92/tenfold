//! SPL token helpers signed by the vault PDA.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::VaultError;
use crate::state::Vault;

/// Transfer `amount` tokens out of a vault-owned token account. No-op for 0.
pub fn transfer_from_vault<'info>(
    token_program: &Program<'info, Token>,
    vault: &Account<'info, Vault>,
    from: &Account<'info, TokenAccount>,
    to: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds = vault.signer_seeds();
    let signer: &[&[&[u8]]] = &[&seeds];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: from.to_account_info(),
                to: to.clone(),
                authority: vault.to_account_info(),
            },
            signer,
        ),
        amount,
    )
}

/// Check that an optional token account, when needed, is present and is a
/// token account for `mint` owned by `expected_owner`.
pub fn require_token_account_for<'info>(
    account: Option<&Account<'info, TokenAccount>>,
    expected_owner: &Pubkey,
    mint: &Pubkey,
    needed: bool,
) -> Result<()> {
    if !needed {
        return Ok(());
    }
    let acc = account.ok_or_else(|| error!(VaultError::MissingReferrerAccount))?;
    require_keys_eq!(acc.owner, *expected_owner, VaultError::InvalidTokenAccount);
    require_keys_eq!(acc.mint, *mint, VaultError::InvalidTokenAccount);
    Ok(())
}
