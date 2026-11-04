//! Venue adapters. `delegate_swap` and `place_lp_asks` only ever call into a
//! program that is (1) on the `Allowlist` PDA and (2) has an adapter here that
//! knows its account layout. The adapter's job is to make sure the vault PDA
//! only signs for the token accounts the vault owns and that the vault is the
//! only signer we provide. Everything value-related (how much left, how much
//! came back) is verified by balance deltas in the instruction handler, never
//! trusted from the venue.

pub mod dlmm;
pub mod jupiter;

#[cfg(feature = "testing")]
pub mod passthrough;

use anchor_lang::prelude::*;

/// Which of the vault's token accounts a swap moves between.
pub struct SwapLegs {
    pub vault: Pubkey,
    pub source: Pubkey,
    pub destination: Pubkey,
}

/// Build account metas for a CPI where the only signer we add is the vault PDA.
/// Any other `is_signer` flag coming from the client is dropped: the runtime
/// would reject a signer we cannot sign for, and we never want to forward a
/// third party's signature into a venue on the vault's behalf.
pub fn vault_only_metas(accounts: &[AccountInfo], vault: &Pubkey) -> Vec<AccountMeta> {
    accounts
        .iter()
        .map(|a| AccountMeta {
            pubkey: a.key(),
            is_signer: a.key() == *vault,
            is_writable: a.is_writable,
        })
        .collect()
}
