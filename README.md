# Tenfold, AI market maker for Solana tokens (tenfold.trade)

Self-serve market maker: the founder deposits tokens and SOL in a project wallet, Tenfold defends levels, distributes supply within a daily cap and rebalances inventory. The founder talks to it on Telegram. Everything Tenfold does is written to a ledger and shown on a public proof page.

What Tenfold never does: trade against itself, print volume, hide holdings, fake engagement. Every order carries a reason code (DEF, DIST, REB, LP, MANUAL) and passes the risk engine (daily cap, defense budget, pace, slippage, circuit breaker).

## The mandate and the desk manager

A founder does not set levels. He gives a mandate (three answers) and the desk manager inside the engine does the rest:

| The founder says | The desk does |
| --- | --- |
| profile: `protect`, `balanced` or `distribute` | places 1 or 2 trailing defense levels under the 1h reference price (wider in a volatile market), re-places a lost level lower, lets a level breathe when holding it would burn the day's budget, rests the defense 6/12/24 h after 2/3/4 levels lost in a day |
| share and horizon: "50% of the vault over 60 days" | sets the daily distribution pace (never above the daily sell cap), catches up when behind, slows down when ahead, halves it when sellers dominate the hour, stops it after a team wallet sold |
| alert floor (optional) | halves distribution under it and says so once |
| autonomy: `auto` (default) or `ask` | applies decisions and announces them in one line ("Desk: ..."), or proposes and waits |

It escalates only what it cannot decide: defense budget used up, no SOL in the wallet, a horizon the cap cannot reach, a liquidity pull (everything paused), a team wallet selling, the target reached. Levels the founder sets himself through the agent are pinned and never touched. `apps/engine/src/desk.ts` is pure and tested (`desk.test.ts`); the runner applies its output every 15 minutes or at once when a detector fires.

On Telegram the mandate is two taps (`/mandate`): profile, then share and horizon. The alert line is one typed sentence ("tell me under 0.00012").

## Layout

| Part | Path | Runs as |
| --- | --- | --- |
| Core types, config, SQLite ledger, risk engine | `packages/core` | library |
| Market data, Jupiter execution, paper executor, encrypted keystore | `packages/exec` | library (engine only) |
| Strategies (DEF, DIST, REB) and detectors | `packages/strategies` | library |
| Engine: one runner per project, ticks every 10 s | `apps/engine` | process |
| Telegram agent: Claude with bounded tools, confirmations, alerts | `apps/agent` | process (no key access) |
| Proof page and verify API | `apps/proof` | process, port 8787 |
| Marketing: fact-based posts to X and Telegram channels, founder approval | `apps/marketing` | process (no key access) |
| Web onboarding: wallet sign-in, 4-step form, creates wallet + project + bind code | `apps/onboard` | process, port 8788 (encrypts keys, never decrypts) |
| Badge tiers, hourly supply coverage check, insider sell watch | `packages/coverage` | library |
| Public trader bot: paste a mint, get the badge and the proof link | `apps/trader-bot` | process (read-only on the ledger) |
| On-chain vault program (Anchor), phase 2 | `programs/vault` | build on a machine with the Solana toolchain |

The three processes share one SQLite file (`data/tenfold.sqlite`). The agent never signs anything: it writes commands to the ledger and edits the project JSON; the engine applies them.

## Beta runbook (2 days)

Requirements: Node 22.13 or newer, a Telegram bot token (@BotFather), an Anthropic API key, a Jupiter API key (free, portal.jup.ag; api.jup.ag throttles keyless calls), a dedicated RPC URL (Helius) for live mode. Production runbook: `DEPLOY.md`.

```bash
cp .env.example .env            # fill TENFOLD_KEYSTORE_PASSWORD, TENFOLD_TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, TENFOLD_RPC_URL, TENFOLD_JUPITER_API_KEY
npm ci
npm run build
npm test
```

### Day 1: paper mode on a real token

```bash
# 1. a wallet for the project (encrypted in data/keys, only the engine can read it)
npm run wallet:new -- --label mytoken          # prints the public key

# 2. the project file (paper mode: real prices, simulated fills). Prints a bind code at the end: keep it.
#    With --mandate the desk manager places the levels and sets the pace itself (recommended).
npm run project:add -- --id mytoken --name "My Token" --mint <MINT> --decimals 6 \
  --wallet <PUBKEY_FROM_STEP_1> --mode paper \
  --cap 0.5 --budget 20 --budget-day 5 --delay 24 \
  --mandate balanced --horizon-days 60 --distribute-pct 50 --alert-floor 0.00012
#    Manual alternative (no desk): --level 0.00020:10 --dist 0.3:strength --min-price 0.00012 --strength-boost 3

# 3. start the processes. ONE engine only (it takes an exclusive lock on the ledger); agent and proof alongside.
npm run engine
npm run agent
npm run proof                                  # http://localhost:8787/p/mytoken
npm run trader-bot                             # public lookup bot, needs TENFOLD_TRADER_BOT_TOKEN (a second bot from @BotFather)

# 4. bind the Telegram chat from a PRIVATE chat with the founder, using the bind code printed in step 2:
#    /start mytoken <bindCode>
#    then talk to it: "status", "defend 0.0002 with 10 SOL", "what does it cost to hold here?",
#    "sell harder when it pumps" (raises the strength boost, within the cap, after you confirm).
```

Read `KNOWN-RISKS.md` before any real money: it lists what is enforced off-chain until the vault program ships, and the group-chat and manual-order caveats.

### Web onboarding instead of the CLI

Steps 1 and 2 above have a web version for founders:

```bash
npm run onboard                                # http://localhost:8788 (TENFOLD_ONBOARD_PORT), needs TENFOLD_KEYSTORE_PASSWORD
```

The founder connects a Phantom-compatible wallet and signs one message (challenge from `GET /api/challenge`, verified with node:crypto, one-hour session). The four steps are: project (name, id, mint, decimals, paper/live, referral), rules and strategy (daily sell cap, defense budget, withdrawal delay, slippage, levels, distribution with strength boost, rebalance, clip), team wallets (the connected wallet is declared and signed automatically; more wallets can be added unsigned or signed from that wallet) and marketing, with the fee terms shown read-only. `POST /api/projects` validates with `parseProjectConfig`, creates the execution wallet in the keystore, writes `projects/<id>.json`, registers the project and the declared wallets in the ledger and returns the deposit address (shown with a QR code), the Telegram bind command and the proof URL. The engine picks the new file up within a minute.

In paper mode the engine quotes Jupiter for real prices and simulates fills with modelled impact. Deposit nothing yet; the paper vault starts with the balances the project file implies (zero) so set `TENFOLD_SIM=1` for a fully simulated run, or fund the wallet with a small real amount so balances are real while fills stay simulated.

### Day 2: live, small size, our own token first

1. Fund the project wallet with the tokens and SOL you want Tenfold to manage.
2. Edit `projects/mytoken.json`: `"mode": "live"`, cap and budget as agreed with the founder (for the beta keep the vault under 100 SOL and 5% of supply).
3. Send `/pause` on Telegram, restart the engine, then `resume` and confirm.
4. Watch the proof page and the Telegram alerts for the first hour. `pause` is instant from Telegram at any time.

### Backtest a configuration before going live

```bash
node --no-warnings apps/engine/dist/backtest.js mytoken --steps 5000 --seed 42
```

Prints fills by reason, tokens sold versus cap, distribution VWAP versus token VWAP (bps), defense SOL spent, final inventory.

## Safety model in the beta

| Risk | Control |
| --- | --- |
| Engine bug sells too much | Daily cap in the risk engine, counted on filled and pending sells; circuit breaker; pace limit |
| Defense drains the wallet | Lifetime defense budget and per-day defense limit, both from the project file |
| Agent is tricked into a bad command | Agent emits only schema-bound commands; the engine re-checks everything; spending and parameter changes need an inline-button confirmation; pause and lower-cap are instant |
| Key leaks | Keys live in an AES-256-GCM keystore read only by the engine process; the agent process has no access |
| Watcher games the bot | Clip sizes and timing are randomized; levels and sizes are never shown on the proof page |
| Dispute "you rugged us" | Every order, fill, deposit and event is in the ledger with timestamps and tx signatures; the proof page shows the full history |

What the beta does NOT yet enforce on-chain: the cap, the budget and the withdrawal delay are engine rules until the vault program (`programs/vault`) is deployed and audited. The founder is trusting Tenfold's process in the beta, which is why beta vaults stay small and start with our own launches.

## Marketing module

`npm run marketing` is a separate process that reads the shared ledger and writes public updates for each project whose `marketing.mode` is not `off`. It never invents anything: every post is built from ledger rows (fills, events, coverage, anchors), with the project's X handle and a link to its proof page.

| Post | Trigger | What it says |
| --- | --- | --- |
| Daily recap | the engine's `daily_report` event, once a day | fills and SOL volume by reason code, price open to close, sell cap used, LP fees if any, badge, the day's log hash |
| Milestone | lifetime vault volume, days managed, holders (only with a chain provider) crossing a threshold | the number, nothing else |
| Level held | a `level_hit`, then price back 1.5% above the level with real DEF buys behind it | SOL spent, number of buys, duration, the low |
| Withdrawal notice | `withdrawal_requested` / `withdrawal_settled` / `withdrawal_cancelled` events from the vault | amount, delay, settlement time, tx. Skips the rate limit |
| Badge change | `badge_changed` from the coverage checker | from, to, the reasons. Downgrades are posted too and skip the rate limit |

Modes, per project (`set_marketing` from the agent, or `marketing` in the project file): `approve` drafts each post and sends it to the founder's chat with Approve/Reject buttons (also `/posts`, `approve_post`, `reject_post`); `auto` posts without asking; `off` posts nothing. A `tone` string (casual, formal) changes the wording, never the numbers. At most 4 posts per channel per rolling 24h and 30 minutes between posts; unapproved drafts expire after 24h. Paper projects are never posted (simulated fills must not go public) unless `TENFOLD_MARKETING_DRY_RUN=1`, which logs instead of publishing.

Channels: X API v2 (`POST /2/tweets`, OAuth 1.0a with `TENFOLD_X_*`; the Tenfold account posts and mentions the project) and the project's public Telegram channel (`telegramChannelId`, the bot of `TENFOLD_MARKETING_BOT_TOKEN` or the agent bot must be an admin). The module never pays or coordinates callers, never farms engagement; a founder who asks is refused by the agent, with the badge as the reason.

## Phase 2: the on-chain vault

`programs/vault` holds the Anchor program that moves the cap, the budget, the withdrawal delay, the fee split and the program allowlist on-chain so nobody has to trust the engine. Build and test it on a machine with the Solana and Anchor toolchains (`programs/vault/README.md`). The audit covers this program only.

## Development

```bash
npm run typecheck
npm test
TENFOLD_LOG_LEVEL=debug npm run engine
```

Logs are one JSON line per entry. The ledger is a plain SQLite file; `sqlite3 data/tenfold.sqlite` works for inspection.
