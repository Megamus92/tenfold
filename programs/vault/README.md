# Tenfold vault program (`tenfold_vault`)

On-chain guard rails that make the "Managed by Tenfold" badge verifiable. A founder
parks project tokens and SOL in a PDA. Tenfold's trading key (the *delegate*) can
only use them within a rolling 24h sell cap, a defense budget and a venue
allowlist. The founder can only take funds out through a public 24h/48h delay,
and only to their own wallet. The Tenfold admin can pause trading but can never
move funds or block an exit.

This directory is a **standalone Anchor workspace** (it is not part of the npm
workspaces at the repo root). Program id placeholder:
`ZeuPBsa2uZjspXRs3VgqjTtaBwW9CU6ZPyVzeyrZTNo`.

## Status

Written for Anchor 0.30.1 / anchor-spl 0.30.1. The Solana/Anchor toolchain was
not available where this was written, so **`anchor build` has not been run**.
What has been verified:

- `cargo check -p tenfold_vault` (host, real anchor-lang 0.30.1) passes with the
  default feature set and with `--features testing`.
- `--features idl-build` compiles and anchor's IDL print test generates the IDL
  (22 instructions, 3 account types).
- `cargo test -p tenfold_vault --lib` (host unit tests for the fee math) passes.

Not verified: the SBF build itself, the on-chain behaviour, and the TypeScript
test suite (never executed). Expect at most minor fixes.

## Build and test

```bash
cd programs/vault
yarn            # or npm install
anchor keys sync   # first time: rewrites declare_id!/Anchor.toml to your deploy key
anchor build
anchor test        # production-flag build: time-dependent and Memo-venue tests are skipped
```

Full suite (one "day" = 10 s, Memo accepted as a no-op venue, the suite waits
10 s / 20 s / 70 s where needed):

```bash
TENFOLD_TEST_CLOCK=1 anchor test -- --features testing
```

**Never ship a mainnet artifact built with `--features testing`.** The feature
shrinks every time constant and lets the delegate route through any
allowlisted program without an adapter.

Tests live in `tests/tenfold_vault.ts`. Cases tagged `[CLOCK]` need the
shortened clock; cases tagged `[MEMO]` need the Memo passthrough. Both are
gated on `TENFOLD_TEST_CLOCK=1`. Bankrun/warp are not used because the handlers
read `Clock::unix_timestamp`, which `--warp-slot` does not move.

## Layout

```
programs/vault/
  Anchor.toml, Cargo.toml (workspace), package.json, tsconfig.json
  programs/tenfold_vault/src/
    lib.rs             thin dispatcher only
    state.rs           Config, Allowlist, Vault + helpers (window, cap, budget)
    errors.rs          VaultError
    events.rs          all emitted events
    constants.rs       seeds, time constants, fee ceilings, program ids
    math.rs            checked arithmetic, bps, fee split
    sol.rs             lamport PDA + scratch WSOL plumbing
    tokens.rs          vault-signed SPL transfers
    adapters/          jupiter.rs (stub), dlmm.rs (stub), passthrough.rs (test only)
    instructions/      one file per instruction
  tests/tenfold_vault.ts
  README.md, AUDIT-PREP.md
```

## Accounts

### `Config` (PDA, seeds `["config"]`, one per deployment)

| field | type | notes |
|---|---|---|
| admin | Pubkey | Tenfold multisig. Pause, propose fee/allowlist changes. Cannot move funds. |
| fees | FeeSchedule | `fee_volume_bps` (<= 100), `fee_cashout_bps` (<= 500), `referral_share_bps` (<= 5000), `fee_recipient` |
| pending_fee_change | Option<{schedule, apply_at}> | 7 day timelock |
| bump | u8 | |

### `Allowlist` (PDA, seeds `["allowlist"]`, one per deployment)

| field | type | notes |
|---|---|---|
| programs | Vec<Pubkey> (max 8) | programs the delegate may CPI into |
| pending | Option<{programs, apply_at}> | 7 day timelock, full replacement |
| bump | u8 | |

### `Vault` (PDA, seeds `["vault", mint, owner]`, one per project)

| field | type | notes |
|---|---|---|
| owner | Pubkey | founder; only key that can withdraw, only to itself |
| mint | Pubkey | project token |
| token_vault | Pubkey | ATA(mint, authority = vault) |
| sol_vault | Pubkey | system PDA `["sol", vault]`, holds all lamports; `Rent::minimum_balance(0)` is a non-spendable reserve |
| delegate | Pubkey | Tenfold trading key |
| admin | Pubkey | snapshot of Config.admin at init (informational; checks use Config.admin) |
| fee_recipient | Pubkey | snapshot at init (informational; payouts go to Config.fees.fee_recipient) |
| referrer | Option<Pubkey> | |
| daily_sell_cap_bps | u16 | |
| cap_window_start | i64 | fixed (non-sliding) 24h window |
| sold_in_window | u64 | tokens sold or placed as asks in the window |
| pending_cap_raise | Option<{bps, apply_at}> | 48h delay |
| defense_budget_lamports / defense_spent_lamports | u64 | lifetime DEF spend bound |
| withdrawal_delay_secs | u32 | 86400 or 172800 |
| pending_delay_change | Option<{secs, apply_at}> | lowering only, applies after current delay |
| pending_withdrawal | Option<{token_amount, lamports, request_at, settle_after}> | settle time snapshotted at request |
| paused | bool | blocks `delegate_swap` and `place_lp_asks` only |
| referral_share_bps, fee_volume_bps, fee_cashout_bps | u16 | snapshot at init; **act as ceilings**: effective fee = min(vault, Config) |
| bump, sol_vault_bump | u8 | |

Scratch WSOL account: PDA `["wsol", vault]`, created by `init_if_needed` at the
top of `delegate_swap` (rent paid by the delegate) and closed into `sol_vault`
at the bottom (rent refunded to the delegate). It never exists between
transactions.

## Instructions

| instruction | signer | notes |
|---|---|---|
| init_config(params) | admin | once per deployment; initial allowlist, fee schedule |
| init_vault(params) | owner | creates Vault, sol_vault, token ATA; delegate != owner |
| deposit_tokens(amount) / deposit_sol(lamports) | anyone | never blocked by pause |
| lower_cap(bps) | owner | instant, strictly lower, drops pending raise |
| request_raise_cap(bps) | owner | apply_at = now + 48h, replaces previous request |
| apply_raise_cap() | anyone | after apply_at |
| set_defense_budget(lamports) | owner | instant both ways; spent never resets |
| set_withdrawal_delay(secs) | owner | raise instant; lower takes effect after current delay |
| request_withdraw(tokens, lamports) | owner | works while paused; one pending at a time |
| settle_withdraw() | owner | after delay, works while paused, to owner only, settles min(requested, available); cashout fee + referral split in kind |
| cancel_withdraw() | owner | |
| pause() | owner or Config.admin | |
| unpause() | owner | admin cannot restart trading |
| delegate_swap(amount_in, min_out, side, reason, route_data) | delegate | remaining_accounts = [venue program, venue accounts...]; see below |
| place_lp_asks(amount, ix_data) | delegate | counts `amount` against the window at placement; DLMM CPI stubbed |
| propose_fee_change(fees) / apply_fee_change() / cancel_fee_change() | admin / anyone / admin | 7 day timelock, hard ceilings |
| propose_allowlist_change(programs) / apply_allowlist_change() / cancel_allowlist_change() | admin / anyone / admin | 7 day timelock, full replacement, program itself never allowed |

Deviations from the spec sheet, all deliberate:

- `delegate_swap` takes two extra args, `reason: u8` (needed for the DEF budget
  and the event) and `route_data: Vec<u8>` (the venue instruction data).
- Volume fee is always collected in SOL: on a buy from `amount_in` (on top, so
  the venue receives exactly `amount_in`); on a sell from the SOL received.
  Tenfold therefore never holds project tokens from trading fees. Cashout fee is
  in kind (tokens and lamports) because that is what leaves the vault.
- Fee bps in the vault are a ceiling, not the live value: Config changes can only
  lower fees for existing vaults. `fee_recipient` is read live from Config.
- Only DEF buys are budget-bound (as specified). REB/MANUAL buys are bounded by
  `min_out` and the allowlist only; see AUDIT-PREP.md, open question 1.

### `delegate_swap` accounting (final)

Sell: `roll_window(now)`; `cap = (token_balance_before + sold_in_window) * cap_bps / 10000`;
require `sold_in_window + amount_in <= cap`; CPI; require tokens spent `<= amount_in`
and WSOL received `>= min_out`; close scratch WSOL into `sol_vault`; fee on the SOL leg.

Buy: fee = `amount_in * bps / 10000`, require `amount_in + fee <= available`;
if reason == DEF require `defense_spent + amount_in <= budget`; wrap `amount_in`;
CPI; require tokens received `>= min_out` and WSOL not below pre-swap; close
scratch WSOL; pay fee.

Reason codes mirror `packages/core/src/types.ts`: 0 DEF, 1 DIST, 2 REB, 3 LP, 4 MANUAL.

## What is stubbed

1. **Jupiter v6 CPI** (`adapters/jupiter.rs`). The code builds and invokes
   `shared_accounts_route` / `route` after checking that
   `user_transfer_authority` is the vault and the source/destination accounts
   are the vault's two legs. It has never run against the real program. A wrong
   index fails closed (balance-delta checks), it cannot lose funds.
2. **Meteora DLMM CPI** (`adapters/dlmm.rs`). Always errors in production
   builds. `place_lp_asks` accounting is final and tested through the Memo
   passthrough.
3. **Test passthrough** (`adapters/passthrough.rs`, feature `testing` only).

### Finishing the Jupiter adapter

1. Build a swap with `/v6/swap-instructions` for `userPublicKey = vault PDA`,
   `useSharedAccounts = true`, `wrapAndUnwrapSol = false`,
   `destinationTokenAccount = vault token ATA` (buy) or the scratch WSOL PDA (sell).
2. In the returned `swapInstruction`, overwrite the WSOL-side account (source on
   a buy, destination on a sell) with the scratch PDA `["wsol", vault]`; Jupiter
   only requires it to be owned by `user_transfer_authority`.
3. Pass the Jupiter program id as `remaining_accounts[0]` and the instruction's
   accounts in order after it; `data` becomes `route_data`; attach the lookup
   tables to a v0 transaction. Do not send setup/cleanup instructions.
4. Run on a mainnet fork (`solana-test-validator --clone` the Jupiter program
   and a pool) and confirm the indices documented in `jupiter.rs`.
5. Decode `in_amount` from `route_data` and require it equals `amount_in`
   (today the balance delta covers it).

### Finishing the DLMM adapter

1. Add `initialize_position_pda` (owner = vault PDA, seeds `["lp_position", vault]`)
   and `add_liquidity_by_strategy` with a one-sided ask strategy above the
   active bin; validate `user_token_x == token_vault`, `user_token_y == scratch WSOL`,
   `sender == vault`.
2. Add `remove_liquidity` / `claim_fee` paths that land the SOL side in the
   scratch WSOL account and close it into `sol_vault`.
3. Decide whether withdrawn asks credit the window (today: no, conservative).

## Audit scope statement

In scope: `programs/tenfold_vault/src/**` built **without** the `testing` feature
(adapters/passthrough.rs is excluded by cfg). Out of scope: the TypeScript
engine, the Telegram agent, the proof page, Jupiter and Meteora programs
themselves. The two adapters are in scope for account validation and
fail-closed behaviour, not for venue correctness. Fee ceilings and time
constants in `constants.rs` are part of the trust promise and must be reviewed
as such.

## Security checklist

- Signer checks: every privileged instruction uses `Signer` + `has_one`
  (`owner`, `delegate`, `admin`) with custom errors; `pause` checks owner or
  `Config.admin` in the handler.
- PDA seeds: every PDA account carries `seeds` + `bump = <stored bump>`;
  `sol_vault` and the scratch WSOL PDA are derived from the vault key.
- Overflow: `overflow-checks = true` in release; all arithmetic goes through
  `math.rs` (u128 intermediates) or `checked_*`.
- Re-initialization: `init` on Config, Allowlist, Vault and the token ATA;
  `init_if_needed` only on the owner's ATA (settle) and the scratch WSOL PDA,
  both re-validated by `associated_token::` / `token::` constraints.
- Close accounts: the only close is the scratch WSOL account, authority = vault,
  destination = sol_vault, inside the same instruction that created it.
- CPI account validation: venue program must be allowlisted and executable;
  `vault_only_metas` forwards the vault as the only signer; Jupiter adapter
  checks authority/source/destination positions and that no other vault-owned
  account is in the route; outcomes are verified by balance deltas.
- Rent: `sol_vault` keeps `minimum_balance(0)`; `available_lamports` subtracts it everywhere.
- Fee rounding: floors in favour of the vault; referral floored, Tenfold takes the remainder.
- Hard ceilings: volume 1 %, cashout 5 %, referral share 50 %, cap 100 %, allowlist 8.
- Events on every state change for the proof page.

## Deploying

1. `anchor keys sync`, `anchor build`, `anchor deploy --provider.cluster devnet`.
2. `init_config` signed by the admin multisig with the production fee schedule
   and `allowlist = [Jupiter v6]`.
3. Transfer the upgrade authority to the multisig (or revoke it after audit).
