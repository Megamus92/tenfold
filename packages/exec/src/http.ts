/**
 * Minimal HTTP helpers shared by the feed and the executor: JSON fetch with a hard timeout and a typed
 * error that keeps the status code so callers can decide what is retryable.
 */

export const DEFAULT_HTTP_TIMEOUT_MS = 5_000;

/** Non-2xx response, with the status and the (truncated) body for diagnostics. */
export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status} from ${url}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.name = "HttpError";
  }
}

/** True for the abort/timeout errors thrown by fetch when the AbortSignal fires. */
export function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "TimeoutError" || err.name === "AbortError" || /timed? ?out/i.test(err.message);
}

/** True when the error is a transient HTTP condition worth retrying (429, 5xx, timeout, connection reset). */
export function isTransientHttpError(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  if (isTimeoutError(err)) return true;
  if (err instanceof Error) return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i.test(err.message);
  return false;
}

/** GET/POST a URL and parse the JSON body; throws HttpError on non-2xx and the fetch error on timeout. */
export async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS): Promise<unknown> {
  // `fetch` is looked up at call time so tests can replace globalThis.fetch.
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HttpError(url, res.status, body);
  }
  return (await res.json()) as unknown;
}

/** Thrown by `withTimeout` when the wrapped promise does not settle in time; classified as transient by `isTransientHttpError`. */
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms} ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Race a promise against a deadline (default 5 s), the per-call pattern used for every chain read so a silent RPC
 * fails the call instead of stalling the caller. The underlying request is not cancelled; its result is dropped.
 */
export function withTimeout<T>(p: Promise<T>, label: string, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, timeoutMs)), timeoutMs);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Narrow an unknown value to a plain object, or undefined. */
export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Read a finite number from an unknown value (number or numeric string), or undefined. */
export function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Read a non-empty string from an unknown value, or undefined. */
export function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Parse an integer amount string (base units) into a bigint; throws on anything that is not a non-negative integer. */
export function parseBigint(v: unknown, field: string): bigint {
  const s = typeof v === "number" ? String(v) : v;
  if (typeof s !== "string" || !/^\d+$/.test(s)) throw new Error(`${field}: expected an integer amount, got ${JSON.stringify(v)}`);
  return BigInt(s);
}
