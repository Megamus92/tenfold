# Tenfold code review, second pass: does the rewrite hold?

Scope: `/home/claude/tenfold/repo` as of 2026-11-04 after the desk rewrite (build green, `npm test` 329 passed / 32 files). Read-only; nothing in the repo was edited. Everything marked "reproduced" was run against the built `dist` with throwaway scripts in the scratchpad (`/tmp/claude-0/-home-claude/ac2f3ccf-047a-5080-8c4f-674f850c0b39/scratchpad/bt/`), including the three requested backtests and two targeted harness runs (ask mode with a drifting price; noisy liquidity estimate). Line numbers refer to `src`.

Ranking as in the first review: CRITICAL = loses founder money or founder intent silently in live mode; HIGH = wrong behaviour hit in normal use; MEDIUM = wrong under a realistic edge case or misleading; LOW = polish.

Summary: the first review's CRITICAL and HIGH items are fixed as stated, with three exceptions (C3 part 3, H6, M3) that are partial. The rewrite introduced one new CRITICAL (the ladder's rank arithmetic) and several HIGHs that only show up when the desk runs for hours on a moving market, which the unit tests (flat price, constant feed) never do. The 72 h backtest shows the pattern on every drift.

---

## Backtest evidence (requested runs)

Project: `add-project.js --id demo ... --mode paper --cap 0.5 --budget 20 --budget-day 5 --mandate balanced --horizon-days 60 --distribute-pct 30` in a fresh `TENFOLD_PROJECTS_DIR`. `backtest.js demo --steps 25920 --tick 10 --seed 3 --vol 0.004 --sol 40` (72 simulated hours, 10 s ticks):

| drift | price | fills (DIST / DEF / REB) | DEF SOL spent | desk_decision | escalations | sell_pressure events |
|---|---|---|---|---|---|---|
| -0.00002 | -60.7% | 52 / 76 / 13 | 10.85 (77,590 tokens, worth 6.1 SOL at the end) | 29 (place 9, move 8, remove 10, set_clip 1) | **0** | 333 |
| +0.00002 | +10.8% | 31 / 73 / 36 | 10.44 | 22 (place 7, move 7, remove 6, set_clip 1) | 0 | 329 |
| 0 | -34.0% | 28 / 65 / 31 | 9.30 | 28 (place 9, move 8, remove 9, set_clip 1) | 0 | 331 |

No `set_pace` in any run (the sim's flows are symmetric, so the hour-pressure, participation and own-share branches are never exercised by this backtest; those were checked with the harness instead). The decision trace of the down run (dump in the scratchpad, `down-dump.txt`) is what the CRITICAL and the first two HIGHs below are built on; the key lines are quoted inline.

---

## CRITICAL

### C1. The ladder re-places a consumed or breathed TOP level at the DEEPEST rung (47 to 54% under the price); the `why` says "re-placing with fresh budget" / "stepping the level down"
`apps/engine/src/desk.ts:436-450` (`const live = keep.filter(!pinned).length; for (let rank = live; rank < p.levels; rank++) { steps = p.ladder[rank] + stepDown; price = anchor * (1 - baseDist * steps) }`), `desk.ts:298,343` (`stepDown` is a local that only lives in the run that removed the level, and that run never places because `removedNow` is true at `:437`).

The "missing rungs" are computed by COUNT, not by POSITION. When the top rung (1x distance) is removed as `spent` or `breathe`, the two survivors sit at 2x and 3.5x and the replacement goes to `rank = live = 2`, i.e. 3.5x the base distance under the anchor. With the realized vol of the sim (7 to 8%/h, `baseDist` = 2 sigma = 14 to 16%) that is 47 to 54% under the price, funded with 40% of the day's remaining budget. The breathe step-down is lost entirely: `stepDown` is reset to 0 on the next run, the one that actually places.

Reproduced, down run:
```
0.00h place_level  Placed 3 defense levels at 0.0001906 (1.25), 0.0001806 (1.75), 0.0001655 (2.00): 5% to 18% under the current price 0.0002006.
0.27h remove_level spent 0.0001906 :: Level 0.0001906 has spent its 1.25 SOL. Re-placing with fresh budget after a 15 min cooldown.
0.72h place_level  Placed a defense level at 0.0001011 (1.50 SOL): 47% to 47% under the 1h reference 0.0001912
2.26h remove_level breathe 0.0001806 :: ... Letting it breathe: stepping the level down.
2.66h place_level  Placed a defense level at 0.00008222 (1.21 SOL): 54% to 54% under the current price 0.0001775
```
All 9 placements after the first one in the down run (and all 6/8 in the other two) are at 47 to 54% under. The defense never again has a level within 15% of the price except through trail-up (which is what pulls the deep levels back up by rank three hours later, see H1). A "balanced: hold reasonable levels" mandate becomes "buy at half price with the leftovers", and the founder is told the level was re-placed. Also visible: `4h DEF buy=3` then no DEF fill until 29 h: the whole 5 SOL day budget was deployed at once (`ladderBudget = min(budgetable, dayLeft)`, `:439`) into a 5/10/17.5% ladder on a 37%-daily-vol token and consumed in 4 hours; the defense was dead for the next 25 hours while the price fell another 25%.

Fix: place by vacant POSITION, and carry the step-down in state, not in a local:
```ts
// desk.ts, replacement for :436-450
const targets = p.ladder.map((mult, rank) => ({ rank, steps: mult + stepDown, price: sig(anchor * (1 - baseDist * (mult + stepDown))) }));
const vacant = targets.filter((t) => t.price > 0 && !keep.some((l) => sameLevel(l.price, t.price) || (l.price > t.price * (1 - baseDist / 2) && l.price < t.price * (1 + baseDist / 2))));
for (const t of vacant) { const budget = round(ladderBudget * p.split[t.rank]!, 2); if (budget >= MIN_LEVEL_BUDGET_SOL) keep.push({ price: t.price, budgetSol: budget, placedAt: now }); }
```
and persist the step-down (e.g. `DeskInput.stepDownUntil` set by the runner from the last `breathe` decision, decaying after `trailUpHours`), since the run that removes never places. Also cap the deepest rung, not the base: `MAX_LEVEL_DISTANCE` should bound `baseDist * p.ladder[last]` (today 3.5 x 0.30 = 105%: the rung is silently skipped by `!(price > 0)`, and at 15% vol the "defense" sits 52% under). Do not deploy the whole day budget in one ladder: `ladderBudget = min(budgetable, dayLeft * max(0.25, hoursLeftInDay / 24))` or an explicit per-placement share.

---

## HIGH

### H1. Trail-up fires in the same run as a loss or a breathe: the ladder is pulled UP into a falling market, then breathes again an hour later
`apps/engine/src/desk.ts:402-431` (trail-up is not gated on `removedNow`, `lostNow`, `fastPressure`, `drop5m` or the sign of the hour's return; `heldAbove` only checks that every price of the window is above `top * (1 + d)`).

Reproduced, down run:
```
30.02h remove_level breathe 0.0002097 :: Holding 0.0002097 costs about 1.40 SOL/hour ... Letting it breathe
30.02h move_level  :: Price has held more than 29% above 0.0001725 for 3 h. Trailing the ladder up: 0.0001725 → 0.0001799, 0.0001146 → 0.0001496.
   (price 29h 0.000265 → 30h 0.000214 → 32h 0.000186; 31h DEF buy=4 on the lifted level)
69.99h remove_level lost 0.0001020 :: Level 0.0001020 is lost: price is 15% under it. Not chasing it down
69.99h move_level  :: Trailing the ladder up: 0.00006876 → 0.00007354, 0.00005250 → 0.00006047.
70.98h remove_level breathe 0.00007354 :: ... the budget would last 0.3 h. Letting it breathe
```
The desk says "not chasing it down" and lifts the remaining ladder toward the falling price in the same batch; the lifted level is hit within the hour and breathes. Two contradictory sentences reach the founder at the same timestamp.

Fix: `if (top && trailThrottleOk && !removedNow && !fastPressure && drop5m <= 0 && snapshot.price >= (lastHour[0]?.price ?? snapshot.price))` (no trail-up while any level was removed this run, while 15-min flow is adverse, or while the hour's return is negative). Also the trail distance check `low1h > trailAt * (1 - baseDist / 2)` should use the current price, not the hour's low, since `prices` already includes `snapshot.price` only as one of ~360 samples.

### H2. Rebalance sells bypass every distribution gate: after `distribution_done`, under the alert floor, after a team-wallet sell, over the own-share stop, REB keeps selling tokens at the cap
`packages/core/src/mandate.ts:165` (`rebalance: { enabled: true, ... }` for every mandate), `packages/strategies/src/rebalance.ts:59-68` (gates: no-sell zone, minPrice, cap, own-buy cooldown; nothing else), `apps/engine/src/desk.ts:493-498,524-527,542-550` (the desk only flips `strategy.distribution.enabled`), `apps/engine/src/runner.ts:615-616` ("a rebalance sell is distribution by another name", counted toward the mandate).

The first review's H6 fix made REB sells count toward the horizon, which is right, but it did not make the desk's STOP decisions apply to them. `distribution_done` tells the founder "Distribution is off until you set a new one" (`desk.ts:496`), the insider branch says "Distribution is on hold so Tenfold does not add to that selling" (`:590`), the own-share branch says "the desk stops distributing" (`:547`): all three are false whenever the SOL share is under `target - band`, which is exactly the state a rising token puts a token-heavy vault in (price x2 → SOL share halves → REB sells a clip every 10 minutes up to the full daily cap). Reproduced in the up run: 36 REB sells vs 31 DIST, REB consuming the cap DIST was paced for. In the same run DEF bought 47,576 tokens on dips and REB sold 6,524 back hours later: a DEF→REB round trip inside the cap that generates volume fee (Rule 24 of the calibration memo is explicit that this is the conflict to avoid).

Fix: make REB respect the desk's distribution state: in `proposeRebalance`, for the sell branch `if (!cfg.strategy.distribution.enabled) return [];` and check `cfg.mandate?.alertFloor` (`if (alertFloor !== undefined && snapshot.price < alertFloor) return []`). Have the desk set `strategy.rebalance.enabled = false` on `done`/insider/own-share and restore it when they clear, or (cleaner, per Rule 23) remove explicit REB sells on mandate projects and let the inventory skew bias the DIST pace instead. Until then, `describeMandate` should say "may also sell to keep about N% in SOL, even when distribution is paused".

### H3. Ask mode: proposals are not de-duplicated in practice (96 batches a day on a quiet drift), and nothing can apply them
`apps/engine/src/runner.ts:680-686` (`key = JSON.stringify(proposals.map((d) => d.change))`: `place_level` carries `price`/`budgetSol`, `set_pace` carries `to`, both change with every snapshot), `runner.ts:533` (a lost managed level sets `deskForce` every tick, and in ask mode it is never removed, so the desk runs every 60 s), `apps/agent/src/alerts.ts:225` ("Say \"do it\" to apply") with no tool in `apps/agent/src/tools.ts` that applies a proposal.

Reproduced with the harness (balanced, `autonomy: ask`, price drifting -4.3% over the day, flows flat): **96 `place_level` + 96 `set_clip` proposals in 24 h** (one batch per desk run; each batch is two Telegram messages). The test `desk.test.ts:419` passes only because its `Feed` price is constant. `KNOWN-RISKS.md:36` ("proposes once, no repeats within 6h") is therefore not true. With a lost level (ask mode never removes it) the forced run is every 60 s, and the batch key moves whenever `set_pace` is in it. "Do it" has no implementation: the model can only pin a level (`set_defense_level`, which the desk then never manages) or change the mandate.

Also: the SAFETY zeroing is not applied in ask mode. `runner.ts:663` applies `out.strategy` only when `autonomy === "auto"`, so `set_pace → 0` under the alert floor, after an insider sell, on a tier-1 drop or over the own-share stop is only proposed; distribution keeps selling while the escalation text says it is off (`desk.ts:533, 590`). Only `out.pause` is applied regardless (`:664`).

Fix: (a) key the de-dupe on kinds plus coarse values, `JSON.stringify(proposals.map((d) => d.change.kind + (d.change.kind === "set_pace" ? ":" + (d.change.to > 0 ? "on" : "off") : "")))`, and throttle any proposal batch to once per `6 * HOUR` regardless of key; (b) apply risk-reducing changes in both modes: in `runDesk`, when `!applyStrategy`, still take `out.strategy.distribution.enabled === false` / `pctOfVaultPerDay` reductions and `remove_level` decisions (they only stop activity) and only gate `place_level`/`move_level`/pace increases/`set_clip` increases on autonomy; (c) add an `apply_desk_proposal` tool (store the last proposal batch's `strategy` in the ledger under `desk_proposal` data, the tool writes it through `persist`) or change the alert text to "Change the mandate if you want this; nothing applies by itself".

### H4. Under a mandate the engine still asks the founder to decide on every `sell_pressure`: 333 questions in 72 h
`apps/agent/src/alerts.ts:63-84` (`"... Hold, lower the level, or let it breathe?"`), `apps/engine/src/runner.ts:497-519` (emitted every 10 min while 5 snapshots of sells > 1.5x buys), `alerts.ts:96-101` (`budget_low`: "Raise the budget, lower the levels, or let it breathe?").

Reproduced in all three backtests (329 to 333 events; each one is a message to the founder). The desk now owns exactly those three choices, and the onboarding text promises "You never have to answer unless I say Your call" (`bot.ts:225`, `wizard.ts:135`). The founder gets a question every 13 minutes that the desk answers itself 60 s later with a "Desk:" line.

Fix: in `formatEvent`, when `cfg.mandate` is set return `undefined` for `sell_pressure` and `budget_low` (the desk escalates `budget_top_up`/`no_sol` itself), or turn them into one informational line without a question and let the daily report carry the count.

### H5. Breathe threshold is four times tighter than the calibration source: any level in play breathes on the first net selling
`apps/engine/src/desk.ts:335` (`hours = Math.min(dayLeft, ownLeft) / burnPerHour`), `:247` (`fastPressure`: 15-min mean sells > 2x buys, no minimum size), `docs/mm-best-practices.md` Rule 13 and the table row "Breathe: step a level down when holding it would exhaust the DAY's budget in under 4 h".

The memo's rule is `dayLeft / burn < 4 h`; the code uses the LEVEL's remaining budget (1.25 SOL for the top rung), so the top level breathes at any excess of 0.31 SOL/h, i.e. 0.026 SOL more sells than buys per 5-minute window. Reproduced: `2.26h breathe: costs about 0.70 SOL/hour ... budget would last 1.5 h` (the level had ~1.05 SOL left; the day had ~3 SOL left, so under the memo's rule the budget lasts ~4.4 h and the level holds). Combined with C1 the consequence is that the top rung is removed on first contact and re-placed at half price. `fastPressure` has no size floor, so 3 sells against 1 buy in five minutes on a quiet pool is "adverse flow".

Fix: `const hours = burnPerHour > 0 ? dayLeft / burnPerHour : Infinity;` and `fastPressure = last15.length >= 2 && fastSell >= Math.max(0.5, 2 * strategy.clip.maxSol) && fastSell > fastBuy * FAST_PRESSURE_RATIO`.

---

## MEDIUM

### M1. Own-share and participation use the pool's TOTAL volume as if it were external: the share is understated and the ceiling is circular
`apps/engine/src/desk.ts:539-541` (`externalVol24h = mean(history24h buy+sell) * 288; ownShare = own / (externalVol24h + own)`), `:557` (`extVolHourSol = (buy1h + sell1h) * 12`), source `packages/exec/src/feed.ts:78-111` (DexScreener `volume.m5` is all trades, Tenfold's included).

In live the snapshot flows include Tenfold's own fills, so `own` is counted twice: a real 25% share computes as 20% (alert, not stop); the stop at a computed 25% needs a real 33%. The participation cap grows with Tenfold's own sells (the memo, Rule 4 notes: "otherwise the participation ceiling is circular"). In the sim the flows are synthetic so the formula is accidentally right; the tests cannot see this.

Fix: `const total24h = mean(...) * 288; const ownShare = total24h > 0 ? Math.min(1, own / total24h) : 0;` and `extVolHourSol = Math.max(0, (buy1h + sell1h) * 12 - ownVolume1hSol)` with `ownVolume1hSol` added to `DeskInput` from `fills24h.filter(f.ts >= now - HOUR)`.

### M2. A noisy liquidity estimate flaps the clip and the pace every run; a 2.1x swing between two runs still pauses the project
`apps/engine/src/desk.ts:467-474` (clip from the single `snapshot.liquiditySol` with a 25% dead band), `:273-285` (the 5-min "now" median comes from quotes cached 60 s, `IMPACT_CACHE_MS` in `feed.ts:40`, so at most 5 distinct readings; the "then" median is the hour's first 15 minutes), `LIQUIDITY_SAMPLES_MIN = 2`.

Reproduced with the harness (auto, liquidity alternating 35 / 70 SOL between desk runs, as Jupiter's impact estimate does when routes flip): **96 `set_clip` and 31 `set_pace` decisions in 24 h** (every `liqSoft` flip zeroes the pace, the 1 h cooldown then re-enables it). At a 2.1x alternation the hard pause fires. The first review's H3 fix (medians on both ends) does not cover noise with a period longer than five minutes. When DexScreener's `liquidity.quote` is available the reading is stable and the risk is confined to tokens without a SOL-quoted pair, but that is where new launches live.

Fix: decide clip and liquidity from the hour's median (`median(lastHour.map(liquiditySol))`), not one snapshot; for the pull/soft tests require the "now" window to be 15 minutes and `LIQUIDITY_SAMPLES_MIN = 5`; never use the impact estimate for the hard pause (tag the snapshot with the source, e.g. `liquiditySource: "dex" | "impact"`, and only pause on `dex`).

### M3. The mark-to-market loss limit cannot fire with any sane day budget
`apps/engine/src/desk.ts:304-305` (`lossBreached = mtmLoss > (p.lossLimitPct / 100) * vaultValueSol` over the last 24 h of DEF fills).

With `maxDefenseSpendPerDaySol = 5` on a 240 SOL vault, the worst possible 24 h loss is 5 SOL and the limit is 4.8 SOL: the bought tokens would have to lose 96%. Reproduced: the down run bought 77,590 tokens for 10.85 SOL now worth 6.1 SOL (-44%) and never raised `loss_limit` (zero escalations in 72 h of -60%). The memo's second control, "defended-inventory unrealized-loss stop (15% of cost, balanced)", is not implemented at all and would have fired on day 2.

Fix: express the daily limit against the day budget or vault SOL (`mtmLoss > p.lossLimitPct/100 * vaultSolAtDayStart` or `> 0.5 * cfg.rules.maxDefenseSpendPerDaySol`), and add the inventory stop: `const costSol = lamportsToSol(defLifetime.spentLamports); const mark = tokensBoughtLifetime * price; if (costSol > 0 && (costSol - mark) / costSol > p.inventoryStopPct) rest`. Also give both a hysteresis: today `lossBreached` flips back as soon as the price recovers a little, so place/remove cycles every 15 minutes around the threshold are possible (the removal is announced each time, the escalation is throttled 24 h).

### M4. Realized vol is computed on 10 s quote samples while the 24 h vol uses 5-minute samples: in live the spread noise inflates `vol1h`, widens the ladder and fires "volatility spike" spuriously
`apps/engine/src/desk.ts:235-237` (`vol1h` from `lastHour`, every snapshot; `vol24h` from `history24h` downsampled to 5 min), `:238` (`baseDist = max(floor, sigmaMult * vol1h)`), memo Rule 2 ("sigma_1h is realized 1-hour volatility of 1-MINUTE returns").

Live prices are the mid of a 0.1 SOL buy and sell quote; a 1% spread bounces each 10 s return by up to 0.5%, which scaled by sqrt(360) is ~9%/h of pure noise. That makes `baseDist` 2 x 9% = 18% for a token whose true hourly vol is 2%, and `vol1h > 2 * vol24h` (`spike`) almost permanently, so every ladder is placed at 1.5x distance with half budget. The sim has no spread, so the backtest cannot show it; the first placement of every run already shows the regime jump the other way: the first ladder is placed with `vol1h = 0` (empty history) at the 5% floor, the next one 43 minutes later at 14 to 16% (`0.00h ... 5% to 18% under` vs `0.72h ... 47%`).

Fix: compute both vols on the same grid (downsample `lastHour` to 1-minute points before `realizedHourVol`), and do not place the first ladder until `lastHour.length >= 3` or `history24h` exists (use `vol24h` as the prior).

### M5. The desk and the status disagree on how much has been distributed
`apps/agent/src/actions.ts:227-230` (`f.side === "sell" && f.reason === "DIST"`), `apps/engine/src/runner.ts:586-589, 616` (all sells). After a day with REB sells the founder's `/status` shows e.g. "12% of the target" while the desk's catch-up factor and the daily report use 20%. Fix: drop the `reason === "DIST"` filter in `getStatus`.

### M6. Stale profile facts in the tool description and the wizard: "protect: two trailing levels", "balanced: one level"
`apps/agent/src/tools.ts:242`, `apps/agent/src/wizard.ts:58` (`Q_PROFILE`). `PROFILES` has `levels: 3` for all three profiles (`packages/core/src/mandate.ts:54,76,98`). The model repeats the description to founders and the wizard shows it on every onboarding. Fix: describe what differs now (distance 1.5/2/3 sigma, floor 3/5/8%, cooldown 5/15/30 min, participation 5/10/15%).

### M7. Dead-pool pace lines: "Distribution pace 0.00% → 0.00%" every hour
`apps/engine/src/desk.ts:556-574`. On a pool with a trickle of volume the participation cap yields a pace like 0.0003%/day; the next run's flow noise moves it by more than 15% relative, `paceCooldownOk` passes hourly, and the founder gets a line whose two numbers print as `0.00%` (`toFixed(2)`). Fix: floor the pace (`if (pace < 0.01) { pace = 0; notes.push("no real volume to sell into"); }`) and format with `toPrecision(2)` when under 0.1.

### M8. The engine's `runDesk` stale check ignores `rules`
`apps/engine/src/runner.ts:651` compares `strategy`, `mandate`, `paused` only. If the agent changed `rules` (`set_defense_budget`, `lower_daily_cap`) between the desk's read and write, the desk decided with the old cap/budget and writes `strategy` derived from them over the new rules; `saveProject` clamps the pace on disk but the in-memory `this.cfg` keeps the stale pace until the `reload` command lands (next tick) and the next desk run (up to 15 min). Fix: include `JSON.stringify(fresh.rules) !== JSON.stringify(this.cfg.rules)` in the condition.

---

## LOW

- L1 `apps/engine/src/desk.ts:320` three levels lost in one run produce three lines that contradict each other ("re-placing lower after a 15 min cooldown", "2 levels lost, rests 6 h", "3 levels lost, rests 12 h"). Compute `totalLost` once before the loop and write one sentence.
- L2 `apps/engine/src/runner.ts:713-739` `seedFromLedger` does not restore `lastProposal`, so an engine restart in ask mode re-emits the pending proposal at once; `lastEmitted` (the 10-min throttles) is not restored either.
- L3 `apps/engine/src/desk.ts:587-593` the `insider_sell` escalation offers "it was planned, resume distribution"; no tool can override `insiderSellRecent` (the zeroing lasts 24 h whatever the founder says). Offer only "keep on hold" or add `acceptedInsiderSellAt` to the mandate.
- L4 `apps/engine/src/desk.ts:289-290` with `defenseBudgetSol` set to 0 the block is skipped and the desk's levels stay in `defense.levels` (dead, shown as "(desk)" in `/status`, keeping a no-sell zone for 24 h). Set `defense.levels = keep.filter(pinned)` when `!defenseWanted`.
- L5 `KNOWN-RISKS.md:35-36` two claims are not what the code does: the participation cap is SKIPPED when volume reads zero (`desk.ts:558`), it does not "read zero volume (nothing sells)", and REB sells need no flow at all; "no repeats within 6h" in ask mode is only true at a constant price (H3).
- L6 `apps/agent/src/actions.ts:109` the comment "listEvents applies its limit before filtering by type" is stale since the H1 fix; `pendingCapRaises` can now use `listEvents`.
- L7 `apps/agent/src/wizard.ts:104` the callback regex accepts `tm:h:999:999`; a forged callback reaches `saveProject` and the founder sees the raw zod message through `Could not set the mandate: ...`. Clamp to the presets (`SHARE_PRESETS.some(...)`) before calling `setMandate`. Callback sizes (12 bytes) and the 15-min TTL are fine; `mayAct` gates groups.
- L8 `apps/engine/src/desk.ts:256-259` `startTokens` is the balance at the first funded look; a founder who funds in two transfers gets a target measured on the first half, and `distribution_done` fires early. Say so in the `mandate_started` sentence or re-measure while no sell has happened yet (`distributedSinceStart === 0n`).
- L9 `apps/engine/src/desk.ts:473` the clip sentence "one clip moves the price under 1.0%" is wrong when `CLIP_MIN_SOL` binds (a 5 SOL pool gets a 0.05 SOL clip = 2% impact).
- L10 `apps/engine/src/main.ts:22` with `TENFOLD_SIM=1` (500 ms ticks) the desk's 5000/20000-row limits give it 42 min of "6 h" history and 2.8 h of "24 h": trail-up can never fire (`heldAbove` needs 2.7 h) and `realizedHourVol` reads 34%/h at `--vol 0.004`, so the e2e sim exercises a different desk than production. Downsample in the ledger query or tick the sim at 10 s with a faster clock.
- L11 `apps/engine/src/runner.ts:651,667` the stale check and `changed` compare `JSON.stringify` of a zod-normalised file object with an in-memory object; key order is the same today only because the desk mutates existing keys in place. A `deepEqual` on `parseProjectConfig(this.cfg)` would be robust to a schema change that reorders keys (a false "file changed" would otherwise delay every decision by one tick forever).
- L12 `apps/agent/src/actions.ts:898-900` the confirmation closure captures `current.startTokens` at tool time; if the desk records `startTokens` during the 10-minute confirmation window, the Yes writes the mandate without it and the desk re-measures on the already-traded vault.

---

## Verified fixed (first review)

| Item | Status | Where |
|---|---|---|
| C1 target reached re-enables distribution hourly | Fixed | `desk.ts:491-498` (`done` branch, no pace logic, `horizon_unreachable` inside `else`); test `desk.test.ts:283` runs twice |
| C2 desk write clobbers the agent's save | Fixed | `runner.ts:648-657` re-reads, adopts the file's version, re-decides next tick; `config.ts:183-191` atomic write; test `desk.test.ts:434`. Residual: `rules` not compared (M8) |
| C3.1 bookkeeping not persisted in ask mode | Fixed | `runner.ts:660-672` (`mandate: out.mandate`, `paused: out.pause ? true : ...`) |
| C3.2 forced runs every tick | Fixed for `budget_low` (edge-triggered, `runner.ts:537-544`) and spaced to 60 s (`:607`); still every 60 s while a managed level is lost in ask mode (H3) |
| C3.3 no way to apply a proposal | NOT fixed; alert text still says "do it" (H3) |
| H1 listEvents LIMIT before type filter | Fixed | `ledger.ts:470-478` (SQL `type IN (...)`); test `desk.test.ts:515` |
| H2 spent level re-placed at the same price keeps its spend | Fixed for a single level | `types.ts:53` `placedAt`, `util.ts:74`, `desk.ts:447`. For the 3-rung ladder the replacement goes to the wrong rung (C1 above) |
| H3 liquidity pull from one sample | Fixed as specified (medians, >= 2 samples each side, soft tier at 0.7) | `desk.ts:273-285`. Residual: noise with a period over 5 min (M2) |
| H4 set_distribution undone by the desk | Fixed | `actions.ts:493-518` floor-only on a mandate, tool description `tools.ts:96`, prompt `brain.ts:41` |
| H5 set_mandate restarts on same value / wipes levels on floor change | Fixed | `actions.ts:891,899-900,933-939`; tests `mandate.test.ts:77,91` |
| H6 rebalance on by every mandate, outside the accounting | Partial | sells of any reason count (`runner.ts:616`), `describeMandate` names the SOL share (`mandate.ts:181`); REB still bypasses every stop (H2 above) |
| M1 two levels lost in one run | Fixed | `desk.ts:308-316, 352-363` (`lostNow` counter, managed levels dropped while resting, rest hours from `restMsFor`). Residual L1 (contradicting lines) |
| M2 trail-up stacks two levels | Fixed | `desk.ts:415-423` by rank with `sameLevel` against other kept levels; test `desk.test.ts:240` |
| M3 breathe on one 5-min sample | Partial | hour means used (`desk.ts:242-244`), but `min(dayLeft, ownLeft)` and a size-less `fastPressure` keep the trigger hair-fine (H5 above) |
| M4 budget_low forces every tick | Fixed | `runner.ts:539-543` |
| M5 snapshotsSince oldest rows, no `until` | Fixed | `ledger.ts:283-288` (DESC + reverse, `until`), `periodReport` passes `dayEnd` (`:795`) |
| M6 non-atomic writes, reload never retried | Fixed | `config.ts:188-190`, `runner.ts:477-489` (`RELOAD_MAX_ATTEMPTS = 5`); test `desk.test.ts:496` |
| M7 removing a desk level / last level disables defense | Fixed | `actions.ts:413-415, 427`, `desk.ts:289-291` |
| M8 "budget used up" on an empty wallet; defaults unreachable | Fixed | `desk.ts:261-270` (`unfunded`), `:379-400` (`no_sol` vs `budget_top_up`), profiles 20/60, 30/60, 50/100 at or under 0.5%/day, `acceptedSlowPace` (`types.ts:125`, `desk.ts:575`) |
| M9 desk decides while paused | Fixed | `runner.ts:605`, `desk.ts:220` |
| M10 docs | KNOWN-RISKS has a desk section (`:30-38`); two of its statements are inaccurate (L5). README/DEPLOY not re-checked here |
| M11 stale system prompt after set_mandate | Fixed | `bot.ts:107-116` (cache keyed on mode + mandate JSON + delay) |
| L1 trail window | Fixed (`desk.ts:405`) |
| L2 `round(x, 10)` | Fixed (`sig()` at `:186`) |
| L3 three messages per liquidity pull | Fixed (`alerts.ts:220`) |
| L4 CONFIRMED_TOOLS | Fixed (`tools.ts:64`) |
| L5 pinned marker in status | Fixed (`actions.ts:251`) |
| L6 add-project validation / ignored flags | Fixed (`add-project.js:94-120`) |
| L7 .env.example sim variables | Fixed (`:70-77`) |
| L8 log level read at import | Fixed (`log.ts:6-9`) |
| L9 reload uses loadProject directly | Fixed (`runner.ts:464`) |
| L10 "the floor" as a hard rule | Fixed (`brain.ts:49`) |
| L11 un-acknowledgeable escalations | Fixed for `horizon_unreachable` (acceptedSlowPace), `budget_top_up` throttled to 7 d |
| L12 bot token in HttpError log | Fixed (`bot.ts:312, 329-331`) |
| L13 "1h reference" on first run | Fixed (`desk.ts:232`) |
| L14 weekFromEvent daily fallback | Fixed (`alerts.ts:254-277`) |

---

## Missing tests

Tests that would have caught the new findings (each maps to an item above):

1. desk, C1: three-rung ladder, remove the TOP rung as `spent`, run again after the cooldown with the same anchor; assert a level exists within `1.1 * baseDist` of the anchor and none deeper than `3.5 * baseDist`. Same with `breathe`: the re-placed level must be ONE step below the removed one, not at the deepest rung.
2. desk, C1: `baseDist` at `MAX_LEVEL_DISTANCE` must still produce three rungs (today the third is silently skipped).
3. desk, H1: a lost or breathed level in the same run as a trail-up candidate → no `move_level`; a 3 h window held above with a negative 1 h return → no `move_level`.
4. strategies, H2: `proposeRebalance` with `distribution.enabled === false` on a mandate project, or price under `mandate.alertFloor`, returns no sell.
5. runner, H3: ask mode, price drifting 0.1% per desk run over 24 h → at most one `desk_proposal` batch per 6 h; a lost level in ask mode → at most one forced run per 6 h; `set_pace → 0` from an insider sell is applied in ask mode.
6. alerts, H4: `sell_pressure` and `budget_low` on a mandate project yield no message (or a statement without a question).
7. desk, H5: a top level with 1.25 SOL budget, day budget 5 SOL, excess sells 0.7 SOL/h → no breathe (memo rule: 7 h > 4 h); 3 sells vs 1 buy totalling 0.05 SOL in 15 min → no `fastPressure`.
8. desk, M1: snapshot flows that include own fills (`ownVolume24hSol` equal to the measured total) → `ownShare` = 1, not 0.5; participation cap unchanged when own volume is added to the hour's flow.
9. desk, M2: liquidity alternating 35/70 between runs → at most one `set_clip` per hour and no `set_pace` flip; no `pause`.
10. desk, M3: DEF bought 5 SOL of tokens now worth 2.5 SOL (-50%) on a 240 SOL vault with a 5 SOL day budget → the defense rests (today: no breach).
11. desk, M4: a 10 s series with +/-0.5% bid-ask bounce and no trend → `baseDist` at the profile floor, no `spike`.
12. agent, M5: `getStatus` horizon `donePct` equals `reportExtras` `donePct` after REB and MANUAL sells.
13. backtest regression: the 72 h `--drift -0.00002` run asserts `remove_level` <= `place_level`, no `place_level` deeper than `3.5 * baseDist`, no `move_level` in the same batch as a `remove_level`, and `sell_pressure` events not delivered to a mandate chat.
14. desk, M7: participation cap under 0.01%/day → pace 0 with a "no real volume" note, and no `set_pace` on the following runs.
15. runner, M8: `reloadConfig` returning changed `rules` while the desk has a stale `cfg` → the desk re-decides on the new rules before writing.

Existing tests whose expectations hide a problem: `desk.test.ts:402-417` ("re-runs only after the interval") and `:419-432` ("does not repeat the same proposal") both use a constant-price `Feed`; `:177-191` ("a spent level is re-placed with a fresh placedAt") uses a ONE-level ladder so the rank bug cannot show; `:193-204` ("lets a level breathe") asserts the re-placement lands at `ladder[0]`, which is only true because the ladder is again a single level.

---

## Resolution (same day)

Fixed in the commit that carries this file, with regression tests in `apps/engine/src/desk.test.ts`, `packages/strategies/src/strategies.test.ts`, `apps/agent/src/mandate.test.ts` and `apps/agent/src/wizard.test.ts`:

- C1: rungs are positions; each live level claims the rung it is closest to and only vacant rungs are placed (a spent top rung comes back at the top). The breathe step is persisted by the runner (`lastBreatheAt`, kept for `trailUpHours`) so the ladder sits one notch lower after a breathe. The deepest rung is capped at `MAX_LADDER_DEPTH` (40%) and the base distance scales down to fit, so three rungs always exist. The placement line prints the real distance under the anchor.
- H1: no trail-up in a run that removed a level, under adverse flow, after a 5-minute drop or on a down hour; the trail check uses the current price.
- H2: under a mandate, rebalance sells obey `distribution.enabled` and the alert line (`packages/strategies/src/rebalance.ts`); the desk's stops therefore hold REB too. Buys are unaffected.
- H3: in `ask` mode the runner applies the risk-reducing part of the decision (levels taken out, lower or zero pace, distribution off, smaller clip) and proposes the rest, each kind at most once per 6 h whatever the numbers; the proposal text no longer promises "do it". `lastProposed` is seeded from the ledger after a restart.
- H4: `sell_pressure` and `budget_low` are not relayed to a founder with a mandate.
- H5: breathe is measured against the day's budget; adverse flow needs size (mean 5-minute sells of at least 0.5 SOL or two clips).
- M1: own share is own over the pool's total; the participation ceiling nets own fills out of the hour's flow.
- M2: clip size from the hour's median liquidity, at most hourly; the liquidity pull needs 5 readings over 15 minutes on both ends and a pool reading (`liquiditySource: "dex"`), the quote-impact estimate only pauses distribution.
- M3: inventory stop (10% / 15% / 20% of cost, 24h window) next to the vault-value limit, with a one-day rest (`lastLossLimitAt`).
- M4: both volatilities on a one-minute grid; no ladder before ten minute-points or a known 24h vol (the runner re-evaluates every minute during that warm-up); a spike needs the hour's vol to exceed the floor distance.
- M5, M6, M7, M8, L1, L3, L4, L6, L7, L9: as described, plus the README / KNOWN-RISKS / DEPLOY wording.
- Not done: L2 `lastEmitted` seeding (10-minute throttles; harmless after a restart), L8 two-tranche funding, L10 sim history limits, L11 deepEqual, L12 confirmation closure. Listed in KNOWN-RISKS for the audit.

Backtests after the fix (same project and seeds): down run DEF 8.3 SOL (was 10.85), 2 loss-limit escalations (was 0), 20 decisions; up run 29 decisions; flat run 29. Ask mode on a drifting price: 4 proposals in 24 h (was 96). Liquidity alternating 35/70 between runs: one `set_clip`, no pace flip, no pause (was 96 + 31).
