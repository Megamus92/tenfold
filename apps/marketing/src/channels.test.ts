import { describe, expect, it } from "vitest";
import { ChannelError, TelegramChannel, XClient, hmacSha1Signature, oauthHeader, rfc3986, signatureBase } from "./channels.js";
import type { FetchLike } from "./channels.js";
import { project } from "./testkit.js";

// The worked example from the X developer docs ("Creating a signature").
const CREDS = {
  consumerKey: "xvz1evFS4wEEPTGEFPHBog",
  consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
  token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
  tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
};
const NONCE = "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg";
const TS = "1318622958";

describe("OAuth 1.0a", () => {
  it("percent-encodes per RFC 3986", () => {
    expect(rfc3986("Hello Ladies + Gentlemen, a signed OAuth request!")).toBe("Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21");
    expect(rfc3986("a*b'c(d)e!")).toBe("a%2Ab%27c%28d%29e%21");
  });

  it("reproduces the documented signature base string and signature", () => {
    const params = {
      include_entities: "true",
      status: "Hello Ladies + Gentlemen, a signed OAuth request!",
      oauth_consumer_key: CREDS.consumerKey,
      oauth_nonce: NONCE,
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: TS,
      oauth_token: CREDS.token,
      oauth_version: "1.0",
    };
    const base = signatureBase("post", "https://api.twitter.com/1.1/statuses/update.json", params);
    expect(base).toBe(
      "POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521",
    );
    expect(hmacSha1Signature(base, CREDS.consumerSecret, CREDS.tokenSecret)).toBe("hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
  });

  it("builds the Authorization header with every oauth_ parameter quoted and sorted", () => {
    const header = oauthHeader(CREDS, "POST", "https://api.twitter.com/1.1/statuses/update.json", { include_entities: "true", status: "Hello Ladies + Gentlemen, a signed OAuth request!" }, NONCE, TS);
    expect(header.startsWith("OAuth oauth_consumer_key=\"xvz1evFS4wEEPTGEFPHBog\", oauth_nonce=\"")).toBe(true);
    expect(header).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
    expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(header.endsWith('oauth_version="1.0"')).toBe(true);
  });
});

function fakeFetch(status: number, body: unknown): { fetch: FetchLike; calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] } {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
  return { fetch, calls };
}

describe("XClient", () => {
  it("posts JSON to /2/tweets with an OAuth header and returns the tweet id and link", async () => {
    const { fetch, calls } = fakeFetch(201, { data: { id: "1790000000000000001", text: "hello" } });
    const x = new XClient({ creds: CREDS, fetch, accountHandle: "@tenfold_mm" });
    const res = await x.publish("hello", project());
    expect(res).toEqual({ externalId: "1790000000000000001", url: "https://x.com/tenfold_mm/status/1790000000000000001" });
    expect(calls[0]!.url).toBe("https://api.x.com/2/tweets");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe('{"text":"hello"}');
    expect(calls[0]!.init.headers.Authorization).toMatch(/^OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="[0-9a-f]{32}", oauth_signature="/);
  });

  it("throws a ChannelError carrying the status on failure", async () => {
    const { fetch } = fakeFetch(429, { title: "Too Many Requests" });
    const x = new XClient({ creds: CREDS, fetch });
    await expect(x.publish("hello", project())).rejects.toMatchObject({ name: "ChannelError", status: 429 });
  });

  it("is enabled for any project with marketing on", () => {
    const x = new XClient({ creds: CREDS, fetch: fakeFetch(200, {}).fetch });
    expect(x.enabledFor(project())).toBe(true);
    expect(x.enabledFor(project({ marketing: { mode: "off" } }))).toBe(false);
    expect(x.enabledFor(project({ marketing: undefined }))).toBe(false);
  });
});

describe("TelegramChannel", () => {
  it("sends to the project's channel id and builds a t.me link for public channels", async () => {
    const { fetch, calls } = fakeFetch(200, { ok: true, result: { message_id: 42, chat: { id: -100123, username: "alphacoin_news" } } });
    const tg = new TelegramChannel({ token: "123:ABC", fetch });
    const cfg = project();
    expect(tg.enabledFor(cfg)).toBe(true);
    expect(tg.enabledFor(project({ marketing: { mode: "approve" } }))).toBe(false);
    const res = await tg.publish("hello channel", cfg);
    expect(res).toEqual({ externalId: "42", url: "https://t.me/alphacoin_news/42" });
    expect(calls[0]!.url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ chat_id: "@alphacoin_news", text: "hello channel", disable_web_page_preview: false });
  });

  it("never leaks the bot token in an error", async () => {
    const { fetch } = fakeFetch(403, { ok: false, description: "Forbidden: bot is not a member of the channel chat 123:ABC" });
    const tg = new TelegramChannel({ token: "123:ABC", fetch });
    const err = await tg.publish("x", project()).catch((e: ChannelError) => e);
    expect(err).toBeInstanceOf(ChannelError);
    expect((err as ChannelError).message).not.toContain("123:ABC");
    expect((err as ChannelError).status).toBe(403);
  });
});
