# Tenfold code review, third pass: commit a22a97e ("Desk v2.1: second review fixes")

Scope: `/home/claude/tenfold/repo` at a22a97e. Build green (`tsc -b`), `npm test` 340 passed / 32 files. Read-only; nothing in the repo was edited. Everything marked "reproduced" was run against the built `dist` with scripts in `/tmp/claude-0/-home-claude/ac2f3ccf-047a-5080-8c4f-674f850c0b39/scratchpad/review3/` (`dump.mjs` for the three 72 h backtests, `rungs.mjs` for `decide()` experiments, `ask.mjs` for the ask-mode harness, `tier1.mjs`, `seed.mjs`, `trail.mjs`, `roundtrip.mjs`). Project `demo` (balanced, 30 %/60 d, cap 0.5 %, budget 20, 5/day), `--steps 25920 --tick 10 --seed 3 --vol 0.004 --sol 40`, drifts -0.00002 / +0.00002 / 0. Line numbers are in `src`.

Ranking as before: CRITICAL = loses founder money or intent silently in live; HIGH = wrong behaviour in normal use; MEDIUM = wrong under a realistic edge case or misleading; LOW = polish.

Summary: the commit is a real improvement (the deepest rung is capped, the loss controls fire, ask mode applies the stops, the questions stop) and the harness numbers in its message are reproduced. But three of its headline fixes do not do what they say in a moving market: the C1 fix ("a consumed or breathed top rung comes back at the top") produced 0 top-rung replacements out of 19 in the three backtests (16 went to the 40 % rung), the M4 warm-up is defeated by a row count (the first ladder goes up after 2 minutes of data in all three runs, exactly the sequence the warm-up was meant to stop), and ask mode now turns every temporary safety pause into a permanent one while the escalation text promises it will resume. The unit tests that cover these pass on constant anchors and 1-minute ticks, so they could not see it.

---

## Backtest evidence (requested runs, after the fix)

| drift | price | fills DIST / DEF / REB | DEF SOL spent -> mark | decisions | re-placements at the 40 % rung / at the 23 % rung / at the top | loss_limit rests | trail-ups |
|---|---|---|---|---|---|---|---|
| -0.00002 | -60.7 % | 57 / 61 / 12 | 8.30 -> 4.04 (-51 %) | 20 | 3 / 1 / 0 | 2 | 2 (both with a negative 3 h return) |
| +0.00002 | +10.8 % | 29 / 67 / 40 | 9.63 -> 9.25 | 29 | 6 / 2 / 0 | 1 | 7 |
| 0 | -34.0 % | 32 / 74 / 35 | 10.04 -> 6.83 | 29 | 7 / 0 / 0 | 2 | 5 |

In every run: the first ladder is placed at 0.03 h (2 minutes) at the 5 % floor distance with no volatility reading, the top rung breathes at 0.10 h ("today's budget would last 1.2 h"), and its replacement at 0.48 h lands at 40 % under the price with the deepest rung's budget share (1.96 to 2.00 SOL), "one notch lower after the breathe". `sell_pressure` events are still written (329 to 333) but not relayed under a mandate. No `set_pace` fired (symmetric sim flows), no `move_level` in the same batch as a `remove_level`, no decision repeated every 15 minutes, no `0.00% → 0.00%` line, no placement above the price or deeper than 40 %. Dumps: `review3/down-dump.txt`, `up-dump.txt`, `flat-dump.txt`.

---

## CRITICAL

None new. Nothing in the commit makes the desk spend beyond the founder's limits or sell against an explicit stop. The two items below that come closest (H1 and H2) are the previous review's C1 symptom at a 40 % cap and the previous M4 unfixed; the cap and the inventory stop bound the money.

---

## HIGH

### H1. The "rungs are positions" fix does not bring a consumed top rung back at the top: in the backtests 16 of 19 single re-placements went to the 40 % rung with the largest budget share, 3 to the 23 % rung, 0 to the top
`apps/engine/src/desk.ts:487-515` (rungs from the CURRENT anchor and the CURRENT `baseDist`; each live level claims its nearest unclaimed rung; the vacancy is placed with `p.split[r.rank]`).

The claim compares levels placed against an older anchor and an older volatility with a rung grid built from today's. When the top rung is consumed the price is at that rung, so the new anchor is one base distance lower and the surviving second rung is nearest to the new TOP rung; the only vacancy is the deepest one, which gets the deepest split (40 % of the day's budget for balanced). When the volatility regime changes (every run: the first ladder is at the 5 % floor, see H2, the next at 11.4 %) the survivors are nowhere near any rung and the result is the same. The founder is told "Level X has spent its 1.75 SOL. Re-placing it with fresh budget after a 15 min cooldown" and the fresh budget goes 40 % under the price.

Reproduced, down run:
```
0.10h remove_level breathe 0.0001871 :: ... Letting it breathe: the ladder steps down one notch.
0.48h place_level  :: Placed a defense level at 0.0001138 (1.96 SOL): 40% under the current price 0.0001897, sized for a 8%/h market, one notch lower after the breathe.
2.48h remove_level spent 0.0001772 :: Level 0.0001772 has spent its 1.75 SOL. Re-placing it with fresh budget after a 15 min cooldown.
2.91h place_level  :: Placed a defense level at 0.0001048 (1.26 SOL): 40% under the current price 0.0001746 ...
46.63h remove_level spent 0.0001569 :: ... Re-placing it with fresh budget ...
47.01h place_level  :: Placed a defense level at 0.00008983 (0.80 SOL): 40% under the current price 0.0001497 ...
```
Up run, 29.75h spent top 0.0003493 -> 30.02h placed at 0.0001943 (40 % under); flat run 29.49h -> 29.75h, 64.01h -> 64.45h, 68.76h -> 69.16h: all at 40 %. `rungs.mjs` case B (anchor fell by one base distance, top spent) and case C (floor -> 11.4 % regime, top spent) reproduce it with `decide()` alone: B gives levels at 5.3 / 13.2 / 17.5 % with the new 2.00 SOL at 17.5 %; C gives 9.1 / 16.7 / 39.4 % with the new 2.00 SOL at 39.4 %. Case E (a level midway between two rungs) places the other rung 2.5 % away from it, two levels 2.5 % apart and nothing within 7.5 % of the price.

Why the test did not catch it: `apps/engine/src/desk.test.ts:214` keeps the anchor and the volatility constant between the removal and the replacement; that is the only configuration in which "nearest rung" and "the rung it was placed on" coincide.

Fix: carry the rung on the level, not infer it. Add `rank?: number` to `DefenseLevel` (set at placement and on trail-up); claim `rank` when present and fall back to nearest only for levels without one. Then re-place the vacant rank with its own split, and re-anchor the whole ladder only through trail-up (up) or the lost rule (down). Also treat a rung as occupied when a level is within `baseDist / 2` of it (the previous review's `vacant` filter), so case E cannot stack. And give the replacement the split of the rank it fills, but computed on the budget that remains for the DAY divided by the vacant ranks, not `ladderBudget * split[rank]` of a budget that was mostly deployed already (today the single replacement at rank 2 gets 40 % of `min(budgetable, dayLeft)` while the two survivors still hold theirs).

### H2. The volatility warm-up is defeated by a row count: the first ladder goes up after 12 ticks (2 minutes at 10 s) with no volatility reading, which is exactly the cascade the warm-up was meant to prevent
`apps/engine/src/desk.ts:263-265` (`vol24h` defined when `history24h.length >= 12`; `volReady = minutePts.length >= 10 || vol24h !== undefined`), `apps/engine/src/runner.ts:617` (`history24h = downsample(snapshotsSince(now - DAY, 20000), 288)`: nothing is downsampled under 288 rows, so 12 rows is 12 ticks).

At 10-second ticks (live and the backtest) a brand-new project has 12 rows two minutes in; `minuteGrid` collapses them to 2 or 3 points, `realizedHourVol` returns 0 or noise, `vol24h` is "known", `volReady` is true, `vol1h = vol24h ≈ 0` and the ladder is placed at the profile floor (5 / 10 / 17.5 %) on a token whose realized vol is 8 %/h. All three runs: `0.03h Placed 3 defense levels ... 5% to 18% under the current price` (no "sized for" suffix), `0.10h breathe`, `0.48h` replacement at 40 % (H1). With `TENFOLD_SIM=1` (500 ms) 12 rows is six seconds. Reproduced with `decide()` (`rungs.mjs` case F): 12 rows spanning 2 minutes as `history24h` -> `place_level`; 11 rows -> nothing; same 12 rows without `history24h` -> nothing.

Why the tests did not catch it: `desk.test.ts:322` ("no ladder at all before ten minutes") omits `history24h`; the runner test `desk.test.ts:565-574` (`warm()`) ticks once a MINUTE, so `history24h` reaches 12 rows at minute 12, which happens to agree with the ten-minute claim.

Fix: gate on span, not count: `const span24 = history24h && history24h.length >= 12 ? history24h[history24h.length - 1]!.ts - history24h[0]!.ts : 0; const vol24h = span24 >= HOUR ? realizedHourVol(minuteGrid(...)) : undefined;` (an hour of 24 h history is the least that makes `vol24h` a prior). Add a 10-second-tick variant of the runner warm-up test.

### H3. Ask mode makes every safety pause permanent, and the escalation text says it will lift by itself
`apps/engine/src/runner.ts:674-677, 832-845` (`riskReducing(set_pace)` is `to < from`; a `set_pace` from 0 back to the mandate's pace is "adds exposure" and only proposed), `apps/engine/src/desk.ts:674` ("it resumes by itself after that"), `:611` ("Distribution is off until price is back above it"), `:626` ("It resumes when real volume comes back"), `apps/agent/src/actions.ts:493-498` (`set_distribution` under a mandate changes only the floor).

After an insider sell, a soft liquidity drop, a tier-1 drop, the alert floor or the own-share stop, the desk zeroes the pace (applied in ask mode, correctly). When the condition clears, the desk decides `set_pace 0 → 0.5`, which is proposed (once per 6 h) and never applied; `set_distribution` cannot re-enable under a mandate; the only ways out are switching the mandate to `auto` or changing profile/share/horizon (which restarts the horizon clock and re-measures `startTokens`). Reproduced (`ask.mjs auto2ask-insider`): insider sell at 2.18 h -> `set_pace 0.5 → 0` applied; at 26.18 h `desk_proposal set_pace 0 → 0.5`; distribution still `enabled: false` at 27 h and for good. The founder was told "on hold for 24h ... it resumes by itself after that".

Fix: the reversal of a desk-made safety zero is bookkeeping, not new exposure. In `riskReducing`, treat `set_pace` as applicable when `c.from === 0 && c.to <= basePacePct(mandate, cfg.rules.dailySellCapPct)` (the pace the founder agreed to) and make `safeSubset` copy `distribution.enabled`/`pctOfVaultPerDay` for that case; or mark the zero in the strategy (`distribution.pausedByDesk: true`) and let `safeSubset` lift exactly that. Until then, change the three escalation texts under `autonomy === "ask"` to say the founder has to switch the mandate to auto to resume.

---

## MEDIUM

### M1. The tier-1 breaker reaches the desk only if a desk run happens to land within 5 minutes of the drop
`apps/engine/src/desk.ts:280-281` (`drop5m` from `rolling.price5mAgo`), `apps/engine/src/runner.ts:535-539` (the desk is forced on a lost level or on sell pressure, not on a price drop), `packages/core/src/ledger.ts:457` (`price5mAgo` = the snapshot at or before now - 5 min).

A one-tick -15 % with flat flows afterwards (a single large sell, then quiet) produced `set_pace 0 / remove_level rest` for drop offsets 7, 9 and 11 minutes after the previous run (the next run was 4, 2 and 0 minutes later) and nothing for offsets 1, 3, 5 and 13 (`tier1.mjs`): roughly one chance in three. With one-sided selling after the drop the pressure detector forces the run within 50 s and it fires every time. In the ask-mode `crash` harness (-30 % in one tick) tier-1 never fired and distribution kept selling at the cap. Note also that a tier-1 "rest" has no duration: `lastLevelRemovedAt` gives a 15-minute cooldown and the ladder is re-placed at the next run once `price5mAgo` has caught up.

Fix: in `runDetectors`, `if (this.cfg.mandate && rolling.price5mAgo && (rolling.price5mAgo - snapshot.price) / rolling.price5mAgo >= TIER1_DROP) this.deskForce = true;` and record `lastTier1At` so the rest holds for, say, `p.cooldownMin * 4`.

### M2. The one-day loss rest is recorded only as a side effect of removing a live level: a breach with no live managed level leaves no `lastLossLimitAt`, and the ladder is re-placed as soon as the loss dips under the threshold
`apps/engine/src/desk.ts:398-415` (`remove_level` with cause `loss_limit` only for levels in `keep`; the escalation fires regardless), `apps/engine/src/runner.ts:693` (`lastLossLimitAt` set only from an applied `loss_limit` remove), `:756-757` (seeded only from that event).

Reproduced with `decide()` (`rungs.mjs` case G): defense bought 5 SOL now worth 2.5, no live level (consumed, in cooldown, or day budget exhausted) -> decisions `[]`, escalation `loss_limit` ("The defense rests for a day"); next run with the loss at 14 % and no `lastLossLimitAt` -> `place_level` of a full 3-rung ladder. The hysteresis the commit describes exists only when a level was live at the moment of breach. In the backtests it happened to be live every time; in live, levels are often absent exactly when the loss is realised (all spent, cooldown running).

Fix: make the rest a desk output, not an inferred one: add `rest?: { kind: "loss_limit"; at: number }` to `DeskOutput` (set whenever `lossNow`), have the runner set `lastLossLimitAt` from it and seed it from the `desk_escalation` topic `loss_limit` as well as the remove. Also guard placement when the loss is within 20 % of the stop (`mtmLoss / spent24 > 0.8 * p.inventoryStopPct`): the flat run placed a level at 31.49 h and removed it as `loss_limit` at 31.53 h.

### M3. Trail-up still lifts the ladder into a falling market: the "down hour" check is one 10-second sample an hour ago, and "held above for 3 h" is trivially true for a level 40 % under
`apps/engine/src/desk.ts:455-461` (`hourStart = lastHour[0]?.price`, a single 10-second sample; `heldAbove` only needs the 3 h window above `top * (1 + (trailUpSteps - 1) * baseDist)`, one base distance above the top level, which for a level sitting 23 to 40 % under the price is always true; the `low1h` check of the previous version was REPLACED by `snapshot.price > trailAt`, not complemented, so a dip inside the hour no longer blocks the lift).

Reproduced (`trail.mjs`, down run): the two trail-ups fired at 6.33 h (1 h return +5.7 %, 3 h return -11.7 %) and 51.54 h (+1.4 % / -5.4 %); the second was followed by a breathe of the lifted level at 53.39 h and the loss stop at 57.07 h. In the up run the trail-up at 7.43 h shared its batch with a `place_level` at 40 % under with 0.50 SOL (the minimum): the lift moved the survivors onto ranks 0 and 1 and the vacancy (H1) was filled at the bottom.

Fix: require a non-negative return over the trail window and over the hour by medians, not single samples: `trailWindow[0]!.price <= snapshot.price && median(lastHour.slice(0, lastHour.length / 2)) <= median(lastHour.slice(lastHour.length / 2))`; and make `heldAbove` use `trailUpSteps` (the same distance the sentence claims), so "held more than 23 % above for 3 h" is what was checked.

### M4. "Breathe" is measured on the pool's whole net selling, not on what the desk would spend: the top rung breathes six minutes after placement in all three runs, and in a 55/45 pool
`apps/engine/src/desk.ts:276` (`burnPerHour = (sell1h - buy1h) * 12`: the pool's excess sell flow), `:381-383` (`hours = dayLeft / burnPerHour < p.breatheUnderHours`).

The desk's spend on that level is bounded by the level's own 1.25 SOL and by the risk engine's day budget; "costs about 3.9 SOL/hour" is the pool's net selling, which the desk is under no obligation to absorb and could not (the level would be spent, not the day). With a 5 SOL day budget and `breatheUnderHours = 4`, any hour-mean excess selling above 1.25 SOL/h breathes the top rung: on a 2 SOL / 5 min pool that is a 55/45 split (`rungs.mjs` case H: "costs about 2.40 SOL/hour ... would last 2.1 h", breathe). All three backtests: `0.10h breathe ... costs about 3.9 SOL/hour ... would last 1.2 h` with one DEF fill done. The H5 fix changed the numerator's denominator (day instead of rung) but the rate is still the market's, so the top rung is removed on first contact and replaced per H1.

Fix: bound the burn by what the level can actually absorb: `const absorb = Math.min(burnPerHour, (HOUR / DEF_MIN_GAP_MS) * strategy.clip.maxSol, ownLeft * 2)` and use `dayLeft / absorb`; or measure the realised spend rate from `recentOrders` on that level over the last 15 minutes and breathe on that.

### M5. After a breathe the ladder does not come back up when the step expires: three levels at 2d / 3.5d / 4.5d fill the count, so the top rung stays vacant until a trail-up or a consumed level
`apps/engine/src/desk.ts:487` (`liveLevels.length < p.levels` gates the whole placement block), `:488-492` (the step-down only shifts the grid for VACANT rungs; survivors are never moved).

The breathe removes the top level; the survivors (2d, 3.5d) "claim" rungs 2d and 3d of the lowered grid and the vacancy 4.5d is filled (the test at `desk.test.ts:214` asserts exactly this: `bp[2] ≈ P(1 - d1 * 4.5)`, 22.5 % under for a level the founder was told steps down "one notch"). When `trailUpHours` pass, the grid is back to d / 2d / 3.5d but the count is full and nothing is placed or moved (`rungs.mjs` case D). Trail-up repairs it only after a quiet 3 h with a non-negative hour (M3), so in a choppy or drifting market the ladder sits a notch low indefinitely. Also, when `MAX_LADDER_DEPTH` binds (any vol above 5.7 %/h for balanced) the step-down changes nothing for the deepest rung and the line still prints "one notch lower after the breathe" (case C2: identical levels with and without `lastBreatheAt`).

Fix: after a breathe move the survivors down one rank too (`move_level`) so the ladder is a ladder, and when the step expires let the placement block run when any rank is unclaimed even at full count (place the top, drop the deepest with cause `refresh`). Print "one notch lower" only when `stepDown` changed the price.

### M6. History rows carry no `liquiditySource`: when DexScreener drops out mid-hour the impact estimate is compared with the pool reading and distribution is paused on a source flip, not a liquidity change
`packages/core/src/types.ts:257` ("Not persisted"), `packages/core/src/ledger.ts:249-265` (no column), `apps/engine/src/desk.ts:305-318` (`liqNow`/`liqThen` medians over rows of unknown source; only the live snapshot's source gates the HARD stop; `liqSoft` has no source gate), `:536` (`liqForClip` mixes them too).

The two readings are different quantities (DexScreener's `liquidity.quote` of the deepest pair versus `1 SOL / Jupiter priceImpactPct` over whatever route Jupiter picks). An hour with DexScreener up then down (rate limit, 429) gives `liqThen` = pool reading, `liqNow` = impact estimate; a 30 % gap pauses distribution ("pool liquidity is down to X SOL from Y an hour ago") and the hourly clip changes. The commit's statement "the quote-impact estimate only pauses distribution" is true and is the problem: it pauses it spuriously. By reading; the sim always reports `dex`.

Fix: persist the source (`liquidity_source` column, `rowToSnapshot`), and compare like with like: `const src = snapshot.liquiditySource; liqNowSamples/liqOldSamples = lastHour.filter(s => s.liquiditySource === src && ...)`; same for `liqForClip`. Until the column exists, skip the soft stop when `snapshot.liquiditySource === "impact"`.

### M7. The whole day budget is still deployed in the first ladder and consumed in four hours; the defense is then dead for the rest of the day while the price keeps falling
`apps/engine/src/desk.ts:505` (`ladderBudget = Math.min(budgetable, dayLeft)`), `:487` (`dayLeft >= MIN_LEVEL_BUDGET_SOL` gates re-placement).

Unchanged from the previous review's C1 note (not claimed as fixed, but it is what makes H1 and M4 expensive). All three runs: 1.25 + 1.75 + 2.00 = 5.00 SOL placed at 0.03 h, consumed by 4.2 h (`2h DEF buy=13, 3h 10, 4h 4`), then `4.19h remove_level spent 0.0001625 :: ... Re-placing it with fresh budget after a 15 min cooldown` and no placement until 24 h or 33 h: the promise is false and the defense sits out 20 hours of a -25 % move. In the up run the 7.43 h and 33.11 h replacements got 0.50 SOL (the minimum) because that was all the day had left.

Fix: pro-rate: `ladderBudget = Math.min(budgetable, dayLeft * Math.max(0.25, hoursLeftInDay / 24))` or a fixed share per placement (`dayLeft / 3` for a full ladder, `dayLeft / 2` for one rung), and say "no budget left today; the ladder returns tomorrow" instead of "re-placing" when `dayLeft < MIN_LEVEL_BUDGET_SOL`.

### M8. The inventory stop is calibrated at the same distance as a lost level, so one lost top rung with spend rests the whole defense for a day; the "two levels lost -> 6 h rest" rule is now unreachable in practice
`packages/core/src/mandate.ts:84, 91` (`maxDistanceBelowPct: 15`, `inventoryStopPct: 0.15` for balanced; same coincidence for protect 12/10 and distribute 20/20), `apps/engine/src/desk.ts:349`.

A level that bought at its price and is then "lost" (price 15 % under) has, by construction, a 15 % mark-to-market loss on that spend, so `lossNow` fires on the first lost level and the day-long rest and "Heads up" escalation pre-empt the 6-hour trend rest. Backtests: 6 `loss_limit` rests, 0 `trend_down`. In the flat run the defense rested 24 h twice (31.5 h, 70.1 h) on 15 % and 18 % loss readings in a market with 7 %/h realized vol, where a 15 % dip is under two hourly sigmas. This may be the intended conservatism, but then `restHours` and `LOST_LEVELS_BEFORE_REST` are dead configuration and the memo's "15 % of cost" is being applied to a 24 h window of buys that were made 5 to 17.5 % apart. Decide which control owns the first lost level; if the inventory stop does, set `inventoryStopPct` above `maxDistanceBelowPct` (e.g. 0.20 balanced) so a single rung does not trip it, or measure the stop on the ladder's average cost against the deepest rung rather than against the price.

### M9. DEF buys and REB sells still form round trips at the five-minute boundary
`packages/strategies/src/rebalance.ts:64-69` (the new gates are `distribution.enabled` and the alert floor; the only distance from an own buy is `REB_OPPOSITE_SIDE_COOLDOWN_MS` = 5 min and the 1 % no-sell zone).

Up run (`roundtrip.mjs`): 40 REB sells, 12 within an hour of a DEF buy, 5 at exactly 5.0 minutes after one (sizes 0.001 to 0.006 SOL: cap dust). DEF buys at `price <= level * 1.005`, REB sells at `price > level * 1.01`: a price oscillating 1 % around a level alternates the two every five minutes (Rule 24 of the calibration memo). The commit's REB gate is right as far as it goes; this residual of the previous H2 is untouched. Fix: under a mandate, no REB sell while any managed level was bought in the last `p.cooldownMin` minutes (`levelDefendedRecently` over the last 15 min rather than 24 h), and drop REB sells under `clip.minSol` (dust).

---

## LOW

- L1 `apps/engine/src/desk.ts:374, 367` under `autonomy: "ask"` the applied `remove_level` lines promise "Re-placing it with fresh budget after a 15 min cooldown" / "re-placing lower"; the re-placement is only ever proposed, and in the harness (`ask.mjs auto2ask-crash`) two such lines were followed by no proposal at all for 21 h (day budget gone, M7). Phrase the removal line from `autonomy`.
- L2 `apps/engine/src/runner.ts:700-705` identical proposals repeat every 6 h for ever (crash harness: the same three prices at 6.18 h, 12.18 h, 18.18 h). Keep the per-kind throttle but skip a proposal whose `change` equals the last emitted one of that kind (the old key, now as a second filter).
- L3 `apps/engine/src/desk.ts:560-564` after a profile change in ask mode `set_boost` is decided every run (the strategy never receives it) and proposed every 6 h for ever. `set_boost` only reshapes clips inside the pace; classify it as bookkeeping (apply in both modes).
- L4 `apps/agent/src/alerts.ts:106-109` under a mandate `cap_reached` fires once a day by design (the desk paces at the cap when `distributePct / horizonDays >= cap`, as in the demo project) and the founder reads "Daily sell cap reached ... Raising the cap takes 48h if you want more" every morning (3 per run). Under a mandate make it one neutral line or leave it to the daily report.
- L5 `apps/agent/src/alerts.ts:111-115` (pre-existing, relevant to question 7) the circuit-breaker line says "All orders are on hold until you say "resume" and confirm"; `packages/core/src/risk.ts:98-107` only rejects orders while the 5-minute move is over the limit and nothing is paused, so orders resume by themselves five minutes later. Under a mandate this is the one remaining question the desk does not answer and the founder cannot act on.
- L6 `apps/engine/src/desk.ts:536-542` the first `set_clip` of every project is derived from one reading (the first tick: `0.00h set_clip 0.50 → 0.25`), although the line says "the pool's 50.0 SOL" as if it were the hour's median. Require `LIQUIDITY_SAMPLES_MIN` samples for the clip too, or say "first reading".
- L7 `packages/exec/src/feed.ts:321-336` the sim's flows do not include Tenfold's own fills, so after M1 of the previous review the own-share and participation formulas are now wrong in the opposite direction in backtests (`own / total` with `total` excluding own). Harmless at these sizes (own is 1 to 2 % of 576 SOL/day) but the backtest no longer models the live formula; add own fills to `SimFeed.snapshot` flows via `applyFill`.
- L8 `apps/engine/src/runner.ts:827-829` the doc comment "Keep at most `max` evenly spaced items..." now sits above `PROPOSAL_MIN_INTERVAL_MS` instead of `downsample`.
- L9 `apps/engine/src/desk.ts:398-408` a tier-1 `rest` removes the ladder but nothing records it; the ladder is re-placed at the first run after the 15-minute cooldown once `price5mAgo` has caught up (M1). Say "for 15 minutes" or hold it for longer.
- L10 `apps/engine/src/desk.test.ts:214, 565-574, 322` the three tests that guard H1 and H2 pass for the wrong reason (constant anchor and floor distance; 1-minute ticks; `history24h` omitted). Add: a replacement after the anchor fell by one base distance must land at rank 0; twelve 10-second rows must not make `volReady`.
- L11 REB sells of 0.001 to 0.006 SOL (`MIN_ORDER_LAMPORTS`) when the cap remainder is dust (up run, 6 of 40). Pre-existing; floor REB at `clip.minSol`.

---

## Verified OK

- Build green, 340 tests pass. No TypeScript slip in the diff: every new constant is used (`FAST_PRESSURE_MIN_SOL`, `LIQUIDITY_WINDOW_MS`, `MAX_LADDER_DEPTH`, `VOL_WARMUP_POINTS`, `CLIP_CHANGE_MIN_INTERVAL_MS`, `PACE_FLOOR_PCT`, `PROPOSAL_MIN_INTERVAL_MS`), imports (`StrategyConfig`, `DeskChange`, `DeskDecision`) are used, no shadowed variable in `decide()` or `runDesk()`, `fmtPct` handles 0 and sub-0.1 values, the ladder cap arithmetic (`MAX_LADDER_DEPTH / deepestMult`, `min(0.4, baseDist * steps)`) yields three distinct rungs with and without the step-down.
- Rung geometry: no rung above the current price (anchor = min(ref, price)), none deeper than 40 % (max seen 40 %), never more than 3 managed levels (count bound at `:508`, pinned levels excluded), trail-up targets capped the same way (`:465`).
- No `move_level` in the same batch as a `remove_level` in any run (`marketTurning` includes `removedNow`); no decision repeated every 15 minutes; no `0.00% → 0.00%`; `set_pace` never fired on symmetric flows; `PACE_FLOOR_PCT` and the "no real volume" line work (`desk.test.ts` dead-pool test).
- Ask mode: 4 `place_level` proposals in 24 h on a drifting price (was 96), per-kind throttle holds; `remove_level` and `set_pace → 0` are applied; `safeSubset` keeps `clip.minSol <= clip.maxSol`, never drops a pinned level, never re-enables distribution or raises the pace; `set_clip` with `to < from` applied consistently in both modes; a restart does not re-emit a pending proposal (`lastProposed` seeded from `desk_proposal` events, verified).
- Persisted timestamps: `lastBreatheAt`, `lastLossLimitAt`, `lastClipChangeAt`, `lastLevelRemovedAt` are restored from the ledger on restart (`seed.mjs`); the loss rest held for exactly 24 h across a restart; a breathe 5 h old on a profile with `trailUpHours` 2 is not applied (`now - lastBreatheAt < trailUpHours * HOUR`); the first ladder after a restart with a full ledger is placed on the first tick (and one notch lower when a breathe is within `trailUpHours`).
- Vol warm-up when the ledger is full (restart, or a paper project that just got a mandate): `volReady` at once from a real `vol24h`; `TENFOLD_SIM=1` (500 ms, 5000 newest rows = 41 min) still has 41 minute-points for `vol1h`; the runner's forced minute runs stop once `history` spans 11 minutes.
- Liquidity windows at 10-second ticks: about 90 samples in each 15-minute window (>= 5); `history` excludes the current snapshot (`until: now - 1`) which `decide()` adds itself; 5000 rows cover 13.9 h >= 6 h, 20000 cover 55 h >= 24 h. `liquiditySource` is read only from the live snapshot, which is the only place the hard stop needs it; the sim marks every snapshot `dex`.
- Rebalance: under a mandate no REB sell when `distribution.enabled` is false (desk zero, `distribution_done`, "sell nothing" mandate) or under the alert floor; REB buys are not gated and none were wrongly blocked (0 REB buys in the three runs, by reading the buy branch is untouched); without a mandate REB is unchanged.
- Alerts under a mandate: `sell_pressure` and `budget_low` are not relayed (`formatEvent` returns `undefined`; the events are still written and still force the desk). `level_hit`, `order_filled` (DEF > 0.5 SOL only), `order_rejected` (10-minute throttle, none in the runs), `order_failed`, `paused`/`resumed`, `daily_report`, `insider_sell`, `desk_decision` ("Desk: ..."), `desk_escalation` (with options, by design) still reach the founder; the only remaining question text that the desk does not own is the circuit breaker's (L5) and `cap_reached`'s hint (L4).
- Wizard accepts only its presets and the `0:30` "only defend" button; `getStatus` counts every own sell (test); the stale check includes `rules` (test); `pendingCapRaises` comment updated.
- Backtest totals match the commit message (down run DEF 8.3 SOL, 2 loss-limit escalations, 20 decisions; up 29; flat 29).

## Missing tests (one per finding)

1. H1: ladder placed at anchor A; price falls to A(1 - d) and consumes the top rung; replacement run with `history` at the new price -> a level within `1.1 d` of the new anchor; none deeper than `3.5 d`. Same with the volatility doubled between the two runs.
2. H2: 12 snapshots 10 s apart as `history` and `history24h` -> no `place_level`; 61 one-minute snapshots -> `place_level`.
3. H3: ask mode, insider sell, 25 h later -> distribution enabled again (once the semantics are decided) or the escalation text says it will not be.
4. M1: a -15 % one-tick drop 12 minutes after a desk run -> `set_pace 0` within one tick.
5. M2: inventory stop with no live level -> `lastLossLimitAt` set (runner) and no `place_level` for 24 h.
6. M3: 3 h window with -10 % return and a +2 % last hour -> no `move_level`.
7. M4: 55/45 flow on a 2 SOL / 5 min pool, one 0.25 SOL clip every 20 s -> no breathe.
8. M5: `lastBreatheAt` older than `trailUpHours` with three levels at 2d / 3.5d / 4.5d -> the top rung is restored.
9. M6: history rows `impact` at 200, live `dex` at 100 -> no `liqSoft`.
10. Regression on the 72 h down backtest: count of `place_level` deeper than `2.5 * baseDist` after a `spent`/`breathe` of the TOP rung must be 0; `move_level` only when the 3 h return is >= 0.

---

## Resolution (same day)

Fixed in the commit that carries this file (tests in `apps/engine/src/desk.test.ts`, `apps/engine/src/runner.test.ts`, `packages/strategies/src/strategies.test.ts`):

- H1: every level carries its rung (`DefenseLevel.rank`, set at placement and kept on trail-up); a level claims its own rank, legacy levels fall back to the nearest free rung; vacancies are placed at their rank with that rank's split. A placement deploys at most 60% of the day's remaining budget (`LADDER_DAY_SHARE`), the rest stays for re-placements (M7). The "spent" line says when today's budget will not refill the rung.
- H2: the 24h volatility is a prior only when the 24h history spans at least an hour (`VOL24_MIN_SPAN_MS`); runner test at 10-second ticks.
- H3: in `ask` mode the lifting of a desk-made safety zero back to at most the mandate's agreed pace is bookkeeping and is applied; `set_boost` too. Identical proposals are never repeated (L2, L3).
- M1 / L9: the runner forces the desk on a 10% five-minute drop and records `lastTier1At`; the desk holds defense and distribution for an hour after it.
- M2: `DeskOutput.lossRest` is set whenever the loss controls fire; the runner records `lastLossLimitAt` from it (and seeds it from the escalation after a restart), so the one-day rest holds with no live level.
- M3: trail-up needs the hour's second-half median at or above the first half's, the trail window's return not negative, no dip under the reference, and the whole window above the trail point.
- M4: breathe is measured on the desk's own fills on the level over the last 15 minutes (what it actually absorbs), not on the pool's net flow; adverse flow of size remains the other trigger. The level steps aside for `trailUpHours`; the next rung holds; the top rung comes back at the top afterwards (M5). No placement at the deepest rung after a breathe.
- M6: `liquidity_source` is persisted (additive column); the pull, the soft stop and the clip compare readings of the same source as the live one; the clip needs 5 samples (L6).
- M8: `inventoryStopPct` raised above `maxDistanceBelowPct` (0.15 / 0.20 / 0.25), so one lost rung goes through the lost rule and a slow bleed through the stop.
- M9 / L11: under a mandate no rebalance sell within 15 minutes of a defense buy, and none smaller than the minimum clip.
- L1: removal lines say "will be proposed" under `ask`. L4: `cap_reached` is one neutral line under a mandate. L5: the circuit breaker now pauses the project (the alert says so); the founder resumes it.
- Not done: L7 (own fills in the simulator's flows), L10 (sim history limits), L12 (confirmation closure). Listed in KNOWN-RISKS.

Backtests after the fix (same project and seeds): down run DEF 5.8 SOL of 20 (was 8.3), 1 loss-limit rest, 22 decisions, spent top rungs re-placed at the top; up run DEF 6.1, REB 19 sells (was 40); flat run DEF 4.8. 345 tests.
