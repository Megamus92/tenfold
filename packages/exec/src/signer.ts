/**
 * Local encrypted keystore and signer.
 *
 * SECURITY BOUNDARY: private keys never leave this module. Keypairs are decrypted into memory inside
 * `Signer` and only ever used to produce signatures; no method returns secret bytes. The agent process
 * (apps/agent, the Telegram/LLM side) MUST NEVER import this module: it talks to the engine through the
 * ledger's command table and never holds a keystore password. Only apps/engine and the wallet CLI script
 * are allowed to depend on `@tenfold/exec` signer exports.
 *
 * File format, one JSON file per wallet at `<dir>/<pubkey>.json`, mode 0600:
 *   { version: 1, pubkey, label, kdf: "scrypt", kdfParams: {N, r, p, salt}, cipher: "aes-256-gcm", iv, tag, ciphertext, createdAt }
 * Everything binary is base64. The 64-byte ed25519 secret key is the plaintext.
 */
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  scryptSync,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import bs58 from "bs58";
import type { Pubkey } from "@tenfold/core";

/** DER prefix of a PKCS#8 ed25519 private key; the 32-byte seed follows it. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
/** DER prefix of an SPKI ed25519 public key; the 32-byte key follows it. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const KEYSTORE_VERSION = 1;
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;

interface KeystoreFile {
  version: number;
  pubkey: string;
  label: string;
  kdf: "scrypt";
  kdfParams: { N: number; r: number; p: number; salt: string };
  cipher: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
  createdAt: number;
}

/** Thrown for a missing wallet, a wrong password or a corrupt keystore file. */
export class KeystoreError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "bad_password" | "corrupt" | "mismatch",
  ) {
    super(message);
    this.name = "KeystoreError";
  }
}

function keyPath(dir: string, pubkey: string): string {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pubkey)) throw new KeystoreError(`invalid pubkey ${pubkey}`, "not_found");
  return join(dir, `${pubkey}.json`);
}

function deriveKey(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
  return scryptSync(password, salt, KEY_LEN, { N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024 });
}

function isKeystoreFile(v: unknown): v is KeystoreFile {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const kp = o.kdfParams as Record<string, unknown> | undefined;
  return (
    o.version === KEYSTORE_VERSION &&
    typeof o.pubkey === "string" &&
    o.kdf === "scrypt" &&
    o.cipher === "aes-256-gcm" &&
    typeof kp === "object" &&
    kp !== null &&
    typeof kp.N === "number" &&
    typeof kp.r === "number" &&
    typeof kp.p === "number" &&
    typeof kp.salt === "string" &&
    typeof o.iv === "string" &&
    typeof o.tag === "string" &&
    typeof o.ciphertext === "string"
  );
}

/** Encrypt an existing Keypair into the keystore directory and return its pubkey (used by createWallet and imports). */
export function storeKeypair(dir: string, password: string, keypair: Keypair, label: string): Pubkey {
  if (!password) throw new KeystoreError("keystore password must not be empty", "bad_password");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const params = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };
  const key = deriveKey(password, salt, params);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const pubkey = keypair.publicKey.toBase58();
  cipher.setAAD(Buffer.from(pubkey, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(keypair.secretKey)), cipher.final()]);
  const tag = cipher.getAuthTag();
  key.fill(0);
  const file: KeystoreFile = {
    version: KEYSTORE_VERSION,
    pubkey,
    label,
    kdf: "scrypt",
    kdfParams: { ...params, salt: salt.toString("base64") },
    cipher: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    createdAt: Date.now(),
  };
  const path = keyPath(dir, pubkey);
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return pubkey;
}

/** Generate a fresh Keypair, encrypt it with the password into `<dir>/<pubkey>.json` (0600) and return the pubkey. */
export function createWallet(dir: string, password: string, label: string): Pubkey {
  return storeKeypair(dir, password, Keypair.generate(), label);
}

/** Read the public metadata (pubkey, label, createdAt) of a stored wallet without decrypting it. */
export function readWalletMeta(dir: string, pubkey: Pubkey): { pubkey: Pubkey; label: string; createdAt: number } {
  const path = keyPath(dir, pubkey);
  if (!existsSync(path)) throw new KeystoreError(`no wallet ${pubkey} in ${dir}`, "not_found");
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isKeystoreFile(raw)) throw new KeystoreError(`corrupt keystore file ${path}`, "corrupt");
  return { pubkey: raw.pubkey, label: raw.label, createdAt: raw.createdAt };
}

/** Decrypt a stored wallet and return the Keypair; throws KeystoreError("bad_password") on a wrong password. */
export function loadKeypair(dir: string, password: string, pubkey: Pubkey): Keypair {
  const path = keyPath(dir, pubkey);
  if (!existsSync(path)) throw new KeystoreError(`no wallet ${pubkey} in ${dir}`, "not_found");
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isKeystoreFile(raw)) throw new KeystoreError(`corrupt keystore file ${path}`, "corrupt");
  if (raw.pubkey !== pubkey) throw new KeystoreError(`keystore file ${path} is for ${raw.pubkey}`, "mismatch");
  const salt = Buffer.from(raw.kdfParams.salt, "base64");
  const key = deriveKey(password, salt, raw.kdfParams);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(raw.iv, "base64"));
  decipher.setAAD(Buffer.from(raw.pubkey, "utf8"));
  decipher.setAuthTag(Buffer.from(raw.tag, "base64"));
  let secret: Buffer;
  try {
    secret = Buffer.concat([decipher.update(Buffer.from(raw.ciphertext, "base64")), decipher.final()]);
  } catch {
    throw new KeystoreError("wrong keystore password (or tampered file)", "bad_password");
  } finally {
    key.fill(0);
  }
  if (secret.length !== 64) throw new KeystoreError("decrypted secret has the wrong length", "corrupt");
  const kp = Keypair.fromSecretKey(new Uint8Array(secret));
  secret.fill(0);
  const got = Buffer.from(kp.publicKey.toBase58(), "utf8");
  const want = Buffer.from(pubkey, "utf8");
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    throw new KeystoreError("decrypted key does not match the requested pubkey", "mismatch");
  }
  return kp;
}

/**
 * Holds decrypted keypairs for one keystore directory and signs on request. Keys are loaded lazily on first
 * use and kept in memory for the life of the process; nothing here ever returns secret material.
 */
export class Signer {
  private readonly cache = new Map<Pubkey, Keypair>();

  constructor(
    private readonly dir: string,
    private readonly password: string,
  ) {}

  private keypair(pubkey: Pubkey): Keypair {
    const cached = this.cache.get(pubkey);
    if (cached) return cached;
    const kp = loadKeypair(this.dir, this.password, pubkey);
    this.cache.set(pubkey, kp);
    return kp;
  }

  /** True when a keystore file exists for this pubkey (does not check the password). */
  has(pubkey: Pubkey): boolean {
    if (this.cache.has(pubkey)) return true;
    try {
      return existsSync(keyPath(this.dir, pubkey));
    } catch {
      return false;
    }
  }

  /** Decrypt and cache the key now so a wrong password fails at startup instead of at the first order. */
  preload(pubkey: Pubkey): void {
    this.keypair(pubkey);
  }

  /** Sign a VersionedTransaction in place with the wallet's key and return it. */
  sign(pubkey: Pubkey, tx: VersionedTransaction): VersionedTransaction {
    tx.sign([this.keypair(pubkey)]);
    return tx;
  }

  /** Produce a detached ed25519 signature (64 bytes) over arbitrary bytes, for off-chain proofs. */
  signMessage(pubkey: Pubkey, bytes: Uint8Array): Uint8Array {
    // The 32-byte seed is the first half of the 64-byte Solana secret key; wrap it as PKCS#8 for node:crypto.
    const secret = this.keypair(pubkey).secretKey; // a copy
    const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(secret.subarray(0, 32))]);
    try {
      const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
      return new Uint8Array(cryptoSign(null, bytes, key));
    } finally {
      pkcs8.fill(0);
      secret.fill(0);
    }
  }

  /**
   * Drop the cached keys; the signer is unusable afterwards. web3.js Keypair keeps its bytes private and
   * `secretKey` returns a copy, so the originals are left to the GC rather than zeroed.
   */
  dispose(): void {
    this.cache.clear();
  }
}

/** Verify a detached ed25519 signature produced by `Signer.signMessage` against a base58 pubkey (no secrets needed). */
export function verifyMessage(pubkey: Pubkey, bytes: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== 64) return false;
  let raw: Uint8Array;
  try {
    raw = bs58.decode(pubkey);
  } catch {
    return false;
  }
  if (raw.length !== 32) return false;
  const spki = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]);
  const key = createPublicKey({ key: spki, format: "der", type: "spki" });
  return cryptoVerify(null, bytes, key, signature);
}
