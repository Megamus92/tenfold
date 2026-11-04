//! One file per instruction. Each file owns its `#[derive(Accounts)]` struct
//! and a `handler`. The glob re-exports are required: Anchor's `#[program]`
//! macro resolves the generated `__client_accounts_*` modules from the crate
//! root, and they live next to the structs. The `handler` names collide
//! across files, which is why the lint below is silenced; lib.rs always calls
//! them fully qualified.

#![allow(ambiguous_glob_reexports)]

pub mod admin_allowlist;
pub mod admin_fees;
pub mod apply_raise_cap;
pub mod cancel_withdraw;
pub mod delegate_swap;
pub mod deposit_sol;
pub mod deposit_tokens;
pub mod init_config;
pub mod init_vault;
pub mod lower_cap;
pub mod pause;
pub mod place_lp_asks;
pub mod request_raise_cap;
pub mod request_withdraw;
pub mod set_defense_budget;
pub mod set_withdrawal_delay;
pub mod settle_withdraw;
pub mod unpause;

pub use admin_allowlist::*;
pub use admin_fees::*;
pub use apply_raise_cap::*;
pub use delegate_swap::*;
pub use deposit_sol::*;
pub use deposit_tokens::*;
pub use init_config::*;
pub use init_vault::*;
pub use lower_cap::*;
pub use pause::*;
pub use place_lp_asks::*;
pub use request_withdraw::*;
pub use settle_withdraw::*;
