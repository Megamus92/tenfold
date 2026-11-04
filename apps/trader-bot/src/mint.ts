/** Find Solana mint addresses in free text: base58 runs that decode to exactly 32 bytes (so tx signatures never match). */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));
/** A base58 run bounded by non-base58 characters (or the string ends), 32..44 chars like a public key. */
const RUN = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;

/** Base58 -> bytes, or undefined on an invalid character. */
export function base58Decode(s: string): Uint8Array | undefined {
  const bytes: number[] = [];
  for (const c of s) {
    let carry: number | undefined = INDEX.get(c);
    if (carry === undefined) return undefined;
    for (let i = 0; i < bytes.length; i++) {
      const x: number = (bytes[i] ?? 0) * 58 + carry;
      bytes[i] = x & 0xff;
      carry = x >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  return new Uint8Array([...new Array<number>(zeros).fill(0), ...bytes.reverse()]);
}

/** True when `s` is a base58 string of exactly 32 bytes. */
export function isPubkey(s: string): boolean {
  return base58Decode(s)?.length === 32;
}

/** Every distinct public key in the text, in order of appearance; URLs (solscan, pump.fun, dexscreener) work as-is. */
export function extractMints(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(RUN)) {
    const s = m[0];
    if (isPubkey(s) && !out.includes(s)) out.push(s);
  }
  return out;
}
