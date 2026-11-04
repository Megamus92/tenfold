/**
 * Wallet-signature login for the onboarding page.
 *
 * The browser asks for a challenge, has the wallet sign the string "Tenfold onboarding <challenge>" and posts the
 * signature back. The server checks the ed25519 signature against the wallet's public key with node:crypto only
 * (the 32-byte key is wrapped in the SPKI DER prefix) and hands out a short-lived session token. Challenges are
 * single use and expire after 10 minutes; sessions live one hour. Everything is in memory: a restart simply logs
 * everyone out.
 */
import { createPublicKey, randomBytes, verify as cryptoVerify } from "node:crypto";

/** DER prefix of an SPKI ed25519 public key; the 32 raw key bytes follow it. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export const CHALLENGE_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS = 60 * 60_000;
/** Upper bound on live challenges and sessions so an anonymous caller cannot grow the maps without limit. */
const MAX_ENTRIES = 10_000;

export const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The exact string a wallet signs for a challenge. */
export function challengeMessage(challenge: string): string {
  return `Tenfold onboarding ${challenge}`;
}

// ---- base58 (Bitcoin alphabet, as used by Solana) ----

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map<string, number>([...B58].map((c, i) => [c, i] as const));

export function base58Decode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0);
  const bytes: number[] = [0];
  for (const ch of s) {
    const v = B58_INDEX.get(ch);
    if (v === undefined) throw new Error("invalid base58 character");
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leading = 0;
  for (const ch of s) {
    if (ch !== "1") break;
    leading++;
  }
  const out = new Uint8Array(leading + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[leading + i] = bytes[bytes.length - 1 - i];
  return out;
}

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const digits: number[] = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "";
  for (const b of bytes) {
    if (b !== 0) break;
    out += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

// ---- signature verification ----

/**
 * True when `signatureB58` is a valid ed25519 signature of `message` by the base58 `wallet`. Any malformed input
 * (bad base58, wrong lengths) is simply false; nothing here throws.
 */
export function verifyWalletSignature(wallet: string, message: string, signatureB58: string): boolean {
  if (!PUBKEY_RE.test(wallet) || typeof signatureB58 !== "string" || signatureB58.length < 64 || signatureB58.length > 96) return false;
  let rawKey: Uint8Array;
  let sig: Uint8Array;
  try {
    rawKey = base58Decode(wallet);
    sig = base58Decode(signatureB58);
  } catch {
    return false;
  }
  if (rawKey.length !== 32 || sig.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawKey)]), format: "der", type: "spki" });
    return cryptoVerify(null, Buffer.from(message, "utf8"), key, sig);
  } catch {
    return false;
  }
}

// ---- stores ----

export interface Challenge {
  challenge: string;
  message: string;
  expiresAt: number;
}

/** In-memory single-use challenges. */
export class ChallengeStore {
  private readonly map = new Map<string, number>();
  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = CHALLENGE_TTL_MS,
  ) {}

  issue(): Challenge {
    this.purge();
    const challenge = randomBytes(32).toString("hex");
    const expiresAt = this.now() + this.ttlMs;
    this.map.set(challenge, expiresAt);
    return { challenge, message: challengeMessage(challenge), expiresAt };
  }

  /** True when the challenge is known and still valid. It is removed either way so it cannot be replayed. */
  consume(challenge: unknown): boolean {
    if (typeof challenge !== "string" || !/^[0-9a-f]{64}$/.test(challenge)) return false;
    const exp = this.map.get(challenge);
    this.map.delete(challenge);
    return exp !== undefined && exp > this.now();
  }

  get size(): number {
    return this.map.size;
  }

  private purge(): void {
    const t = this.now();
    for (const [k, exp] of this.map) if (exp <= t) this.map.delete(k);
    // Oldest first: Map iteration is insertion order.
    while (this.map.size >= MAX_ENTRIES) this.map.delete(this.map.keys().next().value as string);
  }
}

export interface Session {
  token: string;
  wallet: string;
  expiresAt: number;
  /** The login challenge and the wallet's base58 signature over it, kept so the founder's declaration is recorded as signed. */
  challenge: string;
  signature: string;
}

/** In-memory bearer sessions, one wallet each. */
export class SessionStore {
  private readonly map = new Map<string, Session>();
  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = SESSION_TTL_MS,
  ) {}

  create(wallet: string, challenge: string, signature: string): Session {
    this.purge();
    const s: Session = { token: randomBytes(32).toString("base64url"), wallet, expiresAt: this.now() + this.ttlMs, challenge, signature };
    this.map.set(s.token, s);
    return s;
  }

  get(token: unknown): Session | undefined {
    if (typeof token !== "string" || token.length < 16 || token.length > 128) return undefined;
    const s = this.map.get(token);
    if (!s) return undefined;
    if (s.expiresAt <= this.now()) {
      this.map.delete(token);
      return undefined;
    }
    return s;
  }

  private purge(): void {
    const t = this.now();
    for (const [k, s] of this.map) if (s.expiresAt <= t) this.map.delete(k);
    while (this.map.size >= MAX_ENTRIES) this.map.delete(this.map.keys().next().value as string);
  }
}

/** Session from an `Authorization: Bearer <token>` header, or undefined. */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+([A-Za-z0-9_-]{16,128})$/.exec(header.trim());
  return m ? m[1] : undefined;
}
