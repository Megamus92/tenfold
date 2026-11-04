//! Time constants and hard limits.
//!
//! With `--features testing` every "day" becomes 10 seconds so the mocha
//! suite can exercise the rolling window, the 48h cap raise and the 7 day
//! admin timelock by literally waiting. A mainnet artifact must NEVER be built
//! with that feature; the README build section repeats this.

/// One day in seconds (10 s under `testing`).
#[cfg(not(feature = "testing"))]
pub const DAY_SECS: i64 = 86_400;
#[cfg(feature = "testing")]
pub const DAY_SECS: i64 = 10;

/// Rolling sell-cap window.
pub const CAP_WINDOW_SECS: i64 = DAY_SECS;
/// Delay before a cap raise takes effect.
pub const CAP_RAISE_DELAY_SECS: i64 = 2 * DAY_SECS;
/// Delay before any admin change (fees, allowlist) takes effect.
pub const ADMIN_TIMELOCK_SECS: i64 = 7 * DAY_SECS;

/// The only two withdrawal delays a founder may pick.
pub const WITHDRAWAL_DELAY_ONE_DAY: u32 = DAY_SECS as u32;
pub const WITHDRAWAL_DELAY_TWO_DAYS: u32 = 2 * DAY_SECS as u32;

pub const BPS_DENOMINATOR: u64 = 10_000;

/// Hard ceilings the admin can never exceed, even through the timelock.
/// They are part of the trust promise to founders.
pub const MAX_FEE_VOLUME_BPS: u16 = 100; // 1%
pub const MAX_FEE_CASHOUT_BPS: u16 = 500; // 5%
pub const MAX_REFERRAL_SHARE_BPS: u16 = 5_000; // 50% of the fee
pub const MAX_DAILY_SELL_CAP_BPS: u16 = 10_000;

/// Maximum number of allowlisted swap / LP programs.
pub const MAX_ALLOWLIST: usize = 8;

/// PDA seeds.
pub const VAULT_SEED: &[u8] = b"vault";
pub const SOL_VAULT_SEED: &[u8] = b"sol";
/// Scratch WSOL token account, exists only for the duration of one `delegate_swap`.
pub const WSOL_SEED: &[u8] = b"wsol";
pub const CONFIG_SEED: &[u8] = b"config";
pub const ALLOWLIST_SEED: &[u8] = b"allowlist";

/// Reason codes carried by `SwapExecuted.reason`. Mirrors `ReasonCode` in
/// packages/core/src/types.ts so the proof page can decode events directly.
pub const REASON_DEF: u8 = 0;
pub const REASON_DIST: u8 = 1;
pub const REASON_REB: u8 = 2;
pub const REASON_LP: u8 = 3;
pub const REASON_MANUAL: u8 = 4;
pub const REASON_MAX: u8 = REASON_MANUAL;

/// Jupiter v6 program id (JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4), as bytes so
/// the constant needs no runtime base58 decoding.
pub const JUPITER_V6_PROGRAM_ID: [u8; 32] = [
    4, 121, 213, 91, 242, 49, 192, 110, 238, 116, 197, 110, 206, 104, 21, 7, 253, 177, 178, 222,
    163, 244, 142, 81, 2, 177, 205, 162, 86, 188, 19, 143,
];

/// Meteora DLMM program id (LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo).
pub const METEORA_DLMM_PROGRAM_ID: [u8; 32] = [
    4, 233, 225, 47, 188, 132, 232, 38, 201, 50, 204, 233, 226, 100, 12, 206, 21, 89, 12, 28, 98,
    115, 176, 146, 87, 8, 186, 59, 133, 32, 176, 188,
];

/// Anchor discriminators of the two Jupiter v6 swap entrypoints we relay:
/// sha256("global:shared_accounts_route")[..8] and sha256("global:route")[..8].
pub const JUP_SHARED_ACCOUNTS_ROUTE_DISC: [u8; 8] =
    [0xc1, 0x20, 0x9b, 0x33, 0x41, 0xd6, 0x9c, 0x81];
pub const JUP_ROUTE_DISC: [u8; 8] = [0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a];
