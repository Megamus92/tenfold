//! Jupiter v6 adapter.
//!
//! STATUS: STUB, NOT EXERCISED BY THE TEST SUITE. The code below compiles the
//! CPI and performs the account-position checks, but nobody has run it against
//! the real Jupiter program yet. Until that is done, treat it as documentation
//! of the intended layout. The handler's balance-delta checks make a wrong
//! layout fail closed (the venue cannot take more than `amount_in` or return
//! less than `min_out`), so a mistake here costs a failed transaction, not
//! funds.
//!
//! How the engine (packages/exec) is expected to build `route_data` and the
//! remaining accounts:
//!   1. GET https://quote-api.jup.ag/v6/quote?inputMint=..&outputMint=..&amount=..&slippageBps=..
//!   2. POST https://quote-api.jup.ag/v6/swap-instructions with
//!        userPublicKey = <vault PDA>, useSharedAccounts = true,
//!        wrapAndUnwrapSol = false  (the vault handles WSOL itself),
//!        destinationTokenAccount = <vault's token or WSOL ATA>.
//!   3. Take `swapInstruction` from the response: its `data` is `route_data`,
//!      its `accounts` become remaining_accounts[1..] in the same order, and
//!      remaining_accounts[0] is the Jupiter program id. `addressLookupTableAddresses`
//!      must be attached to the outer v0 transaction.
//!   4. The vault's WSOL lives in a scratch PDA (seeds ["wsol", vault]), not in
//!      the vault's WSOL ATA that Jupiter's API assumes. The engine must
//!      overwrite the WSOL-side account in the returned instruction (the source
//!      account on a buy, the destination account on a sell) with that PDA.
//!      Jupiter only requires the account to be owned by `user_transfer_authority`.
//!   5. `setupInstructions` / `cleanupInstruction` are NOT needed and must not
//!      be sent: the vault owns both token accounts already.
//!
//! Account layout of the two entrypoints we accept (Jupiter v6 IDL, program
//! JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4):
//!
//! `shared_accounts_route` (discriminator c1209b3341d69c81)
//!   0  token_program
//!   1  program_authority
//!   2  user_transfer_authority      signer   -> MUST be the vault PDA
//!   3  source_token_account         writable -> MUST be the vault's source ATA
//!   4  program_source_token_account writable
//!   5  program_destination_token_account writable
//!   6  destination_token_account    writable -> MUST be the vault's destination ATA
//!   7  source_mint
//!   8  destination_mint
//!   9  platform_fee_account         (optional, Jupiter passes program id when absent)
//!   10 token_2022_program           (optional)
//!   11 event_authority
//!   12 program
//!   13.. route accounts (pools, vaults, oracles ...)
//!   args: id u8, route_plan Vec<RoutePlanStep>, in_amount u64, quoted_out_amount u64,
//!         slippage_bps u16, platform_fee_bps u8
//!
//! `route` (discriminator e517cb977ae3ad2a)
//!   0  token_program
//!   1  user_transfer_authority      signer   -> MUST be the vault PDA
//!   2  user_source_token_account    writable -> MUST be the vault's source ATA
//!   3  user_destination_token_account writable -> MUST be the vault's destination ATA
//!   4  destination_token_account    (optional)
//!   5  destination_mint
//!   6  platform_fee_account         (optional)
//!   7  event_authority
//!   8  program
//!   9.. route accounts
//!   args: route_plan Vec<RoutePlanStep>, in_amount u64, quoted_out_amount u64,
//!         slippage_bps u16, platform_fee_bps u8
//!
//! TODO before mainnet (see README "Finishing the Jupiter adapter"):
//!   - run against devnet/mainnet-fork and confirm the indices above
//!   - decode `in_amount` from `route_data` and require it == amount_in
//!     (needs the RoutePlanStep borsh layout; today the balance delta covers it)
//!   - decide whether `platform_fee_account` may be non-default (we say no)

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke_signed;

use super::{vault_only_metas, SwapLegs};
use crate::constants::{JUPITER_V6_PROGRAM_ID, JUP_ROUTE_DISC, JUP_SHARED_ACCOUNTS_ROUTE_DISC};
use crate::errors::VaultError;

pub fn program_id() -> Pubkey {
    Pubkey::new_from_array(JUPITER_V6_PROGRAM_ID)
}

pub fn is_jupiter(key: &Pubkey) -> bool {
    key.to_bytes() == JUPITER_V6_PROGRAM_ID
}

/// Validate the route's account positions against the vault's legs and invoke.
pub fn invoke<'info>(
    swap_program: &AccountInfo<'info>,
    route_accounts: &[AccountInfo<'info>],
    route_data: &[u8],
    legs: &SwapLegs,
    vault_seeds: &[&[u8]],
) -> Result<()> {
    require!(
        is_jupiter(&swap_program.key()),
        VaultError::ProgramNotAllowed
    );
    require!(route_data.len() >= 8, VaultError::InvalidSwapInstruction);

    let mut disc = [0u8; 8];
    disc.copy_from_slice(&route_data[..8]);
    let (idx_authority, idx_source, idx_destination) = if disc == JUP_SHARED_ACCOUNTS_ROUTE_DISC {
        (2usize, 3usize, 6usize)
    } else if disc == JUP_ROUTE_DISC {
        (1usize, 2usize, 3usize)
    } else {
        return err!(VaultError::InvalidSwapInstruction);
    };

    require!(
        route_accounts.len() > idx_destination,
        VaultError::InvalidSwapInstruction
    );
    require_keys_eq!(
        route_accounts[idx_authority].key(),
        legs.vault,
        VaultError::InvalidSwapInstruction
    );
    require_keys_eq!(
        route_accounts[idx_source].key(),
        legs.source,
        VaultError::InvalidSwapInstruction
    );
    require_keys_eq!(
        route_accounts[idx_destination].key(),
        legs.destination,
        VaultError::InvalidSwapInstruction
    );

    // The vault's two legs must be the only vault-owned token accounts in the
    // route: Jupiter must not be handed a third account the vault PDA signs for.
    for (i, acc) in route_accounts.iter().enumerate() {
        if i == idx_source || i == idx_destination {
            continue;
        }
        require!(
            acc.key() != legs.source && acc.key() != legs.destination,
            VaultError::InvalidSwapInstruction
        );
    }

    let ix = Instruction {
        program_id: swap_program.key(),
        accounts: vault_only_metas(route_accounts, &legs.vault),
        data: route_data.to_vec(),
    };
    invoke_signed(&ix, route_accounts, &[vault_seeds]).map_err(Into::into)
}
