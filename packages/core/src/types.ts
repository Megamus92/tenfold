/**
 * Tenfold core types. Everything else (exec, strategies, engine, agent, proof) builds on these.
 *
 * Units:
 *  - token amounts are in base units (bigint, respecting `decimals`)
 *  - SOL amounts are in lamports (bigint) unless the field name ends in `Sol` (number, for config and reports)
 *  - prices are SOL per whole token (number)
 *  - timestamps are unix milliseconds (number)
 */

export type Pubkey = string;

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Why an order exists. Every order carries exactly one. Logged, shown on the proof page. */
export type ReasonCode =
  | "DEF" // level defense: real buy at a founder-set level
  | "DIST" // distribution: real sell into strength, within the daily cap
  | "REB" // inventory rebalance: keep the token/SOL ratio inside the band
  | "LP" // concentrated liquidity position management (phase 2)
  | "MANUAL"; // founder-instructed one-off, still validated by the risk engine

export type Side = "buy" | "sell";

export type Mode = "paper" | "live";

export interface VaultRules {
  /** Max % of the vault's token balance that may be sold per rolling 24h. */
  dailySellCapPct: number;
  /** SOL the engine may spend on defense buys over the project's lifetime (replenishable by the founder). */
  defenseBudgetSol: number;
  /** Hard ceiling on defense spend per rolling 24h. */
  maxDefenseSpendPerDaySol: number;
  /** Recorded for the proof page; enforced on-chain once the vault program is live. */
  withdrawalDelayHours: 24 | 48;
  /** Per-order slippage ceiling. */
  maxSlippageBps: number;
  /** Pace limit. */
  maxOrdersPerHour: number;
  /** Pause the project if price moves more than this % in 5 minutes. */
  circuitBreakerMovePct: number;
}

export interface DefenseLevel {
  /** SOL per token. */
  price: number;
  /** Budget allocated to this level, in SOL. */
  budgetSol: number;
  /** Set by the founder himself (through the agent): the desk manager never moves or removes a pinned level. */
  pinned?: boolean;
}

export interface StrategyConfig {
  defense: {
    enabled: boolean;
    levels: DefenseLevel[];
    /**
     * Defense stops buying once price is more than this % under a level: a level that is clearly lost is not
     * chased all the way down. Default 15. The founder can widen it for a level he is sure about.
     */
    maxDistanceBelowPct?: number;
  };
  distribution: {
    enabled: boolean;
    /** Target % of vault tokens to sell per day (never above the rule cap). */
    pctOfVaultPerDay: number;
    /** strength: only sell when buy flow dominates; twap: spread evenly over the day. */
    mode: "strength" | "twap";
    /** Never sell below this price (SOL per token). */
    minPrice?: number;
    /**
     * Strength mode only. Maximum clip multiplier when a real up-move is strongest: the harder real buyers push
     * (bigger 5-minute up-move, stronger buy/sell flow dominance), the more of the day's target the bot sells into
     * that demand, to bank the green candle. 1 = off (flat clips). Always bounded by the daily sell cap, which is
     * the public ceiling on how much supply can leave in 24h, so a bigger boost needs a bigger (public) cap.
     */
    strengthBoost?: number;
  };
  rebalance: {
    enabled: boolean;
    /** Target share of vault value held in SOL, 0..1. */
    targetSolShare: number;
    /** Half-width of the no-trade band around the target, 0..1. */
    band: number;
  };
  clip: {
    minSol: number;
    maxSol: number;
    /** Random jitter applied to clip size and timing, 0..1. */
    jitterPct: number;
  };
}

/**
 * The founder's mandate: what the desk is for, in three words, plus the few numbers that bound it. The desk
 * manager derives and keeps adjusting the strategy (levels, budgets, pace) from the mandate and the market; the
 * founder never has to touch a level. The hard limits stay in `rules` (cap, budgets, floor) and bind every order.
 */
export type MandateProfile =
  | "protect" // priority: hold the price; distribution slow, trailing defense close under the price
  | "balanced" // hold reasonable levels and distribute steadily
  | "distribute"; // priority: move supply into real demand over the horizon; defense light, far below

export type Autonomy =
  | "auto" // the desk decides and informs the founder in one line; only the irreversible is escalated
  | "ask"; // the desk proposes; nothing changes until the founder says yes

export interface Mandate {
  profile: MandateProfile;
  autonomy: Autonomy;
  /** Days over which the founder wants `distributePct` of the vault's tokens sold. Drives the daily pace. */
  horizonDays?: number;
  /** Share of the vault's tokens (at mandate start) to distribute over the horizon, in %. */
  distributePct?: number;
  /** Price (SOL per token) under which the founder wants to be told. Not a floor: the floor is strategy.distribution.minPrice. */
  alertFloor?: number;
  /** When the mandate was set; progress against the horizon is measured from here. */
  startedAt: number;
  /** Vault token balance at mandate start (base units, decimal string), the base for `distributePct`. Filled by the desk on first run. */
  startTokens?: string;
}

export interface ProjectConfig {
  id: string;
  name: string;
  mint: Pubkey;
  decimals: number;
  /** Execution wallet for this project (keypair held by the signer, never by the agent). */
  walletPubkey: Pubkey;
  mode: Mode;
  rules: VaultRules;
  strategy: StrategyConfig;
  telegram?: {
    chatId: string;
    /** Telegram user ids allowed to control the project from that chat; empty or absent = everyone in the chat (private chats only). */
    allowedUserIds?: string[];
  };
  /** Secret the founder must present to /start before any chat can bind to this project. Closes the first-comer window. */
  bindCode?: string;
  /** Referral code used at onboarding, if any. */
  referral?: string;
  /** Fee terms fixed at onboarding; absent = global defaults from the environment. */
  fees?: FeeTerms;
  /** Marketing module settings. */
  marketing?: MarketingConfig;
  /** The founder's mandate; absent = legacy manual project (the founder sets levels himself, the desk stays out). */
  mandate?: Mandate;
  /** Founder-declared wallets at onboarding (also stored in the ledger with their signatures). */
  declaredWallets?: Pubkey[];
  createdAt: number;
  paused: boolean;
}

export interface FeeTerms {
  /** Fee on the SOL leg of every vault trade, in bps (50 = 0.5%). */
  volumeBps: number;
  /** Fee on withdrawals, in bps. */
  cashoutBps: number;
  /** Share of Tenfold fees paid to the referrer, in bps of the fee (1000 = 10%). */
  referralBps: number;
  /** Discount for a referred project, in bps of the fee. */
  discountBps: number;
  /** Wallet that receives the referral share, if the project was referred. */
  referrerWallet?: Pubkey;
}

export interface MarketingConfig {
  /** off: never draft; approve: draft and ask the founder; auto: post without asking. */
  mode: "off" | "approve" | "auto";
  /** X (Twitter) handle for links; posting needs X API credentials in the environment. */
  xHandle?: string;
  /** Telegram channel/chat id to post public updates to. */
  telegramChannelId?: string;
  /** Short description of the tone the founder wants, used when drafting. */
  tone?: string;
}

/** Badge tiers. gold = every insider wallet is in the vault or in a public lock and the classic rug vectors are closed. */
export type BadgeTier = "gold" | "managed" | "flagged" | "beta";

export interface CoverageData {
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  /** LP tokens burned or locked, or the pool is a launchpad pool without withdrawable LP (PumpSwap). */
  lpSecured: boolean;
  /** Token-2022 extensions that can hurt holders (transfer fee, transfer hook, permanent delegate). */
  dangerousExtensions: string[];
  totalSupply: string;
  /** Declared and auto-linked founder wallets with their balances, as % of supply. */
  insiderWallets: { wallet: string; pctOfSupply: number; declared: boolean; locked: boolean }[];
  /** Insider supply outside the vault and outside public locks, as % of supply. */
  insiderOutsidePct: number;
  /** Vault share of supply. */
  vaultPct: number;
  /** Insider sells seen since onboarding. */
  insiderSellCount: number;
  /** Why the tier is what it is, one line each, for the proof page. */
  reasons: string[];
}

export type OrderStatus =
  | "proposed" // produced by a strategy, not yet checked
  | "approved" // passed the risk engine
  | "rejected" // failed the risk engine
  | "sent" // transaction submitted
  | "filled"
  | "failed";

export interface Order {
  id: string;
  projectId: string;
  side: Side;
  reason: ReasonCode;
  /** Input mint and amount in base units. buy: SOL in; sell: token in. */
  inputMint: Pubkey;
  outputMint: Pubkey;
  amountIn: bigint;
  maxSlippageBps: number;
  /** Price observed when the order was proposed, SOL per token. */
  refPrice: number;
  status: OrderStatus;
  createdAt: number;
  updatedAt: number;
  note?: string;
  txSig?: string;
}

export interface Fill {
  orderId: string;
  projectId: string;
  side: Side;
  reason: ReasonCode;
  inAmount: bigint;
  outAmount: bigint;
  /** Effective price, SOL per token. */
  price: number;
  /** Network + priority + Jito fees paid, lamports. */
  feeLamports: bigint;
  slot?: number;
  ts: number;
  txSig?: string;
  paper: boolean;
}

export interface Snapshot {
  projectId: string;
  ts: number;
  /** SOL per token, from a quote of a reference size. */
  price: number;
  /** Pool liquidity on the SOL side, if known (SOL). */
  liquiditySol?: number;
  /** Aggressor buy / sell volume over the last 5 minutes, in SOL, from the trade feed when available. */
  buyFlow5mSol: number;
  sellFlow5mSol: number;
  vaultTokens: bigint;
  vaultLamports: bigint;
}

export type EngineEventType =
  | "sell_pressure"
  | "level_hit"
  | "budget_low"
  | "cap_reached"
  | "circuit_breaker"
  | "order_proposed"
  | "order_rejected"
  | "order_filled"
  | "order_failed"
  | "paused"
  | "resumed"
  | "daily_report"
  | "config_changed"
  | "badge_changed" // {from, to, reasons[]}
  | "insider_sell" // {wallet, amount, pctOfSupply, txSig}
  | "fees_swept" // {netSol, referralSol, txSig, paper}
  | "anchor_posted" // {day, hash, entries, txSig}
  | "post_drafted" // {postId, channel, kind, text}
  | "post_published" // {postId, channel, externalId}
  | "lp_rebalanced" // {positionId, lower, upper, tokens, sol}
  | "desk_decision" // {kind, why, changes, ...}: the desk changed the strategy on its own (autonomy auto)
  | "desk_proposal" // same shape, autonomy ask: nothing applied, the founder is asked
  | "desk_escalation" // {topic, why, options[]}: the desk needs the founder (irreversible or unbounded)
  | "weekly_report"; // a PeriodReport over the last 7 days

export interface EngineEvent<T = Record<string, unknown>> {
  type: EngineEventType;
  projectId: string;
  ts: number;
  data: T;
}

export interface RiskVerdict {
  ok: boolean;
  /** Short machine code when rejected. */
  code?:
    | "paused"
    | "cap"
    | "budget"
    | "budget_day"
    | "pace"
    | "slippage"
    | "circuit"
    | "size"
    | "min_price"
    | "inventory";
  /** Human sentence the agent can relay. */
  reason?: string;
  /** How much of the request can still pass, in the order's input units, when partially capped. */
  allowedAmountIn?: bigint;
}

export interface RollingState {
  /** Tokens sold in the last 24h (base units), including sells approved or sent but not yet filled. */
  soldLast24h: bigint;
  /** The part of soldLast24h still in flight (approved/sent): those tokens still show in the vault balance. */
  pendingSoldLast24h?: bigint;
  /** Lamports spent on defense buys in the last 24h. */
  defenseSpentLast24hLamports: bigint;
  /** Lamports spent on defense buys over the project lifetime. */
  defenseSpentTotalLamports: bigint;
  ordersLastHour: number;
  /** Price 5 minutes ago, if known. */
  price5mAgo?: number;
}
