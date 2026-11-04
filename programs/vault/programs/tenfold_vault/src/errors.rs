use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    // --- spec errors ---------------------------------------------------------
    #[msg("Vault is paused")]
    Paused,
    #[msg("Rolling 24h sell cap exceeded")]
    CapExceeded,
    #[msg("Defense budget exceeded")]
    BudgetExceeded,
    #[msg("Timelock has not elapsed yet")]
    NotYetDue,
    #[msg("Signer is not the vault owner")]
    NotOwner,
    #[msg("Signer is not the vault delegate")]
    NotDelegate,
    #[msg("Signer is not the admin")]
    NotAdmin,
    #[msg("Program is not on the allowlist")]
    ProgramNotAllowed,
    #[msg("Amount must be greater than zero and within balance")]
    InvalidAmount,
    #[msg("A withdrawal is already pending")]
    WithdrawalPending,
    #[msg("Nothing is pending")]
    NothingPending,
    #[msg("Withdrawal delay must be 24h or 48h")]
    DelayTooShort,

    // --- additional errors ---------------------------------------------------
    #[msg("Swap returned less than min_out")]
    SlippageExceeded,
    #[msg("Swap consumed more input than declared")]
    SourceOverspent,
    #[msg("Cap must be between 1 and 10000 bps")]
    InvalidCap,
    #[msg("lower_cap requires a strictly lower cap")]
    CapNotLower,
    #[msg("request_raise_cap requires a strictly higher cap")]
    CapNotHigher,
    #[msg("Fee exceeds the hard-coded ceiling")]
    InvalidFee,
    #[msg("Unknown reason code")]
    InvalidReason,
    #[msg("Mint does not match the swap side")]
    InvalidMint,
    #[msg("Token account owner or mint mismatch")]
    InvalidTokenAccount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Allowlist is full")]
    AllowlistFull,
    #[msg("Instruction data or account layout rejected by the adapter")]
    InvalidSwapInstruction,
    #[msg("Vault is not paused")]
    NotPaused,
    #[msg("Vault is already paused")]
    AlreadyPaused,
    #[msg("Signer is neither the owner nor the admin")]
    NotOwnerOrAdmin,
    #[msg("Referrer token account required when a referrer is set")]
    MissingReferrerAccount,
    #[msg("Swap program account must be executable")]
    NotExecutable,
}
