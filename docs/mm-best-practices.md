# Market-making best practices for Tenfold (founder-side AMM market maker)

Research memo, 2026-11-04. Scope: what the practitioner and academic literature says a market maker should do, translated into Tenfold's actual levers (defense levels, level budgets, breathe/rest rules, distribution pace, inventory target and band, clip size vs pool depth, slippage, adverse-selection detection, volatility regimes, loss limits and kill switches, reporting).

Tenfold is not an order-book quoter. It buys with SOL at defense levels under the price, sells founder supply into real buy flow under a public daily cap, and rebalances token/SOL toward a target. Everything below is mapped onto those three actions. Where a number comes from a source it is attributed; where it is our own calibration it is marked **(inference)**.

Hard constraints (never violated, see section 4): no wash trading, no self-matching, no fake volume, no trading around the founder's hard caps.

---

## 1. Rules to implement or tune

### Rule 1. Separate the two knobs: inventory shifts the center, volatility and liquidity set the distance

- **Principle.** In Avellaneda and Stoikov (2008) the optimal quotes are centered on a *reservation price* r = s − q·γ·σ²·(T−t) and the *spread* δa+δb = γσ²(T−t) + (2/γ)·ln(1+γ/κ) does not depend on inventory at all. Inventory moves the center; volatility (σ), risk aversion (γ) and book liquidity (κ) set the width.
- **Source.** [High-frequency trading in a limit order book (Avellaneda and Stoikov)](https://math.nyu.edu/~avellane/HighFrequencyTrading.pdf); [Hummingbot technical deep dive into Avellaneda and Stoikov](https://hummingbot.org/blog/technical-deep-dive-into-the-avellaneda--stoikov-strategy/).
- **Tenfold mapping.** Keep a single "reference price" that the desk manager shifts by inventory, and compute level distance and distribution gates from that reference instead of from raw mid. Today the reference is min(1h median, current). Add an inventory term: reference = min(1h median, current) × (1 − skew), skew = γ_profile × q_norm × σ_1h, where q_norm ∈ [−1, +1] is the vault's deviation from the target SOL share divided by the band half-width (token-heavy = positive). Level distance stays a function of σ_1h and pool depth only (Rule 2 and Rule 5). **(inference on the exact form; the separation of center and width is the paper's result.)**
- **Numbers.** γ_profile in sigma units: protect 0.5σ, balanced 1.0σ, distribute 1.5σ. A fully token-heavy balanced vault therefore places defense 1σ deeper and relaxes the distribution gate by 1σ; a fully SOL-heavy one does the reverse. **(inference)**

### Rule 2. Scale distances with realized volatility and widen in high-vol regimes

- **Principle.** Both terms of the A&S spread scale with σ² (and the inventory shift with σ²·(T−t)). Hummingbot's implementation estimates σ from a rolling buffer (default 200 ticks) and has a `vol_to_spread_multiplier` trigger that recalculates quotes when volatility jumps. In the paper's simulation (σ=2, γ=0.1, κ=1.5, T=1) the inventory strategy cut final-inventory std from 8.4 to 2.9 and P&L std from 12.7 to 6.6 for a 5% give-up in mean profit (65.0 vs 68.4).
- **Source.** [Avellaneda and Stoikov](https://math.nyu.edu/~avellane/HighFrequencyTrading.pdf); [Hummingbot Avellaneda market making strategy docs](https://hummingbot.org/strategies/avellaneda-market-making).
- **Tenfold mapping.** Tenfold already uses max(profile distance, 1.5 × σ_1h). Make the multiplier a profile parameter and add a regime switch: compute σ_1h and σ_24h; if σ_1h > 2 × σ_24h (vol spike) multiply level distance by 1.5 and halve the per-level budget for the next hour; if σ_1h < 0.5 × σ_24h (quiet) allow distances at the profile floor. Also recompute parameters at a fixed cadence (Hummingbot recalibrates each time t reaches T) rather than continuously, to avoid chasing noise. **(regime thresholds are inference)**
- **Numbers.** Base multipliers: protect 1.5σ_1h, balanced 2.0σ_1h, distribute 3.0σ_1h, with percentage floors in section 2. Recalibration cadence: every 15 minutes for σ, every hour for pool depth and participation baselines. **(inference)**

### Rule 3. Price impact in a constant-product pool is about 2 × (clip / reserve); size every clip from that

- **Principle.** For x·y = k, a trade of Δx against reserve x moves the pool price by roughly 2·Δx/x (first order). Raydium's own worked example: 0.1% of reserves gives 0.20% impact; 10% of reserves gives 17.3% impact. The amount that moves price 2% ("2% depth") is therefore about 1% of the relevant reserve.
- **Source.** [Raydium docs, constant product](https://docs.raydium.io/algorithms/constant-product).
- **Tenfold mapping.** Replace any fixed clip size with clip ≤ c × SOL_reserve (for defense buys) and clip ≤ c × token_reserve (for distribution sells), with c chosen so a single clip never prints more than the profile's maximum own impact. Report the resulting impact per clip. Pools straight out of PumpSwap graduation hold about 85 SOL, so 2% depth is under 1 SOL there; the engine must compute depth from live reserves, never assume it.
- **Numbers.** c = 0.25% (protect), 0.5% (balanced), 0.75% (distribute) of the relevant reserve, giving about 0.5%, 1.0%, 1.5% own impact per clip; equivalently 25%, 50%, 75% of the pool's 2% depth. **(inference, derived from the 2Δx/x approximation)**

### Rule 4. Pace distribution as a participation rate of real volume (5 / 10 / 15 to 20 percent), never as a fixed amount per hour

- **Principle.** Institutional execution desks express urgency as a percentage of market volume. Virtu's implementation-shortfall algo targets 5% participation (passive), 10% (neutral), 15 to 20% (aggressive); its opportunistic algo runs 1 to 4% / 3 to 7% / 4 to 10%. Market impact grows concavely with participation and with the fraction of daily volume: I ≈ Y·σ_D·(Q/V_D)^δ with Y ≈ 0.15 and δ ≈ 0.47 on equities, and the impact surface depends on participation rate and duration separately (Y=0.207, δ=0.52 on participation, γ1=0.54 on duration).
- **Source.** [Virtu Frontier execution algos quick guide](https://virtu-www.s3.amazonaws.com/uploads/documents/Algo_QuickGuide_Global_November202020.pdf); [Zarinelli et al., Beyond the square root](https://arxiv.org/pdf/1412.2152); [Execution and slippage primer](https://www.techinterview.org/post/3233474593/execution-slippage-quant-interviews/).
- **Tenfold mapping.** The distribution pace set from the horizon (catch-up factor 0.5 to 2) should be capped by participation: sells in any rolling hour ≤ p × (external pool volume over the previous hour, excluding Tenfold's own trades). The horizon pace is the target; participation is the ceiling. If the horizon cannot be met inside the cap, the desk manager reports "behind schedule" rather than breaking the cap (and never breaks the public daily cap).
- **Numbers.** p = 5% (protect), 10% (balanced), 15% (distribute), hard ceiling 20% in any hour and 15% over any day. Illustration with the equity-calibrated coefficient: on a token with 30% daily σ, selling 10% of daily volume depresses price by about 0.15 × 0.30 × √0.10 ≈ 1.4%; at 20% about 2.0%. Treat the coefficient as indicative only. **(profile numbers follow Virtu's tiers; the hard ceiling is inference)**

### Rule 5. Price-variant participation: sell faster when price is high, slower when low, with a floor and a ceiling

- **Principle.** IBKR's price-variant POV algo raises participation when the price is favorable and lowers it when not, bounded by minimum and maximum participation. Its example: target 10% of ADV, change rate 5% per 1% price move, min 1%, max 20%.
- **Source.** [IBKR Campus, Price-variant percentage of volume](https://ibkrcampus.com/campus/trading-lessons/price-variant-percentage-of-volume/).
- **Tenfold mapping.** This is exactly Tenfold's "strength boost". Formalize it as participation(t) = clamp(p_base × (1 + k × z), p_min, p_max), where z = (price − 15-min mean) / σ_15min. Keep the existing gates (buy flow > 1.2× sell flow, price ≥ 15-min mean, not within 1% above a defense level, not within 5 min of an own buy).
- **Numbers.** k = 0.25 per sigma; p_min = 1% (or zero when gates fail); p_max = 20%. Flow-ratio ladder for the boost on top of z: ratio 1.2 to 1.5 → ×1.0; 1.5 to 2.0 → ×1.25; > 2.0 → ×1.5, always inside p_max. **(inference, shape follows IBKR)**

### Rule 6. Inventory band with one-sided behavior at the edges (Hummingbot inventory skew)

- **Principle.** Hummingbot scales bid and ask sizes linearly between 0× and 2× as the base share moves across a band around `inventory_target_base_pct`; outside the band it stops quoting one side entirely ("Above the upper limit, no bid orders are emitted. Below the lower limit, no ask orders are emitted"). The band half-width is `inventory_range_multiplier` × total order size as a share of the portfolio (sample config: target 50%, multiplier 1.0; the code caps the range at 50% of portfolio value).
- **Source.** [Hummingbot inventory skew](https://hummingbot.org/strategy-configs/inventory-skew); [inventory_skew_calculator.pyx](https://github.com/hummingbot/hummingbot/blob/master/hummingbot/strategy/pure_market_making/inventory_skew_calculator.pyx).
- **Tenfold mapping.** Define the target SOL share and a band. Inside the band, scale the two sides linearly: defense budget multiplier = 2 × (upper − SOL_share)/(upper − lower) clamped to [0, 2]; distribution multiplier = 2 − that. Above the upper SOL bound (too much SOL, too few tokens): no distribution, defense allowed. Below the lower SOL bound (too many tokens, little SOL): defense budget goes to the minimum "floor-only" level (Rule 10), distribution continues within its gates.
- **Numbers.** Band half-width 15 points of SOL share for all profiles; targets in section 2. **(inference; Hummingbot gives the mechanism, not the width)**

### Rule 7. Make the target SOL share a glide path over the mandate horizon, and taper skew as the horizon ends

- **Principle.** The A&S inventory shift is proportional to (T−t): the agent skews hard early and lets the skew vanish at the terminal time. Hummingbot runs the strategy in finite sessions (`execution_timeframe`: from_date_to_date, daily_between_times) and recalibrates at each session end.
- **Source.** [Avellaneda and Stoikov](https://math.nyu.edu/~avellane/HighFrequencyTrading.pdf); [Hummingbot Avellaneda strategy docs](https://hummingbot.org/strategies/avellaneda-market-making).
- **Tenfold mapping.** The mandate (share of vault to distribute over H days) defines an end-state SOL share. Set target_SOL_share(t) by linear interpolation from the share at mandate start to the end share. Feed the deviation from this moving target into Rule 1 and Rule 6. The catch-up factor (0.5 to 2) is the A&S (T−t) term in practice: when behind schedule and far from horizon end, lean on it; in the last 10% of the horizon, cap catch-up at 1.0 so the mandate does not end in a dump.
- **Numbers.** Catch-up cap 1.0 in the final 10% of the horizon; weekly re-derivation of the glide path from live price. **(inference)**

### Rule 8. Cool down after a fill instead of re-quoting into the trend (filled_order_delay)

- **Principle.** Hummingbot's `filled_order_delay` pauses new orders after a fill (default 60 s on PMM and A&S; the academy example uses 300 s). In a simulated downtrend the bot with a 300 s delay bought in 2 of 5 periods instead of 5 of 5. The purpose is explicitly to stop "continued trading in the same direction during a trend".
- **Source.** [Hummingbot, What is inventory risk](https://hummingbot.org/blog/what-is-inventory-risk/); [Hummingbot pure market making parameters](https://hummingbot.org/strategies/pure-market-making); [Hummingbot advanced market making features](https://docs.hummingbot.org/academy-content/how-to-use-advanced-market-making-features/).
- **Tenfold mapping.** "Re-places a lost level lower" should not be instantaneous. After a level is consumed, wait a cooldown before placing the replacement, and place it with the Rule 2 regime adjustment. The cooldown should scale with the profile (protect wants continuity, distribute wants to let the market find its level).
- **Numbers.** Cooldown after a consumed level: protect 5 min, balanced 15 min, distribute 30 min. Also apply a 60 s minimum between any two Tenfold orders of the same side. **(inference anchored on Hummingbot's 60 s default and 300 s example)**

### Rule 9. Refresh levels on a tolerance and a max age, not on every tick

- **Principle.** Hummingbot refreshes orders only when mid has moved more than `order_refresh_tolerance_pct` (default 0, meaning every cycle) and forces a refresh at `max_order_age` (default 1800 s). Its moving price band resets every `price_band_refresh_time` (default 86400 s). Churn costs fees and leaks intent.
- **Source.** [Hummingbot pure market making parameters](https://hummingbot.org/strategies/pure-market-making).
- **Tenfold mapping.** Trailing defense levels should move only when the reference has moved by more than a tolerance expressed as a fraction of level distance, and must be re-derived at least every 30 minutes. For future concentrated-liquidity ranges this matters more: each re-range is an on-chain transaction with fees and MEV exposure.
- **Numbers.** Tolerance = 25% of the level distance; max age 30 min; trailing reference window stays 1h. **(inference; the 1800 s default is Hummingbot's)**

### Rule 10. Hard price floor: below the alert floor only buys, above a ceiling only sells (price bands)

- **Principle.** Hummingbot's `price_floor` places only buy orders below a price and `price_ceiling` only sell orders above one; a moving band version re-centers daily.
- **Source.** [Hummingbot pure market making parameters](https://hummingbot.org/strategies/pure-market-making).
- **Tenfold mapping.** The founder's alert floor should be a behavioral floor as well as an alert: below it, distribution pace = 0 regardless of flow, and the defense runs on a dedicated "floor reserve" slice of the lifetime budget that normal levels cannot consume. Conversely a founder-set ceiling (optional) means "distribute at max participation above here, no defense buys".
- **Numbers.** Floor reserve = 25% of the lifetime defense budget, untouchable above the floor. **(inference)**

### Rule 11. Spend the defense budget across several geometrically spaced levels, deepest level heaviest

- **Principle.** Hummingbot supports multiple levels per side (`order_levels`, `order_level_spread`, `order_level_amount`), and the A&S implementation recommends `level_distances` of "tens to hundreds of percent" of the optimal spread because optimal spreads are tight. Virtu and the impact literature agree that the cost of absorbing flow is lower when it is spread, not stacked at one price.
- **Source.** [Hummingbot pure market making parameters](https://hummingbot.org/strategies/pure-market-making); [Hummingbot Avellaneda strategy docs](https://hummingbot.org/strategies/avellaneda-market-making).
- **Tenfold mapping.** Place 3 defense levels at 1×, 2× and 3.5× the base distance (Rule 2). Weight the day's defense budget toward the deeper levels, because the top level is the one most often hit by noise and the deepest one is where buying is cheapest and most stabilizing.
- **Numbers.** Budget split 25 / 35 / 40 across levels 1 / 2 / 3 for balanced; protect 35 / 35 / 30 (more continuity near price); distribute 20 / 30 / 50. **(inference)**

### Rule 12. Treat informed flow as the enemy: estimate price impact per unit of flow (Kyle's lambda) and widen when it rises

- **Principle.** In Kyle (1985) the market maker prices P = μ + λ·y with λ = σ_v / (2σ_u): price impact per unit of net order flow is the signal-to-noise ratio of the flow. More informed flow relative to noise means higher λ. In Glosten and Milgrom (1985) the spread grows with the informed share μ (at θ = 0.5, spread = μ·(V_H − V_L)), and the dealer updates quotes after every trade.
- **Source.** [Kyle (1985) strategic trading and price impact](https://edmondo-finance.pages.dev/market-microstructure/kyle-lambda); [Glosten-Milgrom spread](https://metricgate.com/docs/glosten-milgrom-spread/).
- **Tenfold mapping.** Add an adverse-selection detector: regress 1-minute price changes on signed net flow (buy SOL volume − sell SOL volume) over a rolling 60-minute window; the slope is λ̂. Track λ̂ relative to its 24h median. When λ̂ rises above 2× its median (flow is "toxic": a small amount of flow moves price a lot, which is what happens when informed sellers meet a thin book), widen level distance ×1.5, cut per-level budget ×0.5 and set distribution to zero (sellers who move price this much are likely informed). The insider (team wallet) sell rule already in place is the extreme case of this detector.
- **Numbers.** Window 60 min at 1-min bars; trigger λ̂ > 2 × median_24h; release when λ̂ < 1.25 × median_24h for 30 min. **(inference; the model is Kyle's)**

### Rule 13. Use order-flow imbalance over short windows as the gate for both sides; impact scales with 1/depth

- **Principle.** Cont, Kukanov and Stoikov show that mid-price changes over 10 s windows are linear in order-flow imbalance (R² ≈ 65% on average vs 32% for trade imbalance) and that the impact coefficient is inversely proportional to depth (β = c / depth^λ with λ ≈ 1).
- **Source.** [The price impact of order book events (Cont, Kukanov, Stoikov)](https://ar5iv.labs.arxiv.org/html/1011.6402).
- **Tenfold mapping.** Tenfold already gates distribution on buy flow > 1.2× sell flow in the hour. Add a faster window: net flow over the last 5 min must also be positive to release a clip, and a clip's expected impact is clip / (2% depth) × 2%. When the 5-min OFI is strongly negative (sell flow > 2× buy flow), a defense level is likely to be hit soon: that is the moment to apply the "breathe" step-down rather than hold, because holding against a flow of that sign is adverse selection. When pool depth shrinks, the same SOL clip moves price more; the clip must shrink proportionally (Rule 3 handles this if it is computed from live reserves).
- **Numbers.** Fast gate: 5-min net flow > 0 and 1-hour ratio > 1.2 (existing). Breathe trigger: 5-min sell/buy ratio > 2.0 while price is within 1 level distance of the top level. **(inference)**

### Rule 14. Toxicity (VPIN-style) triggers a rest, not a bigger bid

- **Principle.** Easley, López de Prado and O'Hara's VPIN measures flow toxicity as volume imbalance over volume buckets and show it is "a useful indicator of short-term, toxicity-induced volatility"; the practical lesson for market makers is to withdraw or widen when toxicity is high rather than to absorb.
- **Source.** [Flow toxicity and liquidity in a high-frequency world (SSRN 1695596)](https://papers.ssrn.com/abstract=1695596).
- **Tenfold mapping.** Compute a toxicity index as |buyV − sellV| / (buyV + sellV) averaged over the last N volume buckets (bucket size = 1/50 of the trailing 24h volume). When the index is in the top decile of its own 7-day distribution and the sign is sell-side, trigger a 60-minute defense rest and zero distribution; this complements the existing 6h/12h/24h rests after 2/3/4 lost levels (which are "consecutive loss" rests in prop-desk terms).
- **Numbers.** N = 10 buckets; trigger at the 90th percentile; rest 60 min; the lost-level rests stay as they are. **(inference on thresholds; VPIN is the model)**

### Rule 15. A daily mark-to-market loss limit on defense, a weekly limit at 2× daily, automated stop

- **Principle.** Prop-desk practice: daily loss limit about 2 to 3% of equity (often 3× per-trade risk), weekly limit 2× daily, monthly 2× weekly; hitting the daily limit means no more trading that session; fees count as losses; enforcement must be automatic ("flatten open positions when the threshold is breached and block new orders").
- **Source.** [CrossTrade, Daily loss limits](https://crosstrade.io/learn/risk-management/daily-loss-limits).
- **Tenfold mapping.** Today the risk engine caps defense *spend* (lifetime and per day). Spend is not loss. Add a *loss* limit: realized plus unrealized loss on inventory bought by defense (marked at the pool mid, fees and priority fees included) per UTC day and per week, as a share of vault value at the start of the period. On breach: stop placing new levels, keep the floor reserve (Rule 10) only, rest until the next period. Also an inventory-level stop: if the defended inventory's unrealized loss exceeds X% of its cost, stop adding to it (section 2).
- **Numbers.** Daily MTM loss limit on defense: protect 3%, balanced 2%, distribute 1.5% of vault; weekly 2× daily; defended-inventory unrealized-loss stop: protect 25%, balanced 15%, distribute 10% of cost. **(inference; the 2 to 3% / 2× structure is CrossTrade's)**

### Rule 16. Tiered circuit breakers with a 5-minute reference price, like LULD and market-wide breakers

- **Principle.** US equities use a reference price equal to the average over the preceding 5 minutes with price bands of 5%, 10% or 20% by tier; being outside the band for 15 seconds triggers a 5-minute pause. Market-wide breakers trip at 7%, 13% and 20% with a 15-minute halt for levels 1 and 2 and a full-day halt at level 3.
- **Source.** [SEC investor bulletin, Circuit breakers](https://www.sec.gov/investor/alerts/circuitbreakersbulletin.htm).
- **Tenfold mapping.** Replace a single 5-minute breaker with three tiers measured against the 5-minute average: tier 1 pauses distribution and new level placement for 15 minutes; tier 2 pauses everything for 60 minutes; tier 3 (or the existing 50% liquidity drop in an hour) stops the desk until the next UTC day or a founder acknowledgment. Add an upside tier: on a spike above +3σ in 5 minutes, hold the strength boost at ×1.0 for 10 minutes (a single whale print or a sandwich can produce it, and the top of a spike is where a founder-side seller looks worst).
- **Numbers.** Tier 1: −10% vs 5-min average; tier 2: −20%; tier 3: −35% or liquidity −50%/1h; upside: +3σ_5min. Add a tier-1-lite at −30% pool liquidity in an hour: distribution pause only. **(inference; the 5-min reference, tiering and 15-min pause follow the SEC structure)**

### Rule 17. Tight slippage is the first sandwich defense; set it dynamically with a min and a max, and never above the clip's own impact plus a margin

- **Principle.** Solana's MEV documentation calls tight slippage "the most effective defense against sandwiches". Jupiter warns that too-high slippage invites MEV and too-low causes failures; its API offers `dynamicSlippage` with `minBps`/`maxBps` (QuickNode's example 50/300) and `restrictIntermediateTokens: true` to avoid low-liquidity routes. Jupiter UI presets are 0.5% and 1%; Manual Mode has no MEV protection, Ultra Mode uses private submission.
- **Source.** [Solana docs, MEV protection with Jito DontFront](https://solana.com/docs/defi/mev-protection); [QuickNode, Jupiter transactions](https://www.quicknode.com/docs/solana/jupiter-transactions); [Jupiter Manual Mode](https://docs.jup.ag/user-docs/trade/swap/manual-mode.md); [Jupiter risks](https://docs.jup.ag/user-docs/trade/swap/risks.md).
- **Tenfold mapping.** Max slippage per profile and per action; slippage cap = expected own impact of the clip (Rule 3) + margin, never a flat number; `restrictIntermediateTokens: true`; route only to the target pool for distribution so the volume and fees land where the founder's liquidity is (and so Tenfold's own share of pool volume is measurable). Patient actions (distribution) use the low end; urgent actions (defense buys in a falling market) use the high end.
- **Numbers.** Distribution: dynamic 30 to 100 bps (protect, balanced), 30 to 150 bps (distribute). Defense buys: 50 to 200 bps, 300 bps max for protect in a tier-1 breaker window. Margin over own impact: 50 bps. **(inference anchored on Jupiter presets and the 50/300 example)**

### Rule 18. Pay for inclusion by urgency (fee percentiles), add a Jito tip and jitodontfront for defense buys, simulate first

- **Principle.** Priority fee = CU price × CU limit, local to the writable accounts, so estimate per pool not network-wide. Percentile bands by scenario: low-edge swap p25 to p50; standard bot p50 to p75; latency-sensitive p75 to p95; atomic multi-step p90+ with a Jito tip. Set the CU limit to simulated usage plus about 10%. Jupiter's `"auto"` caps the priority fee at 5,000,000 lamports (0.005 SOL). Jito: minimum tip 1,000 lamports, bundles up to 5 transactions, tip in the last transaction, simulate before sending; the `jitodontfront` account (read-only, non-signer) sent through the Jito block engine prevents a bundle from placing a transaction ahead of yours (no guarantee).
- **Source.** [rpcfast, Solana transaction fees explained](https://rpcfast.com/blog/solana-transaction-fees-explained); [rpcfast, Jito explained](https://rpcfast.com/blog/jito-explained-bundles-tips-mev-solana); [Solana docs, MEV protection](https://solana.com/docs/defi/mev-protection); [QuickNode, Jupiter transactions](https://www.quicknode.com/docs/solana/jupiter-transactions).
- **Tenfold mapping.** Distribution clips: p50 to p75 priority fee, no tip. Defense buys when a level is hit: p75 to p95 priority fee plus Jito tip with `jitodontfront` and `dynamicComputeUnitLimit`. Retry on blockhash expiry (about 150 blocks). Count fees and tips as cost in the loss limit (Rule 15) and in reports.
- **Numbers.** Fee budget cap per clip: 0.5% of clip value for distribution, 1% for defense; if the estimate exceeds the cap, skip the clip and log it. **(inference)**

### Rule 19. Treat snipers, bundlers and team wallets as informed traders; their sells zero distribution and widen defense

- **Principle.** Insiders, VCs and team are "a disproportionate share of orders on small-cap and new tokens" and are the adverse-selection risk a token MM cannot hedge. Practical sniper heuristics: first 50 buyers, hold time under 5 to 10 minutes with positive realized PnL, repeat first-buyers across launches, same-block buys as the liquidity add (bundlers), coordinated wallet clusters; labels are prompts for review, not proof of intent.
- **Source.** [Arrakis, Market makers 101](https://arrakis.finance/blog/market-makers-101); [SolanaTracker, sniper detection](https://docs.solanatracker.io/guides/sniper-detection.md).
- **Tenfold mapping.** Maintain a watch-list: founder-declared team wallets, first-block buyers, wallets holding > 1% of supply. A sell from any watch-listed wallet in the last 30 minutes sets distribution to zero (existing rule for team wallets, extend to the list), raises level distance ×1.5 and cuts level budget ×0.5 for 60 minutes. Report every watch-list sell to the founder.
- **Numbers.** Watch-list thresholds: top 20 holders, any wallet > 1% of supply, first-block buyers, declared team wallets; reaction window 60 min. **(inference; heuristics from SolanaTracker)**

### Rule 20. Concentrated-liquidity ranges are resting bids that must be withdrawn once crossed, and they bleed LVR at a rate of σ²/8 per unit of pool value (more when concentrated)

- **Principle.** A narrow Uniswap v3 position behaves like a limit order but "a crossed position must be withdrawn, or a later price move back across the range will reverse the trade". Loss-versus-rebalancing for a constant-product pool is σ²/8 of pool value per unit time (5% daily vol → about 3.1 bps/day) and in general ℓ = (σ²P²/2)·|x′(P)|, i.e. proportional to marginal liquidity, so concentrating liquidity multiplies the LVR rate while the price is in range. Meteora DLMM: Spot, Curve and Bid-Ask shapes, single-sided deployments for DCA in or out, bin step larger for volatile pairs, 69 bins max per position.
- **Source.** [Uniswap v3 whitepaper](https://app.uniswap.org/whitepaper-v3.pdf); [Automated market making and loss-versus-rebalancing (Milionis, Moallemi, Roughgarden, Zhang)](https://arxiv.org/abs/2208.06046); [Meteora DLMM strategies and use cases](https://docs.meteora.ag/product-overview/dlmm-overview/strategies-and-use-cases); [Gamma Strategies, expected price range strategies](https://medium.com/gamma-strategies/expected-price-range-strategies-in-uniswap-v3-833dff253f84).
- **Tenfold mapping (future feature).** A defense level as a single-sided SOL range: lower bound = level price, width = 1 σ_1h, withdraw-and-hold the tokens once price crosses below (do not let the range sell them back on the bounce, which would both reverse the defense and look like a round trip). A distribution ladder as a single-sided token range above price with a Bid-Ask shape, sized by the participation cap. Budget LVR explicitly: a memecoin at 30% daily σ loses about 0.30²/8 ≈ 1.1%/day of in-range value for a full-range position and proportionally more for a concentrated one; this is a real cost the founder report must show.
- **Numbers.** Range width 1σ_1h (defense) and 2σ_1h (distribution ladder); re-range when price exits (Gamma's reset rule); DLMM bin step ≥ 100 bps for tokens with daily σ > 20%. **(inference; the mechanics and the σ²/8 rate are the sources')**

### Rule 21. Measure and publish liquidity the way the industry does: 2% depth per side, uptime with a max-outage cap, bid/ask balance

- **Principle.** The standard token-MM KPIs are spread (in bps), depth at ±2% of mid counted separately for bids and asks, and uptime defined as the share of time spread and depth obligations hold at once, paired with a sampling frequency and a cap on the longest single outage ("95% monthly uptime allows roughly 36 continuous hours offline"). Observed cross-firm medians: bid/ask depth ratio 1.02, depth-loan utilization 59%. Depth matters empirically: tokens with under $20k of 2% depth averaged 237% annualized volatility vs 171% at $165k+, flattening above about $70k.
- **Source.** [Tokenomist, Market maker KPI](https://tokenomist.ai/learn/glossary-term/market-maker-kpi); [Tokenomist, How to read the market maker performance index](https://www.tokenomist.ai/research/how-to-read-the-market-maker-performance-index); [Tokenomist, KPI adherence](https://tokenomist.ai/market-makers/kpi-adherence); [Arrakis, Market makers 101](https://arrakis.finance/blog/market-makers-101); [CryptoSlate / Kaiko 2% depth definition](https://cryptoslate.com/insights/dwindling-order-book-depth-raises-liquidity-concerns-in-crypto-markets).
- **Tenfold mapping.** For an AMM, "bid depth within 2%" = pool SOL that absorbs a 2% move (about 1% of SOL reserves) plus Tenfold's active defense budget within 2% of price; "ask depth" = the symmetric token-side figure plus any distribution ladder. Uptime = share of minutes in which at least one funded defense level sat within the profile distance. Publish bid/ask balance and the defense "budget utilization" (deployed vs mandated), which is the AMM analog of depth-loan utilization.
- **Numbers.** Sample every minute; report 7-day and 30-day; max single outage reported alongside uptime; target uptime ≥ 95% outside rest periods, and report rest periods separately. **(targets are inference; definitions are the sources')**

### Rule 22. Benchmark distribution like an execution desk: realized price vs arrival and vs pool VWAP, and show participation and cap utilization

- **Principle.** Implementation shortfall is the gap between decision price and realized price; VWAP and TWAP are the standard schedule benchmarks; POV algos report realized participation against target.
- **Source.** [Virtu Frontier execution algos quick guide](https://virtu-www.s3.amazonaws.com/uploads/documents/Algo_QuickGuide_Global_November202020.pdf); [Almgren-Chriss model](https://en.wikipedia.org/wiki/Almgren%E2%80%93Chriss_model); [Execution and slippage primer](https://www.techinterview.org/post/3233474593/execution-slippage-quant-interviews/).
- **Tenfold mapping.** For every distribution day report: tokens sold, SOL raised, realized VWAP, pool VWAP over the same window (external trades only), arrival price at day start, participation achieved vs target, daily-cap utilization (%), number of clips, average own impact per clip, slippage realized vs quoted, failed transactions, fees and tips paid.
- **Numbers.** Flag a day when realized VWAP < pool VWAP by more than 1% or participation > target by more than 2 points. **(inference)**

### Rule 23. Rebalance with the market, not against it: rebalancing trades count toward the same participation and cap budgets

- **Principle.** Hummingbot's inventory skew rebalances by biasing fills (bigger size on the side that moves toward target), not by sending separate market orders; A&S likewise reaches target through the quote skew. Any rebalancing that crosses the spread is an execution with impact, measured the same way.
- **Source.** [Hummingbot inventory skew](https://hummingbot.org/strategy-configs/inventory-skew); [Avellaneda and Stoikov](https://math.nyu.edu/~avellane/HighFrequencyTrading.pdf).
- **Tenfold mapping.** The "rebalance toward target SOL share" action should mostly be expressed through Rules 1 and 6 (bias defense and distribution), and only send explicit rebalance swaps when the vault is outside the band. Those swaps are distribution or defense in disguise: token→SOL rebalances count against the public daily sell cap and the participation ceiling; SOL→token rebalances count against the defense budget and the loss limit. No separate budget.
- **Numbers.** Explicit rebalance only when outside the ±15-point band; rebalance clip = half the normal clip. **(inference)**

### Rule 24. Fee alignment and transparency: publish the rules of engagement and keep the cap and sell ledger auditable

- **Principle.** The two commercial models in token MM are loan + call option (1 to 5% of supply, 12 to 24 months, no upfront fee, MM keeps option upside, chronic sell pressure as the MM sells loaned tokens to fund bids) and retainer ($3 to 7k per month per exchange at the low end, $10 to 50k+ per month plus $50 to 100k setup at the large firms; GSR quoted at about $100k setup and $20k monthly in a public DAO proposal). Cointelegraph reviewed six loan-option deals: all six tokens fell. Practitioners advise defining liquidity by depth in the contract, and a listings adviser noted a project with multiple MMs avoided a dump by spreading risk. Firms that market themselves on integrity say they refuse wash trading and spoofing and publish weekly dashboards.
- **Source.** [Arrakis, Market makers 101](https://arrakis.finance/blog/market-makers-101); [Cointelegraph, Market maker deals quietly killing crypto projects](https://cointelegraph.com/magazine/market-maker-deals-quietly-killing-crypto-projects); [Hillrise, Guide to crypto market making](https://medium.com/hillrise-research/guide-to-crypto-market-making-ebd80d766a08); [Spark, Crypto market makers compared](https://www.spark.money/tools/crypto-market-maker-comparison); [HackerNoon, Inside Kairon Labs](https://hackernoon.com/the-art-and-science-of-crypto-market-making-inside-kairon-labs).
- **Tenfold mapping.** Tenfold's model (founder keeps custody and inventory, public daily sell cap, fee on volume) is structurally the retainer side of this spectrum, which is the side the literature prefers. Two consequences. First, a fee on volume creates the same incentive the industry is criticized for (more churn, more fee), so the participation ceiling (Rule 4), the own-share-of-volume metric and the no-self-trade rule are what make the fee defensible; the founder report must show Tenfold's share of pool volume every day. Second, the daily sell cap and every sell should be reconstructible on-chain by a third party (signed ledger of clips with tx signatures), because the loan-option scandals were about opacity.
- **Numbers.** Own share of pool volume reported daily, soft alert above 20%, hard stop at 25% in any rolling 24h. **(inference; the fee-on-volume detail is from the Tenfold project notes)**

---

## 2. Suggested defaults per profile

All numbers in this table are our calibration **(inference)** unless a source is named in the row. σ_1h is realized 1-hour volatility of 1-minute returns, expressed as a return. "Vault" = tokens at pool mid + SOL.

| Parameter | Protect | Balanced | Distribute | Basis |
|---|---|---|---|---|
| Level distance (first level) | max(1.5 σ_1h, 3%) | max(2.0 σ_1h, 5%) | max(3.0 σ_1h, 8%) | A&S σ scaling; today's 1.5σ kept for protect |
| Level ladder | 1×, 2×, 3.5× base distance | same | same | Hummingbot order_levels |
| Budget split across levels (L1/L2/L3) | 35 / 35 / 30 | 25 / 35 / 40 | 20 / 30 / 50 | Rule 11 |
| Vol regime: widen when σ_1h > 2 σ_24h | ×1.5 distance, ×0.5 budget, 60 min | same | same | Rule 2 |
| Max daily defense spend (% of vault SOL) | 10% | 6% | 3% | existing per-day cap, retuned |
| Lifetime defense budget (% of vault SOL) | 60% | 40% | 20% | of which 25% is floor reserve (Rule 10) |
| Daily MTM loss limit on defense (% of vault) | 3% | 2% | 1.5% | CrossTrade 2 to 3% per day |
| Weekly MTM loss limit | 6% | 4% | 3% | 2× daily (CrossTrade) |
| Defended-inventory unrealized-loss stop (% of cost) | 25% | 15% | 10% | Rule 15 |
| Cooldown after a consumed level | 5 min | 15 min | 30 min | Hummingbot filled_order_delay 60 s default, 300 s example |
| Breathe: step a level down when holding it would exhaust the day's budget in under | 2 h | 4 h | 6 h | existing N-hours rule, retuned |
| Rest after 2 / 3 / 4 lost levels in 24h | 6h / 12h / 24h | 6h / 12h / 24h | 12h / 24h / 48h | existing, longer for distribute |
| Toxicity rest (Rule 14) | 60 min | 60 min | 120 min | VPIN logic |
| Lambda trigger (Rule 12) | λ̂ > 2× median_24h | same | same | Kyle |
| Distribution participation (% of external pool volume, rolling 1h) | 5% | 10% | 15% | Virtu passive / neutral / aggressive |
| Participation hard ceiling | 15%/h, 10%/day | 20%/h, 15%/day | 20%/h, 15%/day | Virtu 20% aggressive top |
| Strength gate (buy/sell flow ratio, 1h) | > 1.5 | > 1.2 | > 1.2 | existing 1.2 |
| Fast gate (5-min net flow) | > 0 | > 0 | > 0 | Cont et al. OFI |
| Strength boost ladder (flow ratio → multiplier) | 1.5 to 2 ×1.0; > 2 ×1.25 | 1.2 to 1.5 ×1.0; 1.5 to 2 ×1.25; > 2 ×1.5 | same as balanced | IBKR price-variant POV |
| Price-variant coefficient k (per σ above 15-min mean) | 0.15 | 0.25 | 0.35 | IBKR |
| Clip size (% of relevant pool reserve) | 0.25% (≈0.5% impact) | 0.5% (≈1% impact) | 0.75% (≈1.5% impact) | Raydium 2Δx/x |
| Clip size as share of 2% depth | 25% | 50% | 75% | same |
| Min spacing between own same-side orders | 60 s | 60 s | 60 s | Hummingbot |
| No sell within N min of own buy | 5 min (existing) | 5 min | 5 min | anti self-match |
| No sell within X% above an active level | 1% (existing) | 1% | 1% | existing |
| Target SOL share | glide to 50% | glide to end-share of mandate | glide to end-share of mandate | Rule 7 |
| Inventory band (half-width, SOL-share points) | ±15 | ±15 | ±15 | Hummingbot multiplier 1.0 analog |
| Inventory skew γ (Rule 1, σ units) | 0.5 | 1.0 | 1.5 | A&S γ |
| Explicit rebalance | only outside band, half clip | same | same | Rule 23 |
| Max slippage, distribution (dynamic min to max) | 30 to 100 bps | 30 to 100 bps | 30 to 150 bps | Jupiter presets 0.5%/1%; QuickNode 50/300 example |
| Max slippage, defense buy | 50 to 200 bps (300 in tier-1 window) | 50 to 200 bps | 50 to 150 bps | same |
| Slippage cap rule | own impact + 50 bps | same | same | Rule 17 |
| Priority fee percentile, distribution / defense | p50-75 / p75-95 + Jito tip | same | same | rpcfast |
| Fee cap per clip (% of clip value), distribution / defense | 0.5% / 1% | same | same | Rule 18 |
| Circuit breaker tier 1 (5-min vs 5-min avg) | −10%: pause distribution + new levels 15 min | same | same | SEC LULD / MWCB structure |
| Tier 2 | −20%: pause all 60 min | same | same | |
| Tier 3 | −35% or liquidity −50%/1h: stop until next UTC day or founder ack | same | same | existing liquidity rule |
| Liquidity −30%/1h | pause distribution only | same | same | |
| Upside spike +3σ_5min | boost ×1.0 for 10 min | same | same | Rule 16 |
| Watch-list sell (Rule 19) | distribution 0, distance ×1.5, budget ×0.5, 60 min | same | same | Arrakis / SolanaTracker |
| Own share of pool volume | alert 20%, stop 25% (24h) | same | same | Rule 24 |

Notes on the table:

- Protect widens the distribution gates (flow ratio 1.5) and tightens the defense; Distribute does the opposite. Balanced keeps today's 1.2 gate.
- "External pool volume" always excludes Tenfold's own trades; otherwise the participation ceiling is circular.
- The daily sell cap remains the public hard cap; the participation ceiling is an additional, usually lower, dynamic cap. Whichever is lower binds.

---

## 3. What a professional market maker reports to a client

What the sources say is reported: Kairon Labs gives clients a weekly dashboard with order-book depth at key bands, spread as a percentage of mid, and slippage on standardized trade sizes, and states performance is judged on spread, depth and uptime rather than raw volume ([HackerNoon, Inside Kairon Labs](https://hackernoon.com/the-art-and-science-of-crypto-market-making-inside-kairon-labs)). Keyrock advertises KPI-based reporting and real-time client dashboards; Flowdesk's model has the client keep custody and the loan ([Spark, Crypto market makers compared](https://www.spark.money/tools/crypto-market-maker-comparison)). Independent trackers measure 2% bid depth and 2% ask depth separately, uptime, bid/ask balance, depth-loan utilization and share of market, over 7/30/60-day windows, and KPI adherence as the share of days depth (0.5%, 1%, 2%), spread and combined uptime targets were met ([Tokenomist performance index](https://www.tokenomist.ai/research/how-to-read-the-market-maker-performance-index); [Tokenomist KPI adherence](https://tokenomist.ai/market-makers/kpi-adherence)). KPI contracts should name the venue, the sampling frequency, the data source and a dispute process, and pair uptime with a maximum single outage ([Tokenomist, Market maker KPI](https://tokenomist.ai/learn/glossary-term/market-maker-kpi)).

Recommended Tenfold report (daily short form, weekly full form, monthly summary). Items marked (AMM analog) are our translation of order-book metrics **(inference)**.

**A. Liquidity and price**
- Price open/high/low/close, 24h and 7d change; realized σ_1h average, σ_24h.
- 2% depth, bid side and ask side, in SOL and USD, sampled every minute: pool-implied plus Tenfold's funded levels within 2% (AMM analog). Also 5% and 10% depth.
- Bid/ask depth balance ratio (industry median about 1.02).
- Uptime: share of minutes with at least one funded defense level inside the profile distance; longest single outage; rest periods listed separately with their cause (lost levels, toxicity, breaker).
- Effective spread (AMM analog): round-trip cost for standardized sizes (for example 1, 5, 25 SOL) computed from live reserves and fees.

**B. Defense**
- Levels placed, moved, consumed; SOL spent today / this week / lifetime vs budget (utilization, the analog of depth-loan utilization).
- Defended inventory: tokens bought, average cost, mark-to-market P&L, unrealized loss vs the stop; daily and weekly MTM loss vs limits.
- Breathe events, rests, breaker tiers hit, with timestamps.

**C. Distribution**
- Tokens sold, SOL raised, realized VWAP vs external pool VWAP and vs arrival price; participation achieved vs target; daily-cap utilization; clips, average own impact per clip, realized slippage vs quoted; failed transactions; fees and Jito tips paid.
- Progress vs mandate: % of mandated share distributed, days remaining, catch-up factor in use, "behind/ahead" flag.

**D. Inventory**
- Token share / SOL share vs target glide path and band; explicit rebalances executed and why.

**E. Market quality and integrity**
- External volume, Tenfold's share of pool volume (daily, alert at 20%), number of distinct external traders, holder count and top-20 concentration, watch-list wallet sells and the reaction taken.
- Toxicity index and λ̂ relative to their medians; insider-sell events.
- For concentrated-liquidity positions later: fees earned, LVR estimate (σ²/8 × in-range value per day, scaled for concentration), net.

**F. Costs**
- Priority fees, Jito tips, swap fees paid, Tenfold fee accrued; all included in the P&L lines above.

**G. Attestations (monthly)**
- Statement that no Tenfold order matched another Tenfold order, that no sell occurred within 5 minutes of an own buy, that daily caps were never exceeded, with the tx-signature ledger attached. This is the part the loan-option scandals lacked.

---

## 4. Rejected advice

Things commonly proposed in this space that Tenfold refuses, with the reason.

1. **"Volume support" / volume bots** (clients set a daily wash-trade amount on a dashboard, "millions per day per token"). Wash trading; this is the MyTrade MM charge in the DOJ case ([DOJ, eighteen individuals and entities charged](https://www.justice.gov/usao-ma/pr/eighteen-individuals-and-entities-charged-international-operation-targeting-widespread)).
2. **Trading between multiple own wallets so activity "doesn't look fake"**, trading many times per minute to "pump the price". Wash trading and manipulation; this is the ZM Quant charge (same source).
3. **Self-trade algorithms "so the token looks organic and live"**. Wash trading; the CLS Global charge (same source).
4. **Tracking "created volume" vs "market volume"** as a service deliverable. The Gotbit charge; any volume Tenfold creates against itself is fake by definition (same source).
5. **Coordinated small buys across many wallets to create "an illusion of massive buys and new holders"**. Fake holder growth; the Saitama charge (same source). Tenfold uses one disclosed vault.
6. **Wash trading "but at different amounts on low-volume days" so it is less obvious**. Still wash trading; the project's own stated red line (from the Tenfold project notes) and the DOJ definition of sham trades.
7. **Selling into your own defense buy ("ping-pong" through the pool with own wallets)**. Self-matching; this is why the 5-minute own-buy exclusion exists. Hummingbot's ping-pong is legitimate only because the counterparty is a stranger on an exchange.
8. **Posting concentrated-liquidity ranges to "show depth" and pulling them before they fill**. Spoofing (Kairon lists spoofing alongside wash trading as what it refuses, [HackerNoon](https://hackernoon.com/the-art-and-science-of-crypto-market-making-inside-kairon-labs)). Tenfold's levels must be funded and executable.
9. **Selling loaned or founder supply to fund the bids, then buying back cheaper** ("loan dumping"). The documented loan-option pathology ([Cointelegraph](https://cointelegraph.com/magazine/market-maker-deals-quietly-killing-crypto-projects); [Arrakis](https://arrakis.finance/blog/market-makers-101)). Tenfold sells only inside the public daily cap and only into real buy flow.
10. **Price or volume guarantees** ("we will hold $X" or "we will do $Y volume"). A red flag per Arrakis; a guarantee can only be met by manipulation when real flow is absent.
11. **Side wallets, OTC-then-dump, or "rebalancing" to exceed the daily sell cap.** Trading around the founder's hard cap; Rule 23 makes rebalances count against the same cap.
12. **Buying "to trend" on screeners / paying for ranking with volume.** Fake volume with the explicit purpose of attracting buyers who then lose; the MyTrade founder's own description ("we have to make the other buyers lose money in order to make profit", DOJ release).
13. **Marking the close / painting a candle at a snapshot time** (daily close, listing snapshot, option strike). Classic manipulation of a reference price; same category as pumping into a call-option strike that Cointelegraph documents as the loan-option conflict.
14. **Front-running or sandwiching the token's own users with Tenfold's view of flow.** MEV extraction against the community Tenfold is paid to serve; Tenfold is a sandwich *target* that protects itself (Rules 17 and 18), never a searcher.
15. **Trading on team announcements before they are public.** Informed trading against the token's holders; this is the adverse selection Tenfold is built to detect, not to commit.
16. **Hidden rules, hidden wallet.** Not manipulation per se, but the opacity that made every scandal above possible; Tenfold keeps the sell ledger auditable even if the founder keeps the mandate private.

---

## 5. Sources

Academic and theory
- [Avellaneda and Stoikov, High-frequency trading in a limit order book (2008)](https://math.nyu.edu/~avellane/HighFrequencyTrading.pdf)
- [Kyle (1985): strategic trading and price impact, lambda](https://edmondo-finance.pages.dev/market-microstructure/kyle-lambda)
- [Glosten-Milgrom spread (MetricGate)](https://metricgate.com/docs/glosten-milgrom-spread/)
- [Cont, Kukanov, Stoikov, The price impact of order book events (arXiv 1011.6402)](https://ar5iv.labs.arxiv.org/html/1011.6402)
- [Easley, López de Prado, O'Hara, Flow toxicity and liquidity in a high-frequency world (VPIN)](https://papers.ssrn.com/abstract=1695596)
- [Zarinelli, Treccani, Farmer, Lillo, Beyond the square root: logarithmic dependence of market impact](https://arxiv.org/pdf/1412.2152)
- [Almgren-Chriss model (Wikipedia)](https://en.wikipedia.org/wiki/Almgren%E2%80%93Chriss_model)
- [Milionis, Moallemi, Roughgarden, Zhang, Automated market making and loss-versus-rebalancing](https://arxiv.org/abs/2208.06046)
- [Uniswap v3 whitepaper](https://app.uniswap.org/whitepaper-v3.pdf)
- [Gamma Strategies, Expected price range strategies in Uniswap v3](https://medium.com/gamma-strategies/expected-price-range-strategies-in-uniswap-v3-833dff253f84)

Practitioner: market-making software
- [Hummingbot, Technical deep dive into the Avellaneda and Stoikov strategy](https://hummingbot.org/blog/technical-deep-dive-into-the-avellaneda--stoikov-strategy/)
- [Hummingbot, Avellaneda market making strategy parameters](https://hummingbot.org/strategies/avellaneda-market-making)
- [Hummingbot, Pure market making parameters](https://hummingbot.org/strategies/pure-market-making)
- [Hummingbot, Inventory skew](https://hummingbot.org/strategy-configs/inventory-skew)
- [Hummingbot, inventory_skew_calculator.pyx](https://github.com/hummingbot/hummingbot/blob/master/hummingbot/strategy/pure_market_making/inventory_skew_calculator.pyx)
- [Hummingbot, What is inventory risk](https://hummingbot.org/blog/what-is-inventory-risk/)
- [Hummingbot, How to use advanced market making features](https://docs.hummingbot.org/academy-content/how-to-use-advanced-market-making-features/)

Practitioner: execution
- [Virtu, Frontier execution algos quick guide (Nov 2020)](https://virtu-www.s3.amazonaws.com/uploads/documents/Algo_QuickGuide_Global_November202020.pdf)
- [IBKR Campus, Price-variant percentage of volume](https://ibkrcampus.com/campus/trading-lessons/price-variant-percentage-of-volume/)
- [Execution and slippage for quant interviews](https://www.techinterview.org/post/3233474593/execution-slippage-quant-interviews/)
- [CrossTrade, Daily loss limits](https://crosstrade.io/learn/risk-management/daily-loss-limits)
- [SEC investor bulletin, Circuit breakers (market-wide and LULD)](https://www.sec.gov/investor/alerts/circuitbreakersbulletin.htm)

Token market making industry
- [Arrakis, Market makers 101](https://arrakis.finance/blog/market-makers-101)
- [Cointelegraph Magazine, Market maker deals quietly killing crypto projects](https://cointelegraph.com/magazine/market-maker-deals-quietly-killing-crypto-projects)
- [Hillrise Research, Guide to crypto market making](https://medium.com/hillrise-research/guide-to-crypto-market-making-ebd80d766a08)
- [Spark, Crypto market makers compared](https://www.spark.money/tools/crypto-market-maker-comparison)
- [HackerNoon, The art and science of crypto market making: inside Kairon Labs](https://hackernoon.com/the-art-and-science-of-crypto-market-making-inside-kairon-labs)
- [Tokenomist, Market maker KPI (glossary)](https://tokenomist.ai/learn/glossary-term/market-maker-kpi)
- [Tokenomist, How to read the market maker performance index](https://www.tokenomist.ai/research/how-to-read-the-market-maker-performance-index)
- [Tokenomist, KPI adherence](https://tokenomist.ai/market-makers/kpi-adherence)
- [CryptoSlate, Dwindling order book depth (Kaiko 2% depth definition)](https://cryptoslate.com/insights/dwindling-order-book-depth-raises-liquidity-concerns-in-crypto-markets)
- [Kaiko docs, Compare market depth between exchanges](https://docs.kaiko.com/getting-started/kaiko-examples/compare-market-depth-between-exchanges)

Solana execution
- [Solana docs, MEV protection with Jito DontFront](https://solana.com/docs/defi/mev-protection)
- [QuickNode, Jupiter transactions (slippage, priority fees, Jito tips)](https://www.quicknode.com/docs/solana/jupiter-transactions)
- [Jupiter docs, Manual mode](https://docs.jup.ag/user-docs/trade/swap/manual-mode.md)
- [Jupiter docs, Risks](https://docs.jup.ag/user-docs/trade/swap/risks.md)
- [rpcfast, Solana transaction fees explained](https://rpcfast.com/blog/solana-transaction-fees-explained)
- [rpcfast, Jito explained: bundles, tips, MEV](https://rpcfast.com/blog/jito-explained-bundles-tips-mev-solana)
- [Raydium docs, Constant product](https://docs.raydium.io/algorithms/constant-product)
- [PumpSwap overview (graduation at 85 SOL, fee split)](https://edmondo-finance.pages.dev/defi-markets/pumpswap)
- [Meteora docs, DLMM strategies and use cases](https://docs.meteora.ag/product-overview/dlmm-overview/strategies-and-use-cases)
- [SolanaTracker docs, Sniper detection](https://docs.solanatracker.io/guides/sniper-detection.md)

Enforcement
- [US DOJ (D. Mass.), Eighteen individuals and entities charged in international operation targeting widespread fraud and manipulation in cryptocurrency markets](https://www.justice.gov/usao-ma/pr/eighteen-individuals-and-entities-charged-international-operation-targeting-widespread)
