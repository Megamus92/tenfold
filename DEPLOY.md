# Tenfold: beta deployment runbook

One Ubuntu VPS runs everything through `docker-compose.yml`. The engine is the only process that can read the keystore; the agent, proof page, trader bot and marketing module get a blanked password and an empty keys directory. Keep it that way.

## 0. Accounts and keys to have ready

| What | Where | Notes |
| --- | --- | --- |
| Helius API key | helius.dev | Developer plan or above for live mode (staked connections, 50 RPS). Free plan is enough for paper mode. `TENFOLD_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...` |
| Jupiter API key | portal.jup.ag | Free. Required: api.jup.ag throttles keyless calls to ~0.5 req/s and lite-api is deprecated. `TENFOLD_JUPITER_API_KEY` |
| Telegram bot token (founder agent) | @BotFather | One bot for all founders; each founder binds his own private chat. `TENFOLD_TELEGRAM_BOT_TOKEN`. Set the commands list with `/setcommands`: `start`, `help`, `status`, `report`, `pause`, `resume`, `posts`. |
| Telegram bot token (public lookup bot) | @BotFather | Optional in the beta (private product). `TENFOLD_TRADER_BOT_TOKEN` |
| Anthropic API key | console.anthropic.com | `ANTHROPIC_API_KEY`; model `claude-sonnet-5-5` by default (`TENFOLD_ANTHROPIC_MODEL`) |
| Fee wallet | a Solana address you control (hardware wallet or multisig) | `TENFOLD_FEE_WALLET`. Sweeps stay operator-initiated in the beta. |
| Keystore password | generated on the host, stored in a password manager, never in git | `TENFOLD_KEYSTORE_PASSWORD`, 32+ random chars. Losing it means losing access to every project wallet. |
| Proof signing secret | generated | `TENFOLD_PROOF_SIGNING_SECRET`, 32+ random chars |

## 1. Host

- Ubuntu 24.04, 2 vCPU / 4 GB RAM / 40 GB SSD is plenty for a handful of projects. Pick a region close to Helius's EU or US edge (Frankfurt or Ashburn).
- `ufw`: allow 22 (your IP only), 443 if the proof page is exposed behind a reverse proxy. Nothing else inbound. The agent uses Telegram long polling, so it needs no inbound port.
- Install Docker Engine + compose plugin. Create a non-root user in the `docker` group.
- Automatic security updates on. SSH keys only, password login off.

## 2. Install

```bash
git clone <private repo> tenfold && cd tenfold
cp .env.example .env            # fill the keys from the table above
openssl rand -base64 32          # keystore password; paste into TENFOLD_KEYSTORE_PASSWORD and into the password manager
openssl rand -hex 32             # TENFOLD_PROOF_SIGNING_SECRET
chmod 600 .env
mkdir -p data/keys projects && chmod 700 data/keys
docker compose build
```

## 3. First project, paper mode (no money)

Run the onboarding on the host, with the CLI (do NOT expose the web onboarding in the beta, see KNOWN-RISKS):

```bash
docker compose run --rm engine npm run wallet:new -- --label demo        # prints the project wallet pubkey
docker compose run --rm engine npm run project:add -- --id demo --name "Demo" --mint <MINT> --decimals 6 \
  --wallet <PUBKEY> --mode paper --cap 0.5 --budget 20 --budget-day 5 --delay 24 \
  --level 0.00020:10 --dist 0.3:strength --min-price 0.00015 --strength-boost 3
docker compose up -d engine agent
docker compose logs -f engine
```

Then, from the founder's private Telegram chat: `/start demo <bindCode>`, `/status`, and talk to it. Paper mode quotes real prices and simulates fills; nothing is spent.

## 4. Going live, small size, our own token first

1. Fund the project wallet with the tokens and SOL to manage (beta: under 100 SOL and 5% of supply).
2. In `projects/<id>.json` set `"mode": "live"`, cap and budget as agreed with the founder.
3. `/pause` on Telegram, `docker compose restart engine`, then `resume` and confirm.
4. Watch `docker compose logs -f engine` and the Telegram alerts for the first hour. `/pause` is instant at any time.

## 5. Operations

- Backups: `data/` (ledger + encrypted keys) and `projects/` nightly to an encrypted off-host location. The keystore is useless without the password; back up the password separately.
- Fee sweeps: operator-initiated only (enqueue `sweep_fees`); reconcile any `sweeping` row after a crash before re-sweeping.
- Updates: `git pull && docker compose build && docker compose up -d`. One engine instance only; it holds an exclusive lock on the ledger.
- Logs are JSON lines; `docker compose logs engine | grep '"level":"error"'` for a quick triage.
- Priority fees: raise `TENFOLD_PRIORITY_FEE_MICROLAMPORTS` for busy tokens or live swaps expire. Jito tips are optional (`TENFOLD_JITO_URL`).

## 6. Before any founder money (ranked, from KNOWN-RISKS.md)

- HIGH: keep web onboarding off the public internet until wallet creation moves into the engine.
- HIGH: fee sweeps stay manual.
- MEDIUM: manual Telegram orders skip the opposite-side cooldown; add the guard before founders place manual orders on live projects.
- MEDIUM: distinct message prefix for team-wallet declarations vs login.
- Phase 2: build, test and audit `programs/vault` (Anchor), then move cap, budget, delay and fees on-chain. Scope and threat model: `programs/vault/AUDIT-PREP.md`.

## 7. Jupiter Swap V2 (follow-up)

The client uses the Metis V1 paths (`/swap/v1/quote`, `/swap/v1/swap`) on `api.jup.ag`, which Jupiter has superseded by Swap V2 (`/swap/v2/order` + `/execute`, or `/build` for raw instructions). V1 still answers today; plan the migration before the vault CPIs are finalized, since the vault's swap adapter depends on the instruction layout.
