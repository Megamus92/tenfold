/**
 * Thin client for the Jupiter Swap API (Metis V1 paths on api.jup.ag): quotes and swap-transaction building.
 * Shared by JupiterFeed (prices) and JupiterExecutor / PaperExecutor (fills).
 *
 * Access: api.jup.ag wants an API key in the `x-api-key` header (free key from portal.jup.ag; keyless calls are
 * throttled to about 0.5 req/s and lite-api.jup.ag is deprecated). The key is read from TENFOLD_JUPITER_API_KEY
 * unless passed explicitly; TENFOLD_JUPITER_BASE_URL overrides the host (self-hosted router, or lite-api while it lasts).
 * Swap V2 (/swap/v2/order + /execute) is the successor; the migration is tracked in the deployment plan.
 */
import { asNumber, asRecord, asString, fetchJson, parseBigint, DEFAULT_HTTP_TIMEOUT_MS } from "./http.js";

export const JUPITER_API = "https://api.jup.ag";
/** @deprecated lite-api.jup.ag is being retired by Jupiter; kept for local experiments only. */
export const JUPITER_LITE_API = "https://lite-api.jup.ag";

export interface QuoteParams {
  inputMint: string;
  outputMint: string;
  /** Base units of the input mint (ExactIn). */
  amount: bigint;
  slippageBps: number;
  /** Only route through major intermediate tokens; recommended for live execution. */
  restrictIntermediateTokens?: boolean;
}

/** The fields of a Jupiter quote Tenfold relies on, plus the untouched response for the swap call. */
export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  /** Minimum out (ExactIn) after slippage, as returned by Jupiter. */
  otherAmountThreshold: bigint;
  slippageBps: number;
  /** Price impact as a fraction (0.01 = 1%), parsed from Jupiter's `priceImpactPct` string. */
  priceImpact: number;
  /** Number of hops in the chosen route. */
  hops: number;
  contextSlot?: number;
  /** Full response body, passed verbatim as `quoteResponse` to /swap. */
  raw: Record<string, unknown>;
}

export interface SwapFeeOptions {
  /** Priority fee: let Jupiter size it at level "high", capped at this many lamports. */
  priorityMaxLamports: bigint;
}

export interface SwapResponse {
  /** Base64 serialized VersionedTransaction, unsigned. */
  swapTransaction: string;
  lastValidBlockHeight: number;
  /** Priority fee Jupiter actually set, lamports, when reported. */
  prioritizationFeeLamports?: number;
  computeUnitLimit?: number;
}

/** Anything that can produce a Jupiter-shaped quote (the live client or a test double). */
export interface Quoter {
  quote(params: QuoteParams): Promise<JupiterQuote>;
}

/** Thrown when Jupiter answers with an error or an unparseable body; `status` is the HTTP status when known. */
export class JupiterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "JupiterError";
  }
}

/** Parse a raw Jupiter quote body into a typed JupiterQuote; throws JupiterError on a malformed body. */
export function parseQuote(body: unknown): JupiterQuote {
  const o = asRecord(body);
  if (!o) throw new JupiterError("quote: response is not an object");
  const errMsg = asString(o.error) ?? asString(o.errorMessage);
  if (errMsg) throw new JupiterError(`quote: ${errMsg}`);
  try {
    const routePlan = Array.isArray(o.routePlan) ? o.routePlan : [];
    return {
      inputMint: asString(o.inputMint) ?? "",
      outputMint: asString(o.outputMint) ?? "",
      inAmount: parseBigint(o.inAmount, "inAmount"),
      outAmount: parseBigint(o.outAmount, "outAmount"),
      otherAmountThreshold: parseBigint(o.otherAmountThreshold ?? o.outAmount, "otherAmountThreshold"),
      slippageBps: asNumber(o.slippageBps) ?? 0,
      priceImpact: asNumber(o.priceImpactPct) ?? 0,
      hops: routePlan.length,
      contextSlot: asNumber(o.contextSlot),
      raw: o,
    };
  } catch (e) {
    throw new JupiterError(`quote: malformed response (${(e as Error).message})`, undefined, e);
  }
}

export class JupiterClient implements Quoter {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly apiKey: string | undefined;

  constructor(opts: { baseUrl?: string; timeoutMs?: number; apiKey?: string } = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.TENFOLD_JUPITER_BASE_URL ?? JUPITER_API).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    const key = opts.apiKey ?? process.env.TENFOLD_JUPITER_API_KEY;
    this.apiKey = key && key.trim() ? key.trim() : undefined;
  }

  /** Headers for every call: the API key when configured (api.jup.ag throttles keyless traffic hard). */
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.apiKey ? { ...extra, "x-api-key": this.apiKey } : extra;
  }

  /** GET /swap/v1/quote for an ExactIn swap. */
  async quote(p: QuoteParams): Promise<JupiterQuote> {
    const q = new URLSearchParams({
      inputMint: p.inputMint,
      outputMint: p.outputMint,
      amount: p.amount.toString(),
      slippageBps: String(p.slippageBps),
      swapMode: "ExactIn",
    });
    if (p.restrictIntermediateTokens) q.set("restrictIntermediateTokens", "true");
    const body = await fetchJson(`${this.baseUrl}/swap/v1/quote?${q.toString()}`, { method: "GET", headers: this.headers() }, this.timeoutMs);
    return parseQuote(body);
  }

  /** POST /swap/v1/swap: turn a quote into an unsigned transaction for `userPublicKey`. */
  async swap(quote: JupiterQuote, userPublicKey: string, fee: SwapFeeOptions): Promise<SwapResponse> {
    const prioritizationFeeLamports = {
      priorityLevelWithMaxLamports: {
        maxLamports: Number(fee.priorityMaxLamports),
        priorityLevel: "high",
      },
    };
    const payload = {
      quoteResponse: quote.raw,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports,
    };
    const body = await fetchJson(
      `${this.baseUrl}/swap/v1/swap`,
      { method: "POST", headers: this.headers({ "content-type": "application/json" }), body: JSON.stringify(payload) },
      this.timeoutMs,
    );
    const o = asRecord(body);
    if (!o) throw new JupiterError("swap: response is not an object");
    const errMsg = asString(o.error);
    if (errMsg) throw new JupiterError(`swap: ${errMsg}`);
    const swapTransaction = asString(o.swapTransaction);
    const lastValidBlockHeight = asNumber(o.lastValidBlockHeight);
    if (!swapTransaction || lastValidBlockHeight === undefined) {
      throw new JupiterError("swap: response lacks swapTransaction or lastValidBlockHeight");
    }
    return {
      swapTransaction,
      lastValidBlockHeight,
      prioritizationFeeLamports: asNumber(o.prioritizationFeeLamports),
      computeUnitLimit: asNumber(o.computeUnitLimit),
    };
  }
}
