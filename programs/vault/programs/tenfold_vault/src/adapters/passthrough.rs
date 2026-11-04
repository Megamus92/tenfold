//! TEST ONLY (feature `testing`). Forwards the instruction verbatim to any
//! allowlisted program so the accounting paths of `delegate_swap` and
//! `place_lp_asks` can be exercised on a local validator without Jupiter or
//! Meteora. The tests allowlist the SPL Memo program and send it a memo, which
//! moves no tokens: `amount_out` is then 0 and `min_out` must be 0.
//!
//! This module is not compiled into a normal `anchor build`.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke_signed;

use super::vault_only_metas;

pub fn invoke<'info>(
    program: &AccountInfo<'info>,
    accounts: &[AccountInfo<'info>],
    data: &[u8],
    vault: &Pubkey,
    vault_seeds: &[&[u8]],
) -> Result<()> {
    let ix = Instruction {
        program_id: program.key(),
        accounts: vault_only_metas(accounts, vault),
        data: data.to_vec(),
    };
    invoke_signed(&ix, accounts, &[vault_seeds]).map_err(Into::into)
}
