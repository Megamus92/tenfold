# Tenfold vault: audit preparation

Companion to README.md. Scope: `programs/tenfold_vault/src/**` built without the
`testing` feature. Fee ceilings and time constants in `constants.rs` are part
of the trust promise.

## Roles

| role | key | can | cannot |
|---|---|---|---|
| owner (founder) | per vault | deposit, lower cap instantly, request raise (48h), set budget, set delay (lower after delay), request/cancel/settle withdrawal to own wallet, pause, unpause | sell outside the cap, withdraw without the delay, withdraw to a third party, change fees, change allowlist |
| delegate (Tenfold trading key) | per vault | swap and place asks within cap, budget, allowlist, `min_out` | withdraw, change any parameter, pause/unpause, route to a non-allowlisted program, sign for any account other than the vault's two legs |
| admin (Tenfold multisig) | Config | pause any vault, propose fee/allowlist changes (7d), cancel its own proposals | move funds, unpause, block a withdrawal, raise fees above the hard ceilings or above a vault's snapshot, shorten any timelock |
| anyone | | deposit, apply a due cap raise, apply a due fee or allowlist change | everything else |

## Threat model

### T1. Delegate key compromise

The attacker holds the Tenfold trading key for one or all vaults. Bound:

- Tokens: at most `cap_bps` of (balance + already sold) per fixed 24h window
  per vault, via `delegate_swap` sells and `place_lp_asks`. Proceeds land in
  `sol_vault`, never in an attacker account (`vault_only_metas`, leg checks).
- SOL: DEF buys bounded by `defense_budget - defense_spent`. Non-DEF buys are
  NOT budget bound; the SOL goes to an allowlisted venue and tokens come back
  to `token_vault`, so the loss is the slippage the attacker can engineer with
  a low `min_out` (see open question 1).
- The attacker cannot withdraw, change parameters, unpause, or add a venue.
- The owner or admin can `pause` immediately; the owner can `lower_cap` to 1 bp
  and `set_defense_budget(0)` immediately.
- Scratch WSOL rent is paid by the delegate and refunded by the vault, so the
  delegate cannot drain `sol_vault` through rent games (refund equals the rent
  paid, from lamports the close just returned).

### T2. Admin key compromise

Bound: trading can be paused on every vault (griefing). Nothing else within 7
days; afterwards fees up to the hard ceilings (1 % volume, 5 % cashout) for
vaults whose snapshot allows it, and a new allowlist. Both changes are
announced by events 7 days ahead. The admin cannot touch `settle_withdraw`,
`request_withdraw` or `cancel_withdraw`, which ignore `paused`. The admin
cannot unpause.

### T3. Malicious or compromised owner

The badge promise to traders is "supply cannot be dumped faster than the cap,
and exits are visible N hours ahead". The owner cannot sell through the vault
at all (only the delegate can, and the owner may not be the delegate), can
only raise the cap with a 48h public delay, and can only shorten the
withdrawal delay after the current delay has elapsed. A withdrawal is public
for the full delay and goes only to the owner wallet. The owner CAN deposit
less, or hold supply outside the vault; the proof page must show the share of
supply inside the vault for the badge to mean anything (off-chain concern).

### T4. Venue (Jupiter / DLMM) misbehaviour or wrong adapter layout

The vault signs only for its two legs. The handler re-reads both token
accounts after the CPI and requires: source spent <= `amount_in`, destination
received >= `min_out`. Any discrepancy aborts the transaction. A wrong index in
the adapter therefore costs a failed transaction, not funds. Solana forbids a
CPI callee from re-entering the caller, so the venue cannot re-enter
`tenfold_vault` (see Reentrancy).

### T5. Cap window manipulation

The window is fixed, not sliding: it resets when `now - cap_window_start >= 24h`
at the next sale. Worst case a delegate sells `cap` at 23:59 of window N and
`cap` again at 00:01 of window N+1, i.e. 2x cap within two minutes. This is
accepted and documented (the proof page shows per-window sells); a sliding
window would need a per-sale ledger. The base is `balance_before + sold_in_window`,
so selling cannot shrink the base mid-window and deposits raise it. Transfers
INTO `token_vault` by a third party raise the cap base; that only increases
what the delegate may sell of tokens the vault actually holds.

### T6. Fee rounding and dust

`bps_of` floors, so fees are never over-collected. The referral share is
floored and Tenfold takes the remainder, so `tenfold + referral == fee` always. A
swap below `10000 / bps` units pays zero fee: acceptable dust.

### T7. Reentrancy

Solana only allows direct self-recursion; a program invoked by `tenfold_vault`
cannot call back into `tenfold_vault`. The allowlist refuses the program's own id
so the delegate cannot construct a self-CPI either. All state mutation happens
before (cap, budget) or after (events) the CPI, with balances re-read from the
accounts after it.

### T8. Griefing via pre-funding PDAs

Anyone can send lamports to `sol_vault` (treated as a deposit) or to the scratch
WSOL PDA address (swept into `sol_vault` at the next swap's close) or tokens to
`token_vault` (raises the cap base, see T5). None of these block any
instruction.

## Invariants an auditor should check

1. Only `settle_withdraw` moves tokens or lamports to a non-vault, non-venue, non-fee account, and only to `vault.owner` / ATA(owner).
2. `settle_withdraw` requires `now >= pending.settle_after`, and `settle_after` was computed from the delay in force at request time.
3. `request_withdraw`, `cancel_withdraw`, `settle_withdraw`, deposits and all cap/budget/delay changes execute regardless of `paused`.
4. `unpause` requires `vault.owner`; no instruction lets `Config.admin` clear `paused`.
5. For every sell path (`delegate_swap` Sell, `place_lp_asks`): after `roll_window`, `sold_in_window + amount <= (balance_before + sold_in_window) * cap_bps / 10000`, and `sold_in_window` is incremented by the declared `amount`.
6. `daily_sell_cap_bps` only increases through `apply_raise_cap` with `now >= apply_at` where `apply_at = request_time + 48h`.
7. `withdrawal_delay_secs` only decreases through a pending change whose `apply_at = now + old_delay`.
8. On a DEF buy, `defense_spent + amount_in <= defense_budget` before the CPI; `defense_spent` never decreases.
9. `remaining_accounts[0]` is in `Allowlist.programs` and executable before any CPI; `Allowlist.programs` never contains `crate::ID` or the default pubkey.
10. In every CPI built by the program, the only `is_signer` meta is the vault PDA, and the vault signs for no token account other than `token_vault` and the scratch WSOL PDA.
11. After the CPI: source delta <= `amount_in` and destination delta >= `min_out`, computed from reloaded balances.
12. The scratch WSOL account is closed in every successful `delegate_swap` and its full lamport balance goes to `sol_vault`; the refund to the delegate is exactly `minimum_balance(TokenAccount::LEN)`.
13. `sol_vault.lamports >= minimum_balance(0)` after every instruction (`available_lamports` reserve).
14. Effective fee bps used in `delegate_swap` / `settle_withdraw` is `min(vault snapshot, Config)`, and `Config` values never exceed the hard ceilings (`FeeSchedule::validate` on propose and on apply).
15. `apply_fee_change` / `apply_allowlist_change` require `now >= apply_at` with `apply_at = proposal_time + 7d`, and apply exactly the proposed values.
16. `init_config` can run once (PDA `init`), and only with the admin as signer.
17. `init_vault` rejects `delegate == owner`, `referrer == owner`, cap outside (0, 10000], delay not in {86400, 172800}.
18. All arithmetic is checked (`math.rs`, `checked_*`, release `overflow-checks`); no `as` cast narrows a value (the only casts widen or are `u32 -> i64` for delays).
19. Every state change emits an event with the resulting values (`sold_in_window`, `defense_spent_lamports`, new caps, fee amounts) so the proof page can be reconciled against chain state.
20. No instruction reads `Clock` more than once per handler (consistent `now`).

## Open questions for the audit / product

1. Should non-DEF buys also be bounded (a per-window SOL spend cap)? Today only
   `min_out` and the allowlist bound them. A compromised delegate could set
   `min_out = 1` and route through a thin pool to extract value as slippage.
   One-line fix: count every buy against `defense_budget`.
2. Should a pending withdrawal reserve its amounts from the delegate? Today
   `settle_withdraw` settles `min(requested, available)` instead.
3. Fixed vs sliding window (T5).
4. Should tokens returned from a reduced DLMM position credit the window?
5. The `Vault.admin` and `Vault.fee_recipient` snapshots are informational;
   live checks use `Config`. Confirm this matches the proof page copy.
