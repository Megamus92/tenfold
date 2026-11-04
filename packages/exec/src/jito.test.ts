import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecError } from "./errors.js";
import { BUNDLE_POLL_GAP_MS, BUNDLE_POLL_TIMEOUT_MS, JitoClient, TIP_ACCOUNTS_TTL_MS } from "./jito.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const TIPS = ["96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe", "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY"];

interface Call {
  method: string;
  params: unknown[];
}

/** Stub fetch for the Jito JSON-RPC endpoint; `answer` maps a method to its result (or an Error to be thrown as JSON-RPC error). */
function stubJito(answer: (call: Call, n: number) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    expect(url).toBe("https://block.example/api/v1/bundles");
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    const call = { method: body.method, params: body.params };
    calls.push(call);
    const result = answer(call, calls.length);
    if (result instanceof Error) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: result.message } }), { status: 200 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}

describe("JitoClient", () => {
  it("caches tip accounts for 10 minutes and picks one with the injected random", async () => {
    let now = 1_000_000;
    const calls = stubJito(() => TIPS);
    const jito = new JitoClient("https://block.example/", { now: () => now, random: () => 0.99 });
    expect(await jito.getTipAccounts()).toEqual(TIPS);
    expect(await jito.pickTipAccount()).toBe(TIPS[2]);
    now += TIP_ACCOUNTS_TTL_MS - 1;
    expect(await jito.getTipAccounts()).toEqual(TIPS);
    expect(calls.filter((c) => c.method === "getTipAccounts")).toHaveLength(1);
    now += 2;
    expect(await jito.getTipAccounts()).toEqual(TIPS);
    expect(calls.filter((c) => c.method === "getTipAccounts")).toHaveLength(2);
  });

  it("sends a base64 bundle and returns the bundle id", async () => {
    const calls = stubJito(() => "bundle-123");
    const jito = new JitoClient("https://block.example");
    expect(await jito.sendBundle(["AAEC"])).toBe("bundle-123");
    expect(calls[0]).toEqual({ method: "sendBundle", params: [["AAEC"], { encoding: "base64" }] });
  });

  it("maps JSON-RPC errors and HTTP failures to ExecError with the right retryability", async () => {
    stubJito(() => new Error("bundle rejected: no tip"));
    const jito = new JitoClient("https://block.example");
    const err = await jito.sendBundle(["AAEC"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecError);
    expect((err as ExecError).retryable).toBe(false);
    expect((err as ExecError).message).toMatch(/no tip/);

    vi.stubGlobal("fetch", async () => new Response("rate limited", { status: 429 }));
    const err2 = await new JitoClient("https://block.example").sendBundle(["AAEC"]).catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(ExecError);
    expect((err2 as ExecError).retryable).toBe(true);
  });

  it("polls getBundleStatuses every 2 s until the bundle is confirmed and returns its slot", async () => {
    const sleeps: number[] = [];
    let polls = 0;
    stubJito((call) => {
      if (call.method !== "getBundleStatuses") return null;
      polls++;
      expect(call.params).toEqual([["b1"]]);
      if (polls === 1) return { context: { slot: 1 }, value: [] };
      if (polls === 2) return { context: { slot: 2 }, value: [{ bundle_id: "b1", transactions: ["sig1"], slot: 500, confirmation_status: "processed", err: { Ok: null } }] };
      return { context: { slot: 3 }, value: [{ bundle_id: "b1", transactions: ["sig1"], slot: 501, confirmation_status: "confirmed", err: { Ok: null } }] };
    });
    const jito = new JitoClient("https://block.example", { sleep: async (ms) => void sleeps.push(ms) });
    expect(await jito.waitForBundle("b1", "sig1")).toBe(501);
    expect(polls).toBe(3);
    expect(sleeps).toEqual([BUNDLE_POLL_GAP_MS, BUNDLE_POLL_GAP_MS, BUNDLE_POLL_GAP_MS]);
  });

  it("gives up with undefined after 60 s of silence and throws when the landed bundle failed", async () => {
    let polls = 0;
    stubJito(() => {
      polls++;
      return { context: { slot: 1 }, value: [] };
    });
    const jito = new JitoClient("https://block.example", { sleep: async () => undefined });
    expect(await jito.waitForBundle("b2", "sig2")).toBeUndefined();
    expect(polls).toBe(BUNDLE_POLL_TIMEOUT_MS / BUNDLE_POLL_GAP_MS);

    stubJito(() => ({ context: { slot: 1 }, value: [{ bundle_id: "b3", transactions: ["sig3"], slot: 9, confirmation_status: "finalized", err: { InstructionError: [3, { Custom: 6001 }] } }] }));
    const err = await new JitoClient("https://block.example", { sleep: async () => undefined }).waitForBundle("b3", "sig3").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecError);
    expect((err as ExecError).retryable).toBe(false);
    expect((err as ExecError).txSig).toBe("sig3");
  });
});
