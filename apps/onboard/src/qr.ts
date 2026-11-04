/**
 * Minimal QR code encoder (ISO/IEC 18004), enough to put a deposit address on the confirmation page without a
 * dependency: alphanumeric and byte modes, versions 1 to 40, error correction levels L and M, best-mask selection.
 * Output is a module matrix or an inline SVG.
 */

export type EcLevel = "L" | "M";

/** Error-correction codewords per block, indexed by version (index 0 unused). */
const ECC_PER_BLOCK: Record<EcLevel, number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
};

/** Number of error-correction blocks, indexed by version (index 0 unused). */
const NUM_BLOCKS: Record<EcLevel, number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
};

/** Format-information bits for the error-correction level. */
const ECL_BITS: Record<EcLevel, number> = { L: 1, M: 0 };

const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

/** Growable bit buffer, most significant bit first. */
class BitBuffer {
  readonly bits: number[] = [];
  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

/** Data modules available for codewords once the function patterns are placed. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number, ecl: EcLevel): number {
  return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[ecl][version] * NUM_BLOCKS[ecl][version];
}

/** Centre coordinates of the alignment patterns for a version (empty for version 1). */
function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32 ? 26 : Math.ceil((size - 13) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---- Reed-Solomon over GF(2^8) with the QR polynomial 0x11D ----

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root) ^ (j + 1 < degree ? result[j + 1] : 0);
    }
    root = gfMultiply(root, 2);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMultiply(divisor[i], factor);
  }
  return result;
}

// ---- Segment encoding ----

interface Segment {
  mode: "alphanumeric" | "byte";
  modeBits: number;
  charCount: number;
  data: BitBuffer;
}

function isAlphanumeric(text: string): boolean {
  for (const ch of text) if (!ALPHANUMERIC.includes(ch)) return false;
  return text.length > 0;
}

function makeSegment(text: string): Segment {
  const bb = new BitBuffer();
  if (isAlphanumeric(text)) {
    let i = 0;
    for (; i + 2 <= text.length; i += 2) {
      bb.push(ALPHANUMERIC.indexOf(text.charAt(i)) * 45 + ALPHANUMERIC.indexOf(text.charAt(i + 1)), 11);
    }
    if (i < text.length) bb.push(ALPHANUMERIC.indexOf(text.charAt(i)), 6);
    return { mode: "alphanumeric", modeBits: 0x2, charCount: text.length, data: bb };
  }
  const bytes = new TextEncoder().encode(text);
  for (const b of bytes) bb.push(b, 8);
  return { mode: "byte", modeBits: 0x4, charCount: bytes.length, data: bb };
}

function charCountBits(mode: Segment["mode"], version: number): number {
  const band = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  return mode === "alphanumeric" ? [9, 11, 13][band] : [8, 16, 16][band];
}

function segmentBits(seg: Segment, version: number): number {
  return 4 + charCountBits(seg.mode, version) + seg.data.bits.length;
}

// ---- Matrix construction ----

class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  private setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }

  private finder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  }

  private alignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  /** Finder, separator, timing and alignment patterns, the dark module, and reserved format/version areas. */
  drawFunctionPatterns(ecl: EcLevel): void {
    for (let i = 0; i < this.size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.finder(3, 3);
    this.finder(this.size - 4, 3);
    this.finder(3, this.size - 4);
    const align = alignmentPositions(this.version);
    const last = align.length - 1;
    for (let i = 0; i < align.length; i++) {
      for (let j = 0; j < align.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        this.alignment(align[i], align[j]);
      }
    }
    this.drawFormatBits(ecl, 0); // reserves the area; rewritten with the real mask later
    this.drawVersion();
  }

  drawFormatBits(ecl: EcLevel, mask: number): void {
    const data = (ECL_BITS[ecl] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, bit(i));
    this.setFunction(8, this.size - 8, true);
  }

  private drawVersion(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, bit);
      this.setFunction(b, a, bit);
    }
  }

  /** Zigzag placement of the interleaved codewords into the non-function modules. */
  drawCodewords(data: number[]): void {
    let i = 0;
    const total = data.length * 8;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < total) {
            this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  /** XOR the mask pattern over the data modules (applying twice removes it). */
  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  /** Standard penalty score: long runs, 2x2 blocks, finder-like patterns, dark/light balance. */
  penalty(): number {
    const n = this.size;
    let score = 0;
    const runsOf = (line: boolean[]): void => {
      let run = 1;
      for (let i = 1; i <= n; i++) {
        if (i < n && line[i] === line[i - 1]) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      const s = line.map((d) => (d ? "1" : "0")).join("");
      for (const pat of ["10111010000", "00001011101"]) {
        let idx = s.indexOf(pat);
        while (idx >= 0) {
          score += 40;
          idx = s.indexOf(pat, idx + 1);
        }
      }
    };
    for (let y = 0; y < n; y++) runsOf(this.modules[y]);
    for (let x = 0; x < n; x++) runsOf(this.modules.map((row) => row[x]));
    for (let y = 0; y + 1 < n; y++) {
      for (let x = 0; x + 1 < n; x++) {
        const c = this.modules[y][x];
        if (c === this.modules[y][x + 1] && c === this.modules[y + 1][x] && c === this.modules[y + 1][x + 1]) score += 3;
      }
    }
    let dark = 0;
    for (const row of this.modules) for (const m of row) if (m) dark++;
    const total = n * n;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    score += k * 10;
    return score;
  }
}

export interface QrCode {
  version: number;
  size: number;
  ecLevel: EcLevel;
  mask: number;
  /** modules[y][x], true = dark. */
  modules: boolean[][];
}

/** Encode text as a QR symbol at the smallest version that fits. Throws when it does not fit in version 40. */
export function encodeQr(text: string, ecl: EcLevel = "M"): QrCode {
  const seg = makeSegment(text);
  let version = 1;
  for (; version <= 40; version++) {
    if (segmentBits(seg, version) <= dataCodewords(version, ecl) * 8) break;
  }
  if (version > 40) throw new Error("text too long for a QR code");

  const capacityBits = dataCodewords(version, ecl) * 8;
  const bb = new BitBuffer();
  bb.push(seg.modeBits, 4);
  bb.push(seg.charCount, charCountBits(seg.mode, version));
  for (const b of seg.data.bits) bb.bits.push(b);
  bb.push(0, Math.min(4, capacityBits - bb.bits.length));
  bb.push(0, (8 - (bb.bits.length % 8)) % 8);
  for (let pad = 0xec; bb.bits.length < capacityBits; pad ^= 0xec ^ 0x11) bb.push(pad, 8);

  const data: number[] = [];
  for (let i = 0; i < bb.bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bb.bits[i + j];
    data.push(byte);
  }

  // Split into blocks, append error correction, interleave.
  const numBlocks = NUM_BLOCKS[ecl][version];
  const eccLen = ECC_PER_BLOCK[ecl][version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - eccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(k, k + datLen);
    k += datLen;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const interleaved: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortBlockLen - eccLen || j >= numShortBlocks) interleaved.push(blocks[j][i]);
    }
  }

  const m = new Matrix(version);
  m.drawFunctionPatterns(ecl);
  m.drawCodewords(interleaved);
  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    m.applyMask(mask);
    m.drawFormatBits(ecl, mask);
    const score = m.penalty();
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
    m.applyMask(mask);
  }
  m.applyMask(bestMask);
  m.drawFormatBits(ecl, bestMask);
  return { version, size: m.size, ecLevel: ecl, mask: bestMask, modules: m.modules };
}

export interface QrSvgOptions {
  /** Quiet zone in modules, default 4 (the standard minimum). */
  margin?: number;
  dark?: string;
  light?: string;
  /** Rendered width/height; the SVG scales anyway, this sets the attributes. */
  pixels?: number;
  ecLevel?: EcLevel;
  /** Accessible label; defaults to the encoded text. */
  title?: string;
}

/** The text as a square inline SVG: one path for every dark module, a light background, a quiet zone. */
export function qrSvg(text: string, opts: QrSvgOptions = {}): string {
  const qr = encodeQr(text, opts.ecLevel ?? "M");
  const margin = opts.margin ?? 4;
  const dim = qr.size + margin * 2;
  const px = opts.pixels ?? 240;
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) parts.push(`M${x + margin} ${y + margin}h1v1h-1z`);
    }
  }
  const title = escapeXml(opts.title ?? text);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${px}" height="${px}" role="img" aria-label="${title}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="${escapeXml(opts.light ?? "#ffffff")}"/>` +
    `<path d="${parts.join("")}" fill="${escapeXml(opts.dark ?? "#000000")}"/>` +
    `</svg>`
  );
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
