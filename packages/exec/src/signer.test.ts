import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readdirSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createWallet, loadKeypair, KeystoreError, Signer, verifyMessage, readWalletMeta } from "./signer.js";

let dir: string;
const password = "correct horse battery staple";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tenfold-keys-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("keystore", () => {
  it("creates a 0600 file named after the pubkey and loads it back", () => {
    const pubkey = createWallet(dir, password, "test wallet");
    expect(pubkey).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    const files = readdirSync(dir);
    expect(files).toContain(`${pubkey}.json`);
    const mode = statSync(join(dir, `${pubkey}.json`)).mode & 0o777;
    expect(mode).toBe(0o600);

    const raw = JSON.parse(readFileSync(join(dir, `${pubkey}.json`), "utf8")) as Record<string, unknown>;
    expect(raw.cipher).toBe("aes-256-gcm");
    expect(raw.kdf).toBe("scrypt");
    // secret never stored in clear: the file must not contain the base58 or any 64-byte array
    expect(JSON.stringify(raw)).not.toMatch(/"secretKey"/);

    const kp = loadKeypair(dir, password, pubkey);
    expect(kp.publicKey.toBase58()).toBe(pubkey);
    expect(readWalletMeta(dir, pubkey).label).toBe("test wallet");
  });

  it("rejects a wrong password with a typed error", () => {
    const pubkey = createWallet(dir, password, "w2");
    expect(() => loadKeypair(dir, "nope", pubkey)).toThrowError(KeystoreError);
    try {
      loadKeypair(dir, "nope", pubkey);
    } catch (e) {
      expect((e as KeystoreError).code).toBe("bad_password");
    }
  });

  it("rejects an unknown pubkey and an empty password", () => {
    expect(() => loadKeypair(dir, password, Keypair.generate().publicKey.toBase58())).toThrowError(KeystoreError);
    expect(() => createWallet(dir, "", "x")).toThrowError(KeystoreError);
  });
});

describe("Signer", () => {
  it("signs messages that verify against the pubkey and fail for another key", () => {
    const pubkey = createWallet(dir, password, "signer");
    const signer = new Signer(dir, password);
    expect(signer.has(pubkey)).toBe(true);
    expect(signer.has(Keypair.generate().publicKey.toBase58())).toBe(false);

    const msg = new TextEncoder().encode("tenfold proof " + Date.now());
    const sig = signer.signMessage(pubkey, msg);
    expect(sig).toHaveLength(64);
    expect(verifyMessage(pubkey, msg, sig)).toBe(true);
    expect(verifyMessage(Keypair.generate().publicKey.toBase58(), msg, sig)).toBe(false);
    const tampered = new Uint8Array(msg);
    tampered[0] ^= 1;
    expect(verifyMessage(pubkey, tampered, sig)).toBe(false);
    signer.dispose();
  });

  it("signs a VersionedTransaction so the first signature is the wallet's", () => {
    const pubkey = createWallet(dir, password, "tx");
    const signer = new Signer(dir, password);
    const payer = new PublicKey(pubkey);
    const msg = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    const signed = signer.sign(pubkey, tx);
    expect(signed).toBe(tx);
    expect(signed.signatures[0]!.some((b) => b !== 0)).toBe(true);
    // The signature verifies as an ed25519 signature over the serialized message.
    expect(verifyMessage(pubkey, signed.message.serialize(), signed.signatures[0]!)).toBe(true);
  });

  it("fails on first use with a wrong password", () => {
    const pubkey = createWallet(dir, password, "wrong");
    const bad = new Signer(dir, "wrong password");
    expect(bad.has(pubkey)).toBe(true);
    expect(() => bad.preload(pubkey)).toThrowError(KeystoreError);
  });
});
