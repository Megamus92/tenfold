/**
 * Jito block-engine client: tip accounts, bundle submission and bundle status polling, over the JSON-RPC endpoint
 * `${jitoUrl}/api/v1/bundles`. A bundle is only considered by Jito when one of its transactions pays a tip to one of
 * the tip accounts, so the executor appends a SystemProgram.transfer to a tip account before signing.
 */
import { asRecord, asString, fetchJson, HttpError, isTransientHttpError, DEFAULT_HTTP_TIMEOUT_MS } from "./http.js";
import { ExecError } from "./errors.js";
import type { Sleep } from "./confirm.js";
import { realSleep } from "./confirm.js";

/** Tip accounts are refreshed every 10 minutes; they change rarely. */
export const TIP_ACCOUNTS_TTL_MS = 10 * 60_000;
/** Bundle status is polled every 2 s for up to 60 s before falling back to signature confirmation. */
export const BUNDLE_POLL_GAP_MS = 2_000;
export const BUNDLE_POLL_TIMEOUT_MS = 60_000;

/** Final status of a bundle as reported by getBundleStatuses. */
export interface BundleStatus {
  bundleId: string;
  /** Jito's confirmation status when known: processed, confirmed, finalized. */
  confirmationStatus?: string;
  slot?: number;
  /** Transaction error when the bundle landed but failed; undefined when it succeeded. */
  err?: unknown;
  /** Signatures of the bundle's transactions, when reported. */
  transactions: string[];
}

export interface JitoClientOptions {
  timeoutMs?: number;
  now?: () => number;
  sleep?: Sleep;
  /** Uniform random in [0, 1), injectable for tests; picks the tip account. */
  random?: () => number;
}

interface TipCache {
  accounts: string[];
  fetchedAt: number;
}

export class JitoClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private tips?: TipCache;

  constructor(jitoUrl: string, opts: JitoClientOptions = {}) {
    this.url = `${jitoUrl.replace(/\/+$/, "")}/api/v1/bundles`;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
    this.random = opts.random ?? Math.random;
  }

  /** The tip accounts, from the cache when fresher than TIP_ACCOUNTS_TTL_MS, else from getTipAccounts. */
  async getTipAccounts(): Promise<string[]> {
    if (this.tips && this.now() - this.tips.fetchedAt < TIP_ACCOUNTS_TTL_MS) return this.tips.accounts;
    const result = await this.call("getTipAccounts", []);
    const accounts = Array.isArray(result) ? result.filter((a): a is string => typeof a === "string" && a.length > 0) : [];
    if (accounts.length === 0) throw new ExecError("jito getTipAccounts returned no accounts", true, result);
    this.tips = { accounts, fetchedAt: this.now() };
    return accounts;
  }

  /** One tip account chosen at random from the (cached) list. */
  async pickTipAccount(): Promise<string> {
    const accounts = await this.getTipAccounts();
    const i = Math.min(accounts.length - 1, Math.floor(this.random() * accounts.length));
    return accounts[i] as string;
  }

  /** Submit signed transactions (base64) as one bundle; returns the bundle id. */
  async sendBundle(txsBase64: string[]): Promise<string> {
    const result = await this.call("sendBundle", [txsBase64, { encoding: "base64" }]);
    const bundleId = asString(result);
    if (!bundleId) throw new ExecError("jito sendBundle returned no bundle id", true, result);
    return bundleId;
  }

  /** getBundleStatuses for the ids; entries Jito does not know yet are absent from the result. */
  async getBundleStatuses(bundleIds: string[]): Promise<BundleStatus[]> {
    const result = asRecord(await this.call("getBundleStatuses", [bundleIds]));
    const value = Array.isArray(result?.value) ? result.value : [];
    const out: BundleStatus[] = [];
    for (const v of value) {
      const o = asRecord(v);
      const bundleId = asString(o?.bundle_id);
      if (!o || !bundleId) continue;
      const txs = Array.isArray(o.transactions) ? o.transactions.filter((t): t is string => typeof t === "string") : [];
      const slot = typeof o.slot === "number" ? o.slot : undefined;
      const st: BundleStatus = { bundleId, transactions: txs };
      const cs = asString(o.confirmation_status);
      if (cs !== undefined) st.confirmationStatus = cs;
      if (slot !== undefined) st.slot = slot;
      if (!isOk(o.err)) st.err = o.err;
      out.push(st);
    }
    return out;
  }

  /**
   * Poll getBundleStatuses every BUNDLE_POLL_GAP_MS until the bundle is confirmed or finalized; returns its slot, or
   * undefined when BUNDLE_POLL_TIMEOUT_MS elapses without a verdict (the caller then confirms on the signature).
   * Throws ExecError (not retryable) when the bundle landed but its transaction failed.
   */
  async waitForBundle(bundleId: string, txSig: string): Promise<number | undefined> {
    const attempts = Math.ceil(BUNDLE_POLL_TIMEOUT_MS / BUNDLE_POLL_GAP_MS);
    for (let i = 0; i < attempts; i++) {
      await this.sleep(BUNDLE_POLL_GAP_MS);
      let statuses: BundleStatus[];
      try {
        statuses = await this.getBundleStatuses([bundleId]);
      } catch {
        continue; // transient: the signature path below still covers us
      }
      const st = statuses.find((s) => s.bundleId === bundleId);
      if (!st) continue;
      const landed = st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized" || st.confirmationStatus === "landed";
      if (!landed) continue;
      if (st.err !== undefined) {
        throw new ExecError(`jito bundle ${bundleId} landed but tx ${txSig} failed: ${JSON.stringify(st.err)}`, false, st.err, txSig);
      }
      return st.slot ?? 0;
    }
    return undefined;
  }

  private async call(method: string, params: unknown[]): Promise<unknown> {
    const payload = { jsonrpc: "2.0", id: 1, method, params };
    let body: unknown;
    try {
      body = await fetchJson(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }, this.timeoutMs);
    } catch (e) {
      const retryable = e instanceof HttpError ? e.status === 429 || e.status >= 500 : isTransientHttpError(e);
      throw new ExecError(`jito ${method} failed: ${(e as Error).message}`, retryable, e);
    }
    const o = asRecord(body);
    const err = asRecord(o?.error);
    if (err) throw new ExecError(`jito ${method} error: ${asString(err.message) ?? JSON.stringify(err)}`, false, err);
    return o?.result;
  }
}

/** True for the "no error" shapes Jito uses: absent, null, or `{ Ok: null }`. */
function isOk(err: unknown): boolean {
  if (err === undefined || err === null) return true;
  const o = asRecord(err);
  return o !== undefined && "Ok" in o && o.Ok === null;
}
