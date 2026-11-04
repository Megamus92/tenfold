/**
 * Channels: where an approved post goes. One client per network, each with the same tiny contract, so the
 * scheduler never knows which API it is talking to and tests can plug a fake.
 *
 *  - XClient: X API v2 `POST /2/tweets`, signed with OAuth 1.0a user context (HMAC-SHA1, node:crypto only).
 *  - TelegramChannel: Bot API `sendMessage` to the project's public channel; the bot must be an admin there.
 *  - LogChannel: dry run, logs the text and returns a fake id (TENFOLD_MARKETING_DRY_RUN=1).
 */
import { createHmac, randomBytes } from "node:crypto";
import { logger } from "@tenfold/core";
import type { ProjectConfig } from "@tenfold/core";

export type ChannelName = "x" | "telegram";

export interface Published {
  /** The network's id for the post (tweet id, Telegram message id). */
  externalId: string;
  /** Public link to the post when it can be built. */
  url?: string;
}

export interface Channel {
  readonly name: ChannelName;
  /** True when this channel can post for the project (credentials present, target configured). */
  enabledFor(cfg: ProjectConfig): boolean;
  publish(text: string, cfg: ProjectConfig): Promise<Published>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** Error carrying the HTTP status, so the scheduler can tell a rate limit from a rejected text. */
export class ChannelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ChannelError";
  }
}

// ---------- OAuth 1.0a ----------

export interface OAuthCreds {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

/** RFC 3986 percent-encoding, as OAuth 1.0a requires (encodeURIComponent leaves !'()* alone). */
export function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * The signature base string for a request: method, base URL and the sorted, encoded parameters (query/form
 * parameters plus the oauth_* ones). A JSON body contributes no parameters.
 */
export function signatureBase(method: string, url: string, params: Record<string, string>): string {
  const pairs = Object.entries(params).map(([k, v]) => [rfc3986(k), rfc3986(v)] as const);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const paramString = pairs.map(([k, v]) => `${k}=${v}`).join("&");
  const base = url.split("?")[0] ?? url;
  return [method.toUpperCase(), rfc3986(base), rfc3986(paramString)].join("&");
}

export function hmacSha1Signature(base: string, consumerSecret: string, tokenSecret: string): string {
  const key = `${rfc3986(consumerSecret)}&${rfc3986(tokenSecret)}`;
  return createHmac("sha1", key).update(base).digest("base64");
}

/**
 * Build the `Authorization: OAuth ...` header for a request. `params` are the request's query or form
 * parameters (none for a JSON body). nonce and timestamp are injectable for tests.
 */
export function oauthHeader(
  creds: OAuthCreds,
  method: string,
  url: string,
  params: Record<string, string> = {},
  nonce: string = randomBytes(16).toString("hex"),
  timestamp: string = String(Math.floor(Date.now() / 1000)),
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: creds.token,
    oauth_version: "1.0",
  };
  const base = signatureBase(method, url, { ...params, ...oauth });
  oauth.oauth_signature = hmacSha1Signature(base, creds.consumerSecret, creds.tokenSecret);
  const header = Object.keys(oauth)
    .sort()
    .map((k) => `${rfc3986(k)}="${rfc3986(oauth[k]!)}"`)
    .join(", ");
  return `OAuth ${header}`;
}

// ---------- X ----------

export interface XClientOptions {
  creds: OAuthCreds;
  /** Default https://api.x.com */
  baseUrl?: string;
  fetch?: FetchLike;
  /** Handle of the posting account, for the link in post_published (without @). */
  accountHandle?: string;
}

export class XClient implements Channel {
  readonly name = "x" as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: XClientOptions) {
    this.baseUrl = (opts.baseUrl ?? "https://api.x.com").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  enabledFor(cfg: ProjectConfig): boolean {
    return cfg.marketing !== undefined && cfg.marketing.mode !== "off";
  }

  async publish(text: string, _cfg: ProjectConfig): Promise<Published> {
    const url = `${this.baseUrl}/2/tweets`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: oauthHeader(this.opts.creds, "POST", url),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ text }),
    });
    const raw = await res.text();
    if (!res.ok) throw new ChannelError(`X API ${res.status}: ${raw.slice(0, 300)}`, res.status);
    let id: string | undefined;
    try {
      const parsed = JSON.parse(raw) as { data?: { id?: string } };
      id = parsed.data?.id;
    } catch {
      // handled below
    }
    if (!id) throw new ChannelError(`X API returned no tweet id: ${raw.slice(0, 300)}`, res.status);
    const handle = this.opts.accountHandle?.replace(/^@/, "");
    return { externalId: id, url: handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/status/${id}` };
  }
}

// ---------- Telegram ----------

export interface TelegramChannelOptions {
  /** Bot token of the bot that is an admin of the projects' channels. */
  token: string;
  baseUrl?: string;
  fetch?: FetchLike;
}

export class TelegramChannel implements Channel {
  readonly name = "telegram" as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: TelegramChannelOptions) {
    this.baseUrl = (opts.baseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  enabledFor(cfg: ProjectConfig): boolean {
    return cfg.marketing !== undefined && cfg.marketing.mode !== "off" && Boolean(cfg.marketing.telegramChannelId);
  }

  async publish(text: string, cfg: ProjectConfig): Promise<Published> {
    const chatId = cfg.marketing?.telegramChannelId;
    if (!chatId) throw new ChannelError("project has no marketing.telegramChannelId");
    const url = `${this.baseUrl}/bot${this.opts.token}/sendMessage`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
    });
    const raw = await res.text();
    if (!res.ok) throw new ChannelError(`Telegram API ${res.status}: ${raw.replace(this.opts.token, "<token>").slice(0, 300)}`, res.status);
    let parsed: { ok?: boolean; result?: { message_id?: number; chat?: { username?: string; id?: number } } } = {};
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      // handled below
    }
    const messageId = parsed.result?.message_id;
    if (!parsed.ok || messageId === undefined) throw new ChannelError(`Telegram API returned no message id: ${raw.slice(0, 300)}`, res.status);
    const username = parsed.result?.chat?.username ?? (chatId.startsWith("@") ? chatId.slice(1) : undefined);
    return { externalId: String(messageId), url: username ? `https://t.me/${username}/${messageId}` : undefined };
  }
}

// ---------- dry run ----------

/** Logs instead of posting. Used with TENFOLD_MARKETING_DRY_RUN=1 and in the e2e simulation. */
export class LogChannel implements Channel {
  readonly posted: { text: string; projectId: string }[] = [];
  constructor(
    readonly name: ChannelName,
    private readonly requireTarget = false,
  ) {}

  enabledFor(cfg: ProjectConfig): boolean {
    if (!cfg.marketing || cfg.marketing.mode === "off") return false;
    return this.requireTarget ? Boolean(cfg.marketing.telegramChannelId) : true;
  }

  async publish(text: string, cfg: ProjectConfig): Promise<Published> {
    this.posted.push({ text, projectId: cfg.id });
    logger.info("dry-run post", { channel: this.name, project: cfg.id, chars: text.length, text });
    return { externalId: `dry-run:${Date.now()}:${this.posted.length}` };
  }
}
