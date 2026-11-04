//! Checked arithmetic helpers. Every multiplication goes through u128 so a
//! `u64 * bps` can never overflow; every result is checked back into u64.

use anchor_lang::prelude::*;

use crate::constants::BPS_DENOMINATOR;
use crate::errors::VaultError;

#[inline]
pub fn checked_add_u64(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .ok_or_else(|| error!(VaultError::MathOverflow))
}

#[inline]
pub fn checked_sub_u64(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b)
        .ok_or_else(|| error!(VaultError::MathOverflow))
}

#[inline]
pub fn checked_add_i64(a: i64, b: i64) -> Result<i64> {
    a.checked_add(b)
        .ok_or_else(|| error!(VaultError::MathOverflow))
}

/// floor(amount * bps / 10_000). Rounds DOWN, i.e. in favour of the vault:
/// fees are never over-collected by rounding.
pub fn bps_of(amount: u64, bps: u16) -> Result<u64> {
    let v = (amount as u128)
        .checked_mul(bps as u128)
        .ok_or_else(|| error!(VaultError::MathOverflow))?
        / (BPS_DENOMINATOR as u128);
    u64::try_from(v).map_err(|_| error!(VaultError::MathOverflow))
}

/// Split a gross fee into (tenfold_part, referral_part). The referral part is
/// floored, Tenfold takes the remainder, so the two always sum to `fee`.
pub fn split_fee(fee: u64, referral_share_bps: u16, has_referrer: bool) -> Result<(u64, u64)> {
    if !has_referrer || fee == 0 {
        return Ok((fee, 0));
    }
    let referral = bps_of(fee, referral_share_bps)?;
    let tenfold = checked_sub_u64(fee, referral)?;
    Ok((tenfold, referral))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bps_rounds_down() {
        assert_eq!(bps_of(10_000, 50).unwrap(), 50);
        assert_eq!(bps_of(199, 50).unwrap(), 0);
        assert_eq!(bps_of(u64::MAX, 10_000).unwrap(), u64::MAX);
    }

    #[test]
    fn split_sums() {
        let (z, r) = split_fee(1_001, 2_500, true).unwrap();
        assert_eq!(z + r, 1_001);
        assert_eq!(r, 250);
        assert_eq!(split_fee(1_001, 2_500, false).unwrap(), (1_001, 0));
    }
}
