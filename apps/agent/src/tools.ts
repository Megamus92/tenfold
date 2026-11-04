/**
 * Bounded tool surface the model can call. Every tool is a strict JSON schema; `parseToolCall` turns a raw
 * tool_use input into a typed call or an error sentence, so nothing unvalidated reaches the actions.
 */
import type Anthropic from "@anthropic-ai/sdk";

export type Tool = Anthropic.Tool;

export type ToolCall =
  | { name: "get_status" }
  | { name: "set_defense_level"; input: { price: number; budgetSol: number; action: "add" | "remove" } }
  | {
      name: "set_distribution";
      input: { enabled: boolean; pctOfVaultPerDay: number; mode: "strength" | "twap"; minPrice?: number };
    }
  | { name: "set_defense_budget"; input: { budgetSol: number; maxPerDaySol: number } }
  | { name: "lower_daily_cap"; input: { pct: number } }
  | { name: "request_raise_daily_cap"; input: { pct: number } }
  | { name: "pause" }
  | { name: "resume" }
  | { name: "manual_order"; input: { side: "buy" | "sell"; amountSol?: number; amountTokens?: number; note: string } }
  | { name: "cost_to_hold"; input: { price: number } }
  | { name: "daily_report" }
  | { name: "list_posts"; input: { status?: PostStatusFilter } }
  | { name: "approve_post"; input: { postId: string } }
  | { name: "reject_post"; input: { postId: string } }
  | { name: "set_marketing"; input: MarketingInput }
  | { name: "set_mandate"; input: MandateInput };

export interface MandateInput {
  profile?: "protect" | "balanced" | "distribute";
  autonomy?: "auto" | "ask";
  horizonDays?: number;
  distributePct?: number;
  /** 0 removes the alert floor. */
  alertFloor?: number;
}

export type PostStatusFilter = "draft" | "approved" | "posted" | "failed" | "rejected" | "all";

export interface MarketingInput {
  mode?: "off" | "approve" | "auto";
  tone?: string;
  /** X handle without the @; empty string removes it. */
  xHandle?: string;
  /** Telegram channel id (@name or -100...); empty string removes it. */
  telegramChannelId?: string;
}

export type ToolName = ToolCall["name"];

/** Tools whose executor returns a confirmation request instead of acting. Listed so the model can say so upfront. */
export const CONFIRMED_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  "set_defense_level",
  "set_distribution",
  "set_defense_budget",
  "request_raise_daily_cap",
  "resume",
  "manual_order",
  "approve_post",
  "set_marketing",
]);

const price = { type: "number", exclusiveMinimum: 0, description: "Price in SOL per whole token, e.g. 0.00021." };
const sol = (description: string) => ({ type: "number", minimum: 0, description });
const pct = (description: string) => ({ type: "number", minimum: 0, maximum: 100, description });

export const TOOLS: Tool[] = [
  {
    name: "get_status",
    description:
      "Read the project's current state from the ledger: latest price and 5-minute buy/sell flow, vault balances in tokens and SOL, the rules (daily sell cap, defense budget, per-day defense limit, slippage, pace, circuit breaker), how much of today's sell cap is used, how much defense budget is left in total and for today, the defense levels and distribution settings, pending cap raises, the paused flag and the last 5 fills. Call this before answering any question about numbers, before proposing a change, and whenever the founder asks how things are going. It never changes anything and needs no confirmation.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "set_defense_level",
    description:
      "Add, update or remove a defense level: a price (SOL per token) at which Tenfold places real buys with a budget in SOL allocated to that level. action 'add' creates the level or updates the budget of an existing level at that price, and enables defense if it was off; action 'remove' deletes the level at that price (budgetSol is then ignored but must be sent, use 0). The budget must fit inside the remaining defense budget of the rules; if it does not, the tool refuses and tells you how much is left, in which case suggest set_defense_budget or a smaller amount. This changes a parameter, so the founder is asked to confirm with a button; nothing is applied until they tap Yes. Price every level in SOL before proposing it (use cost_to_hold).",
    input_schema: {
      type: "object",
      properties: {
        price,
        budgetSol: sol("SOL allocated to this level. Use 0 when removing."),
        action: { type: "string", enum: ["add", "remove"], description: "'add' creates or updates the level; 'remove' deletes it." },
      },
      required: ["price", "budgetSol", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "set_distribution",
    description:
      "Configure distribution, the programme that sells a small share of the vault every day into real buy flow. enabled turns it on or off; pctOfVaultPerDay is the target share of the vault's tokens to sell per day and is clamped to the rules' daily sell cap (the tool tells you when it clamps, and the cap itself can only be raised through request_raise_daily_cap with a 48h delay); mode 'strength' sells only when buyers dominate, 'twap' spreads sells evenly over the day; minPrice is a floor below which distribution never sells (omit it to keep the current floor, send 0 to remove the floor). The founder confirms with a button before anything applies.",
    input_schema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "Turn distribution on (true) or off (false)." },
        pctOfVaultPerDay: pct("Target % of the vault's token balance to sell per day; clamped to the daily sell cap."),
        mode: { type: "string", enum: ["strength", "twap"], description: "'strength' sells into buy flow only; 'twap' spreads evenly over the day." },
        minPrice: { type: "number", minimum: 0, description: "Floor in SOL per token. Omit to keep the current floor, 0 to remove it." },
      },
      required: ["enabled", "pctOfVaultPerDay", "mode"],
      additionalProperties: false,
    },
  },
  {
    name: "set_defense_budget",
    description:
      "Set the defense budget rules: budgetSol is the total SOL Tenfold may ever spend on defense buys for this project (already-spent SOL counts against it), maxPerDaySol is the hard ceiling on defense spend in any rolling 24 hours. Both are in SOL. Use this when a level needs more budget than is left, or when the founder wants to cap the daily bleed. The founder confirms with a button before it applies.",
    input_schema: {
      type: "object",
      properties: {
        budgetSol: sol("Lifetime defense budget in SOL."),
        maxPerDaySol: sol("Maximum defense spend per rolling 24h, in SOL."),
      },
      required: ["budgetSol", "maxPerDaySol"],
      additionalProperties: false,
    },
  },
  {
    name: "lower_daily_cap",
    description:
      "Lower the daily sell cap (max % of the vault's tokens that may be sold per rolling 24h) to pct, effective immediately and without confirmation, because it only reduces risk. pct must be below the current cap. Distribution's daily target is clamped down with it, and any pending cap raise is cancelled. Use request_raise_daily_cap to go the other way.",
    input_schema: {
      type: "object",
      properties: { pct: pct("New daily sell cap in % of the vault, below the current one.") },
      required: ["pct"],
      additionalProperties: false,
    },
  },
  {
    name: "request_raise_daily_cap",
    description:
      "Ask to raise the daily sell cap to pct. Raising the cap is the one change that lets more tokens leave the vault, so it never applies at once: it is recorded as a pending change that applies automatically 48 hours later, and the founder can cancel it any time before then by lowering the cap. The founder confirms the request with a button. Always tell the founder the exact time it will apply, which the tool returns.",
    input_schema: {
      type: "object",
      properties: { pct: pct("New daily sell cap in % of the vault, above the current one.") },
      required: ["pct"],
      additionalProperties: false,
    },
  },
  {
    name: "pause",
    description:
      "Pause the project immediately: no new orders of any kind until resumed. Instant and without confirmation, because stopping is always safe. Use it the moment the founder asks to stop, halt, pause or freeze, or when they sound alarmed and want nothing to happen.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "resume",
    description:
      "Resume a paused project so defense, distribution and rebalancing run again. Because resuming lets Tenfold spend again, the founder confirms with a button first. If the project was paused by the circuit breaker, mention that the move that triggered it may still be in progress.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "manual_order",
    description:
      "Queue a one-off order the founder explicitly asked for. A buy takes amountSol (SOL to spend); a sell takes amountTokens (whole tokens to sell). If only the other unit is given, the tool converts it at the latest price and says so. The order is pre-checked against the risk engine (cap, budget, pace, slippage, circuit breaker, paused flag) and refused with the reason if it would not pass; when it passes, the founder confirms with a button and the order is sent to the engine, which validates it again at execution. Always put a short note saying why the founder wants it. Never use this to trade against the project's own orders or to create volume; refuse those requests.",
    input_schema: {
      type: "object",
      properties: {
        side: { type: "string", enum: ["buy", "sell"] },
        amountSol: { type: "number", exclusiveMinimum: 0, description: "SOL to spend (buy) or target proceeds (sell, converted at the latest price)." },
        amountTokens: { type: "number", exclusiveMinimum: 0, description: "Whole tokens to sell (sell) or to acquire (buy, converted at the latest price)." },
        note: { type: "string", maxLength: 200, description: "Why the founder wants this, in their words." },
      },
      required: ["side", "note"],
      additionalProperties: false,
    },
  },
  {
    name: "cost_to_hold",
    description:
      "Estimate what defending a price level costs right now: SOL per hour at the current excess of sells over buys, how many hours the budget allocated to that level (or the remaining defense budget) would last, how many hours today's defense limit would last, and how far the level is below the current price. Use it before proposing or discussing any level, and to answer 'can we hold X'. Read-only, no confirmation.",
    input_schema: {
      type: "object",
      properties: { price },
      required: ["price"],
      additionalProperties: false,
    },
  },
  {
    name: "daily_report",
    description:
      "The last 24 hours in numbers: fills by reason, tokens sold and SOL received with the distribution VWAP versus the token's own VWAP, tokens bought and SOL spent on defense, fees, open and close price, vault balances. Read-only. Use it when the founder asks for a report, a recap, or 'how did we do'.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_posts",
    description:
      "List the project's marketing posts: drafts waiting for the founder's approval, posts already published (with their links), failed or rejected ones. Each post has a short id the founder can refer to. The marketing module writes these posts from the ledger only (daily recap, milestones, a level that held, withdrawal notices, badge changes); nothing in them is invented. Read-only. Use it when the founder asks what is waiting, what was posted, or whether marketing is working. Status 'all' lists everything; default is 'draft'.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["draft", "approved", "posted", "failed", "rejected", "all"], description: "Which posts to list. Default 'draft'." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "approve_post",
    description:
      "Approve a drafted marketing post so the marketing process publishes it on its channel (X or the project's Telegram channel) within about a minute. postId is the short id from list_posts or from the draft alert. The exact text to be published is shown to the founder, who confirms with a button; nothing is published before they tap Yes. Works on a failed post too (to retry it). The text cannot be edited: a post is approved or rejected as drafted, so it stays what the ledger says.",
    input_schema: {
      type: "object",
      properties: { postId: { type: "string", minLength: 4, maxLength: 36, description: "Post id or its first characters (at least 4)." } },
      required: ["postId"],
      additionalProperties: false,
    },
  },
  {
    name: "reject_post",
    description:
      "Reject a drafted marketing post: it is never published. Instant and without confirmation, because not posting is always safe. postId is the short id from list_posts or from the draft alert.",
    input_schema: {
      type: "object",
      properties: { postId: { type: "string", minLength: 4, maxLength: 36, description: "Post id or its first characters (at least 4)." } },
      required: ["postId"],
      additionalProperties: false,
    },
  },
  {
    name: "set_marketing",
    description:
      "Configure the marketing module for this project. mode: 'off' (no posts), 'approve' (Tenfold drafts, the founder approves each post with a button), 'auto' (posts without asking). tone: a short description of the register the founder wants (casual, formal...), which only changes the wording, never the facts. xHandle: the project's X handle for mentions (without @; send an empty string to remove). telegramChannelId: the public Telegram channel to post to (@name or -100...; the Tenfold bot must be an admin there; empty string to remove). Omit a field to keep it. The founder confirms with a button. Posts always come from the ledger and the chain: daily recap, milestones, levels that held, withdrawal transparency notes and badge changes (downgrades included). If the founder asks for paid callers, shill groups, engagement farming, fake holders, fake volume on trackers or to hide a downgrade, refuse and say why: the badge is worth something only because Tenfold never does that, for anyone.",
    input_schema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["off", "approve", "auto"], description: "Posting mode." },
        tone: { type: "string", maxLength: 200, description: "Register for the wording, e.g. 'casual' or 'formal'. Facts never change." },
        xHandle: { type: "string", maxLength: 32, description: "Project X handle without the @. Empty string removes it." },
        telegramChannelId: { type: "string", maxLength: 64, description: "Telegram channel id, @name or -100... Empty string removes it." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "set_mandate",
    description:
      "Set or change the founder's mandate: what the desk is for. profile: 'protect' (hold the price first, distribute slowly, two trailing levels close under the price), 'balanced' (one level, steady distribution), 'distribute' (move supply first, light defense far below). horizonDays and distributePct: distribute that share of the vault over that many days (the desk paces it, never above the daily cap). alertFloor: price under which the founder wants to be told (not a selling floor). autonomy: 'auto' (the desk decides and informs, default) or 'ask' (the desk proposes, nothing changes without a yes). With a mandate the desk places and moves defense levels and sets the pace itself; levels the founder adds with set_defense_level are pinned and never touched. Asks for confirmation.",
    input_schema: {
      type: "object",
      properties: {
        profile: { type: "string", enum: ["protect", "balanced", "distribute"], description: "What matters most to the founder." },
        autonomy: { type: "string", enum: ["auto", "ask"], description: "auto: decide and inform; ask: propose and wait." },
        horizonDays: { type: "number", minimum: 1, maximum: 365, description: "Days over which distributePct of the vault should be sold." },
        distributePct: { type: "number", minimum: 0, maximum: 100, description: "Share of the vault's tokens to distribute over the horizon, in %." },
        alertFloor: { type: "number", minimum: 0, description: "Price (SOL per token) under which to tell the founder. 0 removes it." },
      },
      additionalProperties: false,
    },
  },
];

type Parsed = ToolCall | { error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function num(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function bool(o: Record<string, unknown>, k: string): boolean | undefined {
  const v = o[k];
  return typeof v === "boolean" ? v : undefined;
}
function str(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === "string" ? v : undefined;
}
function oneOf<T extends string>(v: string | undefined, allowed: readonly T[]): T | undefined {
  return allowed.find((a) => a === v);
}

/** Validate a raw tool_use input against the tool's contract. */
export function parseToolCall(name: string, input: unknown): Parsed {
  const o: Record<string, unknown> = isRecord(input) ? input : {};
  switch (name) {
    case "get_status":
    case "pause":
    case "resume":
    case "daily_report":
      return { name };
    case "set_defense_level": {
      const price = num(o, "price");
      const budgetSol = num(o, "budgetSol");
      const action = oneOf(str(o, "action"), ["add", "remove"] as const);
      if (price === undefined || price <= 0) return { error: "price must be a positive number (SOL per token)." };
      if (budgetSol === undefined || budgetSol < 0) return { error: "budgetSol must be a number >= 0." };
      if (!action) return { error: "action must be 'add' or 'remove'." };
      return { name, input: { price, budgetSol, action } };
    }
    case "set_distribution": {
      const enabled = bool(o, "enabled");
      const pctOfVaultPerDay = num(o, "pctOfVaultPerDay");
      const mode = oneOf(str(o, "mode"), ["strength", "twap"] as const);
      const minPrice = num(o, "minPrice");
      if (enabled === undefined) return { error: "enabled must be true or false." };
      if (pctOfVaultPerDay === undefined || pctOfVaultPerDay < 0 || pctOfVaultPerDay > 100)
        return { error: "pctOfVaultPerDay must be between 0 and 100." };
      if (!mode) return { error: "mode must be 'strength' or 'twap'." };
      if (o["minPrice"] !== undefined && (minPrice === undefined || minPrice < 0)) return { error: "minPrice must be a number >= 0." };
      return { name, input: { enabled, pctOfVaultPerDay, mode, ...(minPrice !== undefined ? { minPrice } : {}) } };
    }
    case "set_defense_budget": {
      const budgetSol = num(o, "budgetSol");
      const maxPerDaySol = num(o, "maxPerDaySol");
      if (budgetSol === undefined || budgetSol < 0) return { error: "budgetSol must be a number >= 0." };
      if (maxPerDaySol === undefined || maxPerDaySol < 0) return { error: "maxPerDaySol must be a number >= 0." };
      return { name, input: { budgetSol, maxPerDaySol } };
    }
    case "lower_daily_cap":
    case "request_raise_daily_cap": {
      const pct = num(o, "pct");
      if (pct === undefined || pct < 0 || pct > 100) return { error: "pct must be between 0 and 100." };
      return { name, input: { pct } };
    }
    case "manual_order": {
      const side = oneOf(str(o, "side"), ["buy", "sell"] as const);
      const amountSol = num(o, "amountSol");
      const amountTokens = num(o, "amountTokens");
      const note = str(o, "note") ?? "";
      if (!side) return { error: "side must be 'buy' or 'sell'." };
      if (amountSol === undefined && amountTokens === undefined) return { error: "Give amountSol or amountTokens." };
      if (amountSol !== undefined && amountSol <= 0) return { error: "amountSol must be positive." };
      if (amountTokens !== undefined && amountTokens <= 0) return { error: "amountTokens must be positive." };
      return {
        name,
        input: {
          side,
          note: note.slice(0, 200),
          ...(amountSol !== undefined ? { amountSol } : {}),
          ...(amountTokens !== undefined ? { amountTokens } : {}),
        },
      };
    }
    case "cost_to_hold": {
      const price = num(o, "price");
      if (price === undefined || price <= 0) return { error: "price must be a positive number (SOL per token)." };
      return { name, input: { price } };
    }
    case "list_posts": {
      const status = oneOf(str(o, "status"), ["draft", "approved", "posted", "failed", "rejected", "all"] as const);
      if (o["status"] !== undefined && !status) return { error: "status must be one of draft, approved, posted, failed, rejected, all." };
      return { name, input: status ? { status } : {} };
    }
    case "approve_post":
    case "reject_post": {
      const postId = (str(o, "postId") ?? "").trim();
      if (!/^[0-9a-f-]{4,36}$/i.test(postId)) return { error: "postId must be the post's id or at least its first 4 characters." };
      return { name, input: { postId } };
    }
    case "set_marketing": {
      const mode = oneOf(str(o, "mode"), ["off", "approve", "auto"] as const);
      if (o["mode"] !== undefined && !mode) return { error: "mode must be 'off', 'approve' or 'auto'." };
      const tone = str(o, "tone");
      if (tone !== undefined && tone.length > 200) return { error: "tone must be at most 200 characters." };
      const xHandle = str(o, "xHandle")?.trim().replace(/^@/, "");
      if (xHandle !== undefined && xHandle !== "" && !/^[A-Za-z0-9_]{1,15}$/.test(xHandle)) return { error: "xHandle must be 1-15 letters, digits or underscores." };
      const telegramChannelId = str(o, "telegramChannelId")?.trim();
      if (telegramChannelId !== undefined && telegramChannelId !== "" && !/^(@[A-Za-z0-9_]{5,32}|-?\d{5,20})$/.test(telegramChannelId)) {
        return { error: "telegramChannelId must be @name (5-32 characters) or a numeric chat id." };
      }
      if (mode === undefined && tone === undefined && xHandle === undefined && telegramChannelId === undefined) return { error: "Give at least one field to change." };
      return {
        name,
        input: {
          ...(mode !== undefined ? { mode } : {}),
          ...(tone !== undefined ? { tone: tone.trim() } : {}),
          ...(xHandle !== undefined ? { xHandle } : {}),
          ...(telegramChannelId !== undefined ? { telegramChannelId } : {}),
        },
      };
    }
    case "set_mandate": {
      const profile = oneOf(str(o, "profile"), ["protect", "balanced", "distribute"] as const);
      if (o["profile"] !== undefined && !profile) return { error: "profile must be 'protect', 'balanced' or 'distribute'." };
      const autonomy = oneOf(str(o, "autonomy"), ["auto", "ask"] as const);
      if (o["autonomy"] !== undefined && !autonomy) return { error: "autonomy must be 'auto' or 'ask'." };
      const horizonDays = num(o, "horizonDays");
      if (o["horizonDays"] !== undefined && (horizonDays === undefined || horizonDays < 1 || horizonDays > 365)) return { error: "horizonDays must be between 1 and 365." };
      const distributePct = num(o, "distributePct");
      if (o["distributePct"] !== undefined && (distributePct === undefined || distributePct < 0 || distributePct > 100)) return { error: "distributePct must be between 0 and 100." };
      const alertFloor = num(o, "alertFloor");
      if (o["alertFloor"] !== undefined && (alertFloor === undefined || alertFloor < 0)) return { error: "alertFloor must be a number >= 0 (0 removes it)." };
      if (profile === undefined && autonomy === undefined && horizonDays === undefined && distributePct === undefined && alertFloor === undefined) return { error: "Give at least one field to change." };
      return {
        name,
        input: {
          ...(profile !== undefined ? { profile } : {}),
          ...(autonomy !== undefined ? { autonomy } : {}),
          ...(horizonDays !== undefined ? { horizonDays } : {}),
          ...(distributePct !== undefined ? { distributePct } : {}),
          ...(alertFloor !== undefined ? { alertFloor } : {}),
        },
      };
    }
    default:
      return { error: `Unknown tool '${name}'.` };
  }
}
