import { afterEach, describe, expect, it, vi } from "vitest";
import { JUPITER_API, JupiterClient } from "./jupiter.js";

const quoteBody = {
  inputMint: "So11111111111111111111111111111111111111112",
  outputMint: "Mint111111111111111111111111111111111111111",
  inAmount: "1000000",
  outAmount: "5000000",
  otherAmountThreshold: "4950000",
  slippageBps: 100,
  priceImpactPct: "0.001",
  routePlan: [{}],
};

function fetchSpy(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => new Response(JSON.stringify(quoteBody), { status: 200, headers: { "content-type": "application/json" } }));
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

describe("JupiterClient access", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TENFOLD_JUPITER_API_KEY;
  const originalBase = process.env.TENFOLD_JUPITER_BASE_URL;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TENFOLD_JUPITER_API_KEY;
    else process.env.TENFOLD_JUPITER_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.TENFOLD_JUPITER_BASE_URL;
    else process.env.TENFOLD_JUPITER_BASE_URL = originalBase;
  });

  it("calls api.jup.ag and sends the key from the environment as x-api-key", async () => {
    process.env.TENFOLD_JUPITER_API_KEY = "test-key-123";
    delete process.env.TENFOLD_JUPITER_BASE_URL;
    const spy = fetchSpy();
    const q = await new JupiterClient().quote({ inputMint: quoteBody.inputMint, outputMint: quoteBody.outputMint, amount: 1_000_000n, slippageBps: 100 });
    expect(q.outAmount).toBe(5_000_000n);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.startsWith(`${JUPITER_API}/swap/v1/quote?`)).toBe(true);
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-key-123");
  });

  it("sends no key header when none is configured, and honours an explicit base url", async () => {
    delete process.env.TENFOLD_JUPITER_API_KEY;
    const spy = fetchSpy();
    await new JupiterClient({ baseUrl: "https://router.example/" }).quote({ inputMint: quoteBody.inputMint, outputMint: quoteBody.outputMint, amount: 1n, slippageBps: 50 });
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.startsWith("https://router.example/swap/v1/quote?")).toBe(true);
    expect(init.headers).toEqual({});
  });

  it("an empty TENFOLD_JUPITER_BASE_URL means the default host", async () => {
    process.env.TENFOLD_JUPITER_BASE_URL = "";
    const spy = fetchSpy();
    await new JupiterClient().quote({ inputMint: quoteBody.inputMint, outputMint: quoteBody.outputMint, amount: 1n, slippageBps: 50 });
    const [url] = spy.mock.calls[0] as unknown as [string];
    expect(url.startsWith(`${JUPITER_API}/swap/v1/quote?`)).toBe(true);
  });

  it("an explicit apiKey beats the environment", async () => {
    process.env.TENFOLD_JUPITER_API_KEY = "env-key";
    const spy = fetchSpy();
    await new JupiterClient({ apiKey: "ctor-key" }).quote({ inputMint: quoteBody.inputMint, outputMint: quoteBody.outputMint, amount: 1n, slippageBps: 50 });
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("ctor-key");
  });
});
