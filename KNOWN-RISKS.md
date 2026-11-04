# Tenfold, known risks and hardening status

Honest status for the beta, after two independent code reviews and the fixes applied. Read it before any real money touches a vault.

## What the system is now

| Surface | What it does |
| --- | --- |
| engine | Trades per project (DEF/DIST/REB), accrues the volume fee, and runs a maintenance loop: hourly badge/coverage check, a daily on-chain hash of the trade log, fee sweeps. Single-instance locked. |
| agent | Telegram control (Claude tool-use) with confirmations, a per-user allowlist for groups, bind codes, and marketing-post approval. Never holds a key. |
| proof | Public page + /verify: tier, supply coverage, insider sells, fees, on-chain log anchors. |
| coverage | Computes the badge tier and the supply-coverage picture from the chain. |
| trader-bot | Public bot: send a mint, get the badge status. Read-only. |
| marketing | Posts to X/Telegram from ledger facts only; no hype, no price calls; downgrades are posted. |
| onboard | Web onboarding: connect wallet, sign, create the vault wallet, declare team wallets, get the deposit QR. |
| programs/vault | Anchor program (22 instructions); compiles; CPIs stubbed; not yet built/audited. |

## Fixed (verified with tests)

- Cap/budget integrity: a lost-confirmation swap stays counted (no re-sell of the same allowance); in-flight DEF buys consume the budget; the cap base no longer double-counts pending sells; every RPC call has a 30 s deadline.
- Single-engine lock, released on exit, reclaimed only if the holder process is gone.
- Telegram bind code required to claim a project; per-user allowlist for group chats (control and confirmations).
- Defense stops chasing a level more than a set distance below it (default 15%); rebalance is bounded by one clip and rejects a zero band.
- Live fills reconcile their real in/out amounts from the chain (pre/post balances), not the quote.
- Keystore (AES-256-GCM, scrypt, pubkey AAD) is read only by the engine and the onboarding app; agent, proof, marketing and trader-bot import nothing from the signing package. Agent and proof containers get neither the keys dir nor the password.
- Fee safety: accrual writes only the fee table and never touches the balances strategies see; `computeFee` clamps env-driven bps so a bad `TENFOLD_REFERRAL_BPS` can't make the referral exceed the fee or the net go negative; a sweep moves exactly the accrued net + referral of the captured rows; it is skipped in paper mode and without a fee wallet; `markFeesSwept` is atomic; a two-phase reserve (accrued → sweeping → swept) means a crash mid-sweep parks the rows instead of paying them twice; a lost-confirmation transfer marks swept (reconcile from the event), a sure failure is released for retry.
- Marketing: `TENFOLD_MARKETING_ALLOW_PAPER` is ignored outside a dry run, so simulated numbers never reach real channels; posts are templates over ledger numbers; milestones need a real crossed threshold; downgrades bypass rate limits.
- Coverage: `gold` is impossible without `mode:live` AND an on-chain vault (today the max tier is `beta`); any insider sell in 30 days forces `flagged`; the check can't crash the engine loop.

## The desk manager (autonomy)

- The desk's decisions are engine rules, not a model: `apps/engine/src/desk.ts` is deterministic and unit-tested, and every order it causes still passes the risk engine. It cannot exceed the founder's cap, budgets or floor.
- In a volatile market the desk WILL spend the daily defense limit most days: the levels sit 1.5 realized sigmas under the price and get hit. `maxDefenseSpendPerDaySol` is therefore the number to size with the founder, not the lifetime budget.
- Trend protection rests the defense after 2 lost levels in 24h (6h, doubling per further loss). A slow bleed that loses one level a day is not caught by it; the daily limit is the bound.
- Flows and the pool liquidity reading come from DexScreener. If it is down, flows read 0: distribution's strength signal never fires (fail-safe, nothing sells) and the liquidity-pull stop cannot see a drain (the impact estimate from Jupiter remains, refreshed every minute).
- `ask` mode announces proposals only; applying them goes through the normal confirmed tools.
- The desk writes the project file (strategy + mandate bookkeeping) after re-reading it, so an agent edit saved a moment earlier is kept; a founder edit landing in the same second could still be overwritten by the desk's write. Low likelihood, worth a file lock before many projects run.

## The core beta caveat

The daily cap, the defense budget and the withdrawal delay are enforced by the engine, not yet on-chain. Until `programs/vault` is built, deployed and audited, a founder trusts Tenfold's process, not a contract. Beta vaults stay small (under 100 SOL and 5% of supply) and start with our own launches. The badge reads `beta` until the audited vault is live; keep it that way.

## Before real funds (ranked)

- HIGH: the onboarding app holds `TENFOLD_KEYSTORE_PASSWORD` and writes to the engine's keystore dir. A compromised internet-facing onboard process exposes every key's password. For the beta, onboard projects with the CLI (`wallet:new` + `project:add`) on the engine host, or run onboard with its own keystore dir/password and move the keys over out of band. Do not expose onboard publicly until wallet creation is moved into the engine. Its compose service publishes no port by default.
- HIGH: no automatic fee-sweep trigger exists; keep sweeps operator-initiated (enqueue a `sweep_fees` command) and reconcile any row left in `sweeping` after a crash before re-sweeping.
- MEDIUM: manual orders from Telegram skip the 5-minute opposite-side cooldown and the no-sell-into-own-defense zone; the LLM prompt is the only guard. Add those guards to the manual path before letting founders place manual orders on live projects.
- MEDIUM: onboarding uses the same signed message for login and for team-wallet declaration, so a collected teammate signature could be replayed to log in as that wallet. Give declarations a distinct message prefix (client + server) before onboard handles anyone but us.
- MEDIUM: the marketing hype-word guard ignores the project name and handle, so a project named "BUY NOW 100x" would still post. Screen the name/handle at onboarding.
- MEDIUM: in `approve` marketing mode a badge downgrade is only a draft the founder can let expire; run badge posts in `auto` mode (or post downgrades yourself) so they can't be suppressed.
- MEDIUM: per-level defense budgets are tracked over a rolling 24h while the agent presents them as fixed allocations; only the lifetime budget is a hard bound. Make level budgets daily or lifetime.
- MEDIUM: the priority-fee cap (default ~15,000 lamports) is low; raise `TENFOLD_PRIORITY_FEE_MICROLAMPORTS` for busy tokens or live swaps will expire.
- LOW: no reconciler for orders stuck `approved`/`sent` after a crash; coverage freezes at its last tier on a reader failure (never falsely downgrades, but can go stale); `unsweptFees` blocks a project's sweep once any paper row exists (a paper→live project needs its paper fee rows cleared); onboarding sessions are in memory with no per-IP rate limit; a Telegram API error body can embed the bot token in a stored post error; the proof pill still reads "Managed by Tenfold" for beta projects (the `beta` tier shows beside it) — reword the pill to say beta.

## Phase 2: the on-chain vault

`programs/vault` moves the cap, budget, withdrawal delay, fee split and program allowlist on-chain. Finish the Jupiter and Meteora CPIs (stubbed), build with the Solana/Anchor toolchain, test on a local validator, and audit. The audit covers this program only. Until then, everything above about "enforced off-chain" applies, and the badge stays `beta`.
