# Tenfold code review: desk manager, agent, core, docs

Scope: `/home/claude/tenfold/repo` as of 2026-11-04 (build and 302 tests green). Read-only review; every finding below that says "reproduced" was confirmed by running the built `dist` against synthetic inputs (scripts in the scratchpad, not committed). Line numbers refer to the `src` files.

Ranking: CRITICAL = loses founder money or founder intent silently in live mode; HIGH = wrong behaviour the founder will hit in normal use; MEDIUM = wrong under a realistic edge case or misleading; LOW = polish, docs, hygiene.

---

## CRITICAL

### C1. Target reached, then the desk switches distribution back on every hour (sells past the mandate)
`apps/engine/src/desk.ts:318-368`

`if (targetTokens > 0n && actual >= 1 && d.enabled) { d.enabled = false; ... } else { ...compute pace...; if (rel > PACE_CHANGE_MIN_REL && paceCooldownOk) { d.pctOfVaultPerDay = pace; d.enabled = pace > 0; } }`

Once the target is reached the desk disables distribution (run N). On run N+1 `d.enabled` is false, so the `else` branch runs: `current = 0`, `rel = pace / 0.01` is huge, `paceCooldownOk` is true (the previous run was `distribution_done`, not `set_pace`, so `lastPaceChangeAt` is old) and distribution is re-enabled at `base * catchUp` with the note "ahead of the horizon (100% done ...)". Run N+2 disables it again with another `distribution_done` line. Steady state: DIST sells for ~15 minutes out of every hour beyond the mandated share, forever, and the founder gets "Desk: 100% of the vault has been distributed ... Distribution is off" followed by "Desk: Distribution pace 0.00% → 0.25%" every hour. Reproduced (run1 `distribution_done`, run2 `set_pace` enabled=true).

Fix:
```ts
const done = targetTokens > 0n && actual >= 1;
if (done) {
  if (d.enabled) {
    d.enabled = false;
    out.decisions.push({ change: { kind: "distribution_done" }, why: ... });
    out.escalations.push({ topic: "target_reached", ... });
  }
} else {
  // existing pace logic
}
```
Also skip the `horizon_unreachable` escalation when `done`.

### C2. The desk's auto write clobbers whatever the agent saved between the command read and the desk run
`apps/engine/src/runner.ts:587-595` (and the comment at 591 is false)

```ts
const fresh = this.reloadConfig ? this.reloadConfig(this.cfg.id) : this.cfg;
this.cfg = { ...fresh, strategy: out.strategy, mandate: out.mandate };
```
`out.strategy` and `out.mandate` were computed from the stale `this.cfg`, then written over `fresh`. Only `rules`, `paused`, `telegram` etc. survive from the file. Sequence that loses data: tick reads `pendingCommands()` (no `reload` yet) → agent `persist()` writes `projects/<id>.json` (new pinned level, or `set_mandate`, or `set_distribution`) and enqueues `reload` → feed snapshot resolves (1-3 s later) → `runDesk` (15-min interval or a detector force) reloads the file but overwrites `strategy` and `mandate` with the stale-derived result → next tick's `reload` loads the clobbered file. The founder was already told "Confirmed." Reproduced: agent version had `{price: 0.0001, pinned: true}` and `mandate: protect/ask`; persisted result had `mandate: balanced/auto` and no pinned level.

Fix: treat a changed file as a stale decision and retry next tick:
```ts
const fresh = this.reloadConfig ? this.reloadConfig(this.cfg.id) : this.cfg;
if (JSON.stringify(fresh.strategy) !== JSON.stringify(this.cfg.strategy) || JSON.stringify(fresh.mandate) !== JSON.stringify(this.cfg.mandate)) {
  this.cfg = fresh;            // adopt the agent's version
  this.deskForce = true;       // re-decide on it next tick
  return;
}
this.cfg = { ...fresh, strategy: out.strategy, mandate: out.mandate };
```
Independently, make `saveProject` atomic (`writeFileSync(tmp)` + `renameSync`) so neither side can read a half-written file (see M6).

### C3. `autonomy: "ask"` does not work end to end, and floods the founder
Three pieces:

1. `apps/engine/src/runner.ts:601-603`: in `ask` mode nothing is persisted, including the bookkeeping decision `mandate_started` (`startTokens`). So `targetTokens` stays 0 forever: no horizon tracking, no `distribution_done`, and the desk re-proposes `mandate_started` on every run. `lastLevelChangeAt`, `lastPaceChangeAt` and `lostLevelTimes` are also never updated, so the same proposals repeat every run.
2. `apps/engine/src/runner.ts:512-522`: `deskForce` is set on every tick while a managed level is lost or the lifetime budget is under 20%. In `ask` mode the level is never removed (nothing is applied), so the desk runs on every 10 s tick and writes a `desk_proposal` batch each time. Reproduced: 6 ticks (60 s) produced 18 `desk_proposal` events, each one a Telegram message to the founder.
3. `apps/agent/src/alerts.ts:224` tells the founder `Say "do it" to apply`, but no tool applies a desk proposal (`apps/agent/src/tools.ts:68-252`). The model can only reach for `set_defense_level` (which pins the level, so the desk never manages it again) or `set_distribution` (which the desk overrides, H4). The liquidity-pull `pause` is also only proposed in ask mode, so the one "stop everything" safety action does not happen.

Fix (minimum viable):
- Apply bookkeeping and safety regardless of autonomy: in `runDesk`, always persist `out.mandate` (startTokens) and always apply `out.pause`; only gate strategy changes on `autonomy`.
- Rate-limit forced runs: `if (!this.deskForce && now - this.lastDeskRun < DESK_INTERVAL_MS) return;` → add `if (now - this.lastDeskRun < DESK_FORCE_MIN_MS /* 60 s */) return;` before it, and set `deskForce` only on a transition (remember the last forced reason).
- De-duplicate proposals: hash `out.decisions` (kinds + prices + pace) and do not re-emit an identical batch within e.g. 6 h; or persist a `pendingProposal` in the mandate and add an `apply_desk_proposal` tool that writes `out.strategy` as the desk would. Until one of these exists, either drop `ask` from `MandateSchema`/`set_mandate` or document it as not supported.

---

## HIGH

### H1. `listEvents` applies LIMIT before the type filter: restart duplicates reports and escalations, loses the rest state
`packages/core/src/ledger.ts:469-476`; consumers `apps/engine/src/runner.ts:635-651`

```ts
const rows = ...`SELECT * FROM events WHERE project_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?`...;
return rows.map(rowToEvent).filter((e) => !opts.types || opts.types.includes(e.type));
```
`seedFromLedger` asks for the last `daily_report` with `limit: 50` and the last `weekly_report` with `limit: 1`: on a busy engine the newest 50 events are fills/rejections, so both come back empty. Reproduced: with one `daily_report`, one `weekly_report` and 60 `order_filled` rows, both lookups return 0. Consequences on every engine restart after 09:00 local: a second `daily_report` (and on Mondays a second `weekly_report`) is sent to the founder; `desk_escalation` throttles (`since 7d, limit 200`) are lost so `budget_top_up`, `horizon_unreachable`, `trend_down` fire again immediately; `lostLevelTimes`/`lastPaceChangeAt` (`limit 2000`) are likely fine but not guaranteed. `actions.ts:109` already works around this with raw SQL for cap raises.

Fix in `listEvents`:
```ts
const types = opts.types ?? [];
const sql = `SELECT * FROM events WHERE project_id = ? AND ts >= ?` + (types.length ? ` AND type IN (${types.map(() => "?").join(",")})` : "") + ` ORDER BY ts DESC LIMIT ?`;
const rows = this.db.prepare(sql).all(projectId, since, ...types, limit) as unknown as EventRow[];
return rows.map(rowToEvent);
```

### H2. A "spent" level is re-placed at the same price, so it is still spent; the `why` ("fresh budget") is false and it churns
`apps/engine/src/desk.ts:224-228` and `283-299`; accounting in `packages/strategies/src/util.ts:63-76`

Per-level spend is attributed by the note tag `level:<price>` over the last 24 h of orders. When a level has spent its budget and the anchor has not moved, the desk removes it (`cause: "spent"`) and places a new level at `round(anchor*(1-dist), 10)`, i.e. the same price and the same tag, with `budgetSol = min(pool*share, max(dayLeft, 0.5))`. The new level therefore inherits the old spend: `levelRemainingLamports = budget - spent <= 0`, DEF never buys from it, and on the next run `ownLeft` is again under 0.1 SOL so it is removed and re-placed again. Whenever `dayLeft` has moved (fills ageing out of the 24 h window), `budgetSol` differs, `strategyChanged` is true, and two `desk_decision` lines ("has spent its 5.00 SOL. Re-placing with fresh budget." + "Placed a defense level at ...") reach the founder every 15 minutes while the defense is actually dead for the rest of the 24 h window. Reproduced: `[remove_level:spent, place_level]` at the identical price 0.000186 with budget 5 → 4.

Fix: either change the price when re-placing a spent level (`stepDown = Math.max(stepDown, 1)` in the spent branch, like breathe), or give levels a `placedAt` and count only orders with `createdAt >= placedAt` in `levelSpentLamports` (schema: `placedAt: z.number().optional()` on the level object). The second is the real fix; KNOWN-RISKS already flags the 24 h level-budget semantics as a MEDIUM, and the desk now makes decisions on it.

### H3. Liquidity pull is decided from one noisy impact-quote sample against one hour-old sample, and the result is an un-reversible pause
`apps/engine/src/desk.ts:181-190`; source of the number `packages/exec/src/feed.ts:56-63, 199-207`

`liquiditySol` is `1 SOL / priceImpact` of a single Jupiter quote. Jupiter routes across pools; the impact of a 1 SOL quote routinely doubles when the router picks a different path, when a pool is momentarily imbalanced, or when the quote partially fails. The desk compares the current single value with the single oldest snapshot of the hour (`hourAgo`) and pauses the whole project on `< 0.5x`, with an escalation the founder must answer and a `resume` that needs a confirmation. One bad quote at the 15-minute desk run stops a live project for as long as the founder is asleep. The sentence "Pool liquidity dropped from X to Y SOL within the hour" is also presented as a reading while the code comment in feed.ts calls it "an estimate, not a reading".

Fix: require persistence on both ends:
```ts
const recent = lastHour.filter((s) => s.ts >= now - 5 * MINUTE && s.liquiditySol !== undefined).map((s) => s.liquiditySol!);
recent.push(snapshot.liquiditySol);
const old = lastHour.filter((s) => s.ts <= now - 45 * MINUTE && s.liquiditySol !== undefined).map((s) => s.liquiditySol!);
const nowLiq = median(recent), thenLiq = median(old);
if (recent.length >= 3 && old.length >= 3 && thenLiq! > 0 && nowLiq! < thenLiq! * LIQUIDITY_PULL_FRACTION) { ... }
```
and consider a lighter first step (halve the pace, escalate) before the hard pause.

### H4. The desk silently undoes the founder's `set_distribution` within 15 minutes
`apps/engine/src/desk.ts:308-312, 358-367`; `apps/agent/src/actions.ts:433-471`; `apps/agent/src/tools.ts:90-105`

With a mandate, `set_distribution` is still offered to the model and its confirmation text promises "Turn distribution OFF (settings kept: 0.4%/day, strength)". The desk then sees `current = 0`, `rel` huge, and re-enables distribution at the mandate pace, and resets `mode` to `strength` and `strengthBoost` to the profile's. Reproduced: founder config `{enabled: false, pct: 0.4, mode: "twap"}` → next desk run `set_boost` + `set_pace 0.00% → 0.50%`, `mode: strength`. The only working way to stop distribution on a mandate project is `set_mandate distributePct: 0`, which neither the tool description nor the prompt says.

Fix: in `setDistribution`, when `ctx.cfg.mandate` exists return `{ ok: false, message: "This project runs on a mandate; the desk sets the pace. To stop distributing, set the mandate's share to 0 (set_mandate distributePct 0); to change the floor, send only minPrice." }` (allow a minPrice-only change). Mirror the sentence in the tool description. Same treatment for `mode`/`strengthBoost`.

### H5. `set_mandate` restarts the horizon clock on a same-value profile and wipes the desk's levels on a floor-only change
`apps/agent/src/actions.ts:817-818` and `848-851`

```ts
startedAt: current && input.profile === undefined && input.horizonDays === undefined && input.distributePct === undefined ? current.startedAt : now,
startTokens: ... same condition ... ? current.startTokens : undefined,
...
c.strategy = strategyFromMandate(c.mandate!, c);
c.strategy.defense.levels = pinned;
```
The restart condition tests presence, not change. Models routinely re-send the profile ("switch to ask mode" → `{profile: "balanced", autonomy: "ask"}`): `changes` says only "autonomy auto -> ask", but `startedAt` becomes now and `startTokens` is cleared, so the distribution base is re-measured from the already-reduced vault and `distributed` restarts at 0: the mandate over-distributes relative to what was agreed. Reproduced. Separately, every `set_mandate` (even `{alertFloor}` only) rebuilds the strategy: all desk-managed levels are dropped (no defense until the next desk run, up to 15 min; and `lastPaceChangeAt` in the runner can block the pace re-set for up to 1 h), the pace is reset to base and rebalance is re-enabled. Reproduced: floor-only change → `levels: []`, pace 0.4 → 0.5.

Fix:
```ts
const restarts = !current || next.profile !== current.profile || next.horizonDays !== current.horizonDays || next.distributePct !== current.distributePct;
startedAt: restarts ? now : current!.startedAt,
startTokens: restarts ? undefined : current!.startTokens,
...
if (restarts) { const pinned = ...; c.strategy = strategyFromMandate(c.mandate!, c); c.strategy.defense.levels = pinned; ... }
// else: keep c.strategy as is; the desk adapts on its next run
```
and say in the summary when the clock restarts ("horizon restarts from today").

### H6. Rebalance is switched on by every mandate and its sells/buys bypass the mandate's accounting
`packages/core/src/mandate.ts:116` (`rebalance: { enabled: true, targetSolShare: p.targetSolShare, band: p.rebalanceBand }`); progress counting `apps/engine/src/runner.ts:566-569` (DIST only)

A `protect` mandate ("protect the price first, distribute slowly") on a vault of 1M tokens worth 200 SOL + 40 SOL has a SOL share of 17% against a 50% target: REB sells tokens every 10 minutes (a clip each, within the cap) until the share is 38%+. Those sells are not DIST, so they do not count toward `distributedSinceStart`, the mandate's "20% over 60 days" is exceeded without the desk noticing, and the REB sells compete with DIST for the daily cap. In the other direction REB buys spend SOL outside the defense budget. `describeMandate` never mentions rebalancing, `set_mandate`'s description does not either.

Fix: count every own sell toward mandate progress (`.filter((f) => f.side === "sell")`, not `reason === "DIST"`), lower `targetSolShare` for `protect` or leave `rebalance.enabled` as the project had it, and add "keeps about N% of the vault in SOL" to `describeMandate`.

---

## MEDIUM

### M1. Two levels lost in one run: both re-placed, then the desk announces it is "resting" while they stay live
`apps/engine/src/desk.ts:205-223, 262-270`

`lostNow` is a boolean; `restNow = resting || (lostNow && lost + 1 >= 2)` counts one loss per run. A protect project whose two levels are lost in the same crash re-places both (`[remove, remove, place, place]`), the runner pushes two timestamps, and the next run (lost = 2) emits `trend_down`: "The desk is resting the defense for 6 h rather than buying into a falling market" while the two levels placed 15 minutes earlier are still in `defense.levels` buying into it. Reproduced. The per-level sentence also always says `6 h` (`REST_AFTER_LOSSES_MS / HOUR`) though the rest doubles (12 h, 24 h) and says "re-placing lower" even when no budget is left for that.

Fix: `let lostCount = 0;` increment per lost level, use `lost + lostCount` in `restNow` and in both sentences, compute the rest hours from `restMs`, and when `restNow` is true also drop the managed levels from `keep` (or do not claim to rest).

### M2. Trail-up moves two levels to the same price
`apps/engine/src/desk.ts:245-256`

`to = round(ref * (1 - dist), 10)` is the same for every managed level; the `sameLevel` guard only checks against the level's own old price. Protect profile, price held 3 steps above both levels for 6 h → `[move_level, move_level]` both to 0.000192 (reproduced): two levels with the same tag, double-counted spend, two DEF proposals per tick for one price.

Fix: `if (!sameLevel(to, level.price) && to > level.price && !keep.some((l) => sameLevel(l.price, to)))`, and step the second one down (`ref * (1 - dist * (i + 1))` by rank).

### M3. "Breathe" reacts to one 5-minute flow sample with a very low threshold
`apps/engine/src/desk.ts:231-243`; `packages/core/src/risk.ts:165-169`

`burn = (sell5m - buy5m) * 12` from the current snapshot only; `hours = min(dayLeft, ownLeft) / burn < breatheUnderHours`. With `dayLeft = 5 SOL` and `balanced` (3 h) any excess of 0.14 SOL of sells over buys in a 5-minute window steps the level down as soon as the price is in play, and the runner forces a desk run exactly when `sell_pressure` fires. In practice the defense gives way on first contact in any active market, then trails back up 3 h later (M2 path), then gives way again. The desk already has `buy1h`/`sell1h` (lines 331-336); use the hour's excess (`(sell1h - buy1h) / lastHourSpanHours`) or require the pressure detector's 5-snapshot window.

### M4. `budget_low` forces a full desk run on every tick, for days
`apps/engine/src/runner.ts:518-522`

`detectBudgetLow` is true as long as under 20% of the lifetime budget remains, so `deskForce` is set every 10 s until the founder tops up. Each run does `listFills(since mandate start, limit 100k)`, `snapshotsSince(6 h)` and an insider query. Harmless in auto (no change → no events) but needless load, and it is the amplifier of C3 in ask mode. Fix: edge-trigger (`if (budget.low && !this.budgetLowSeen)`) and a minimum spacing for forced runs.

### M5. `snapshotsSince` returns the OLDEST rows when the limit binds; the desk is blind to the last hour in sim/backtest
`packages/core/src/ledger.ts:282-287` (`ORDER BY ts ASC LIMIT ?`); callers `apps/engine/src/runner.ts:564-565` (6 h, limit 5000), `ledger.ts:793` (limit 100k)

At the 500 ms sim tick (`apps/engine/src/main.ts:22`) 6 h is 43,200 rows; the query returns the first 5000 after `now - 6h`, so once the sim has run 42 minutes `lastHour` is empty: ref = current price, vol = 0, `hourAgo` compares liquidity with a 2-6 h old sample, `heldAbove` is computed on stale data. Reproduced (2 h of 500 ms rows: newest returned 78 min old, last-hour rows 0). Live (10 s ticks, 2160 rows) is under the limit today; any faster tick or a second snapshot writer breaks it. `periodReport` has the same shape and also no upper bound on snapshots (`snapshotsSince(dayStart)` without `until`), so `priceClose`/vault are "latest", not "at `to`".

Fix: `ORDER BY ts DESC LIMIT ?` then `.reverse()`, or add `until` and query the newest; in `periodReport` add `AND ts <= ?`.

### M6. Non-atomic project writes and a `reload` that is never retried
`packages/core/src/config.ts:181-186`; `apps/engine/src/runner.ts:454-461, 467-470`; `apps/agent/src/actions.ts:73-79`

Both processes `writeFileSync` the same JSON. If the engine reads it mid-write, `applyCommand("reload")` throws, the command is marked `failed` and never retried: the engine keeps the old config indefinitely while the founder was told "Confirmed." (until the next desk write or another reload). If the agent reads it mid-write, `persist` falls back to `structuredClone(ctx.cfg)` and writes that over the desk's change. Fix: `saveProject` → write to `<file>.tmp` then `renameSync`; on reload failure leave the command pending (do not `completeCommand`) and retry next tick, with a counter.

### M7. Removing a level with `set_defense_level remove` on a mandate project is undone (or permanently disables defense)
`apps/agent/src/actions.ts:364-383`; gate `apps/engine/src/desk.ts:194`

Removing a desk-managed level: the desk sees `managedKept < p.levels` and re-places it within 15 min; the confirmation text does not say so. Removing the last level: `enabled = false`, and the desk only manages when `defense.enabled` is true, so the mandate's defense is off for good with no message (the same happens for a project created with `--budget 0` and topped up later via `set_defense_budget`). Fix: in the remove path, refuse non-pinned levels on a mandate project ("the desk placed that level; it will put it back. Pin your own level or change the mandate"); in the desk, gate on `cfg.rules.defenseBudgetSol > 0 && p.levels > 0` and set `defense.enabled = true` yourself.

### M8. "Defense budget is used up" when the wallet is empty; default profiles are unreachable at the default cap
`apps/engine/src/desk.ts:277-282, 369-377`; `packages/core/src/mandate.ts:34-77`; `packages/core/src/config.ts:131-139`

`budgetable = min(lifeLeft, vaultSol)`; an unfunded paper wallet (README says "Deposit nothing yet") gets a daily "The defense budget is used up (20.0 SOL left of 20.0, 0.00 SOL in the wallet)". Reproduced. And `balanced` (50% / 45 d = 1.11%/d) and `distribute` (100% / 30 d = 3.33%/d) both exceed `DEFAULT_RULES.dailySellCapPct = 0.5`, so every default mandate escalates `horizon_unreachable` once a day with no way to acknowledge ("accept the slower pace" is an option the agent cannot record). Fix: branch the sentence on `vaultSol < MIN_LEVEL_BUDGET_SOL` ("the project wallet holds 0.00 SOL; send SOL to defend"), make the profile defaults consistent with the default cap (or derive `horizonDays` default from `distributePct / cap`), and let `set_mandate` store an `acceptedSlowPace: true` that silences the escalation.

### M9. The desk keeps deciding and announcing while the project is paused
`apps/engine/src/runner.ts:214-216, 231` (desk runs before the paused check); `apps/engine/src/desk.ts:182` (only the liquidity branch checks `cfg.paused`)

After the founder pauses, levels are still placed/moved and the pace is still re-set, each with a "Desk: ..." Telegram line; `budget_top_up`/`trend_down` keep nagging. Fix: `if (this.cfg.paused) return;` at the top of `runDesk` (keep running `mandate_started` bookkeeping if you want), or suppress emission while paused.

### M10. Docs do not describe the desk, and KNOWN-RISKS has nothing on it
`README.md` (Day 1 example and the Telegram phrases are legacy `--level/--dist`; "The three processes share one SQLite file" is now six), `DEPLOY.md` §3 (legacy flags), `KNOWN-RISKS.md` (no entry for: the engine now writes `projects/<id>.json` autonomously; ask mode gap (C3); liquidity estimate false positives (H3); REB under a mandate (H6); the 24 h level-budget semantics now driving "spent" decisions (H2); the agent/engine write race (C2)). `scripts/add-project.js:1-13` calls the mandate "recommended" while both runbooks never use it, and `scripts/e2e-sim.sh` never exercises the desk. Fix: one "Mandate (recommended)" block in README Day 1 with `--mandate balanced --horizon-days 30 --distribute-pct 20 --alert-floor ...`, the same in DEPLOY §3, and a "Desk manager" section in KNOWN-RISKS listing the above.

### M11. The system prompt's "Project facts" go stale after `set_mandate`
`apps/agent/src/bot.ts:93-100` caches one `Brain` per project with `systemPromptFor(cfg)` built on first use; `apps/agent/src/brain.ts:82-87` bakes `Mandate: ...` and `mode` into it. After the founder changes the mandate (or the project goes live), the model keeps being told the old mandate until the agent restarts. Fix: build the prompt per message (`new Brain(deps.anthropic, deps.model, systemPromptFor(cfg))` is cheap) or key the cache on `JSON.stringify(cfg.mandate) + cfg.mode`.

---

## LOW

- L1 `apps/engine/src/desk.ts:247` `heldAbove` requires the price above for the whole 6 h `history`, while the sentence says "for ${p.trailUpHours} h" (2/3/6). Use `history.filter((s) => s.ts >= now - p.trailUpHours * HOUR)`.
- L2 `apps/engine/src/desk.ts:287` `round(x, 10)` is fixed decimals: a 2.5e-9 SOL token gets 2 significant digits and a 1e-11 one gets 0 (silently no level). Use `Number(x.toPrecision(6))`.
- L3 `apps/agent/src/alerts.ts:215-221, 226-232` a liquidity pull produces three messages carrying the same sentence (`desk_decision pause`, `paused (desk)`, escalation). Return `undefined` for `kind === "pause"` in `desk_decision`.
- L4 `apps/agent/src/tools.ts:53-62` `CONFIRMED_TOOLS` lacks `set_mandate` (only tests read it, but it documents the contract).
- L5 `apps/agent/src/actions.ts:251` status lines do not mark pinned levels; the model cannot tell founder levels from desk levels when the founder asks "which are mine". Append `(pinned)`; also expose `pinned` in `data.defense.levels` (already there via the object).
- L6 `scripts/add-project.js:108-113` with `--mandate`, `--strength-boost`, `--dist` and `--rebalance` are silently overridden by `strategyFromMandate` while the usage text (line 34) implies they are honoured; `--alert-floor 0` and an unknown `--autonomy` die with a raw zod error. Validate and say "ignored with --mandate".
- L7 `.env.example` lacks `TENFOLD_SIM_SEED/START_PRICE/DRIFT/VOL/TOKENS/SOL` (`apps/engine/src/main.ts:76-83`) and `TENFOLD_MARKETING_STATE_PATH` (`apps/marketing/src/main.ts:44`). All `loadEnv` names match.
- L8 `packages/core/src/log.ts:5` `minLevel` is captured at import, so `backtest.ts:121-122` setting `TENFOLD_LOG_LEVEL=error` for `quiet` has no effect, and an invalid level value makes `order[level] < undefined` false, i.e. logs everything. Read the env per call and validate.
- L9 `apps/engine/src/runner.ts:456` the `reload` command uses `loadProject` directly instead of `this.reloadConfig`; backtests/tests that enqueue `reload` fail the command.
- L10 `apps/agent/src/brain.ts:49` lists "the floor" among hard rules enforced by the engine; `minPrice` is a strategy field the agent changes on one confirmation. Say "the daily sell cap and the defense budgets".
- L11 `apps/engine/src/desk.ts:369-377` `horizon_unreachable` and `budget_top_up` (277-282) re-escalate daily forever; none of their "accept"/"leave it" options can be recorded. See M8.
- L12 `apps/agent/src/bot.ts:297` `fields.http = String(e.error)` for a grammY `HttpError`: some fetch error messages include the request URL, which carries the bot token. Mask `/bot\d+:[A-Za-z0-9_-]+/` before logging (KNOWN-RISKS notes the same for stored post errors).
- L13 `apps/engine/src/desk.ts:295` the `why` says "under the 1h reference" on the very first run of a fresh project when the reference is a single snapshot; say "under the current price" when `lastHour.length < 3`.
- L14 `apps/agent/src/alerts.ts:247-259` `weekFromEvent` falls back to the 24 h report for any field absent from the event (e.g. `tokenVwap` when no snapshot existed), mixing 24 h numbers into the 7-day text. Fall back to `undefined`, not the daily report.

---

## Tests: wrong expectations and gaps

Expectations that encode or hide a wrong behaviour:
- `apps/agent/src/mandate.test.ts:67-75` "changing the profile restarts it" asserts `toBeGreaterThanOrEqual(first.startedAt)`, which is always true; it also never checks the same-value case (H5). Assert `toBeGreaterThan` with an injected `now`, and add `{profile: "balanced", autonomy: "ask"}` → `startedAt` unchanged.
- `apps/engine/src/desk.test.ts:184-191` "turns distribution off when the mandate's share is distributed" tests one run only; a second run on the returned strategy would have caught C1.
- `apps/engine/src/desk.test.ts:235-257` "auto: ... re-runs only after the interval" uses a flat market with no detector, so it does not cover the forced-run path (C3/M4).

Missing tests worth adding (each maps to a finding):
1. desk: run `decide` twice with `distributedSinceStart >= target`; second run must produce no `set_pace` and keep `enabled: false` (C1).
2. runner: `reloadConfig` returning a config with a new pinned level and a different mandate while the desk has a stale `cfg`; the persisted config must contain the pinned level and the agent's mandate (C2).
3. runner, `autonomy: "ask"`: 10 ticks with a lost level produce at most one `desk_proposal` batch and `mandate.startTokens` is persisted; a liquidity pull pauses the project (C3).
4. ledger: `listEvents(types: [X], limit: 1)` finds the newest X behind 100 other events; `seedFromLedger` after 500 fills still sets `lastDailyReportDay`/`lastWeeklyReportDay` and the escalation throttles (H1).
5. desk: a level with `levelSpentLamports == budget` at an unchanged anchor is re-placed at a different price, or its remaining budget is positive after re-placement (H2).
6. desk: one snapshot with `liquiditySol` at 30% of the hour-ago value between normal snapshots does not pause; three consecutive ones do (H3).
7. agent: `setDistribution` on a mandate project is refused (or warns) and the desk run that follows keeps `enabled: false` when the founder turned it off (H4).
8. agent: `setMandate({alertFloor})` keeps `strategy.defense.levels` and `distribution.pctOfVaultPerDay` (H5).
9. desk: `protect`, two levels lost in one run → second run has no live managed level while `trend_down` is raised; two levels never trail to the same price (M1, M2).
10. runner: with `budget.low` true for 100 ticks the desk runs at most N times (M4).
11. ledger: `snapshotsSince` with more rows than the limit returns the newest ones; `periodReport(from, to)` with `to < now` closes at `to` (M5).
12. runner: a `reload` that throws once is retried and applied on the next tick (M6).
13. agent: `set_defense_level remove` on a desk-managed level of a mandate project is refused; removing the last pinned level does not leave `defense.enabled=false` on a funded mandate project (M7).
14. desk: an unfunded wallet's escalation names the wallet, not the budget (M8); no `desk_decision` events while `cfg.paused` (M9).
15. agent/bot: after `set_mandate`, the next `respond` is called with a system prompt that contains the new mandate (M11).
16. alerts: `desk_decision {kind: "pause"}` yields no message (L3).
