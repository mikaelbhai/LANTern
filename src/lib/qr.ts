/**
 * Minimal QR encoder — byte mode, error-correction level M, versions 1–10.
 *
 * LANTern must generate pairing codes with no internet and no third-party
 * script, so the encoder ships in-app. Versions past 10 are unnecessary: an
 * invite payload is a short `lantern://` URL well under the 216-byte capacity
 * of version 10.
 */

const EC_LEVEL_M = 0;

/** [totalCodewords, ecPerBlock, [ [blockCount, dataPerBlock], ... ] ] */
const VERSIONS: Array<[number, number, Array<[number, number]>]> = [
  [26, 10, [[1, 16]]],
  [44, 16, [[1, 28]]],
  [70, 26, [[1, 44]]],
  [100, 18, [[2, 32]]],
  [134, 24, [[2, 43]]],
  [172, 16, [[4, 27]]],
  [196, 18, [[4, 31]]],
  [242, 22, [[2, 38], [2, 39]]],
  [292, 22, [[3, 36], [2, 37]]],
  [346, 26, [[4, 43], [1, 44]]],
];

const ALIGN: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30],
  [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

/* ---------------------------------------------------------------- GF(256) */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = rsGenerator(ecLen);
  const res = new Uint8Array(data.length + ecLen);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = res[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], factor);
  }
  return res.slice(data.length);
}

/* --------------------------------------------------------------- Bit sink */

class Bits {
  bytes: number[] = [];
  private len = 0;

  push(value: number, width: number) {
    for (let i = width - 1; i >= 0; i--) {
      const bit = (value >>> i) & 1;
      const byteIndex = this.len >>> 3;
      if (this.bytes.length <= byteIndex) this.bytes.push(0);
      if (bit) this.bytes[byteIndex] |= 0x80 >>> (this.len & 7);
      this.len++;
    }
  }

  get bitLength() {
    return this.len;
  }
}

/* ------------------------------------------------------------ Format bits */

function formatBits(mask: number): number {
  const data = (EC_LEVEL_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) {
    rem = (rem << 1) ^ (((rem >>> 11) & 1) * 0x1f25);
  }
  return (version << 12) | rem;
}

/* ------------------------------------------------------------------ Encode */

export interface QrResult {
  size: number;
  modules: boolean[][];
}

export function encodeQr(text: string): QrResult {
  const data = new TextEncoder().encode(text);

  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const [total, ecPer, groups] = VERSIONS[v - 1];
    const dataCodewords = total - ecPer * groups.reduce((n, [c]) => n + c, 0);
    const lenBits = v < 10 ? 8 : 16;
    const needed = Math.ceil((4 + lenBits + data.length * 8) / 8);
    if (needed <= dataCodewords) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error('QR payload too large for version 10');

  const [total, ecPerBlock, groups] = VERSIONS[version - 1];
  const blockCount = groups.reduce((n, [c]) => n + c, 0);
  const dataCodewords = total - ecPerBlock * blockCount;
  const lenBits = version < 10 ? 8 : 16;

  const bits = new Bits();
  bits.push(0b0100, 4);
  bits.push(data.length, lenBits);
  for (const b of data) bits.push(b, 8);

  const capacityBits = dataCodewords * 8;
  bits.push(0, Math.min(4, capacityBits - bits.bitLength));
  while (bits.bitLength % 8 !== 0) bits.push(0, 1);

  const buf = bits.bytes.slice();
  const padBytes = [0xec, 0x11];
  let p = 0;
  while (buf.length < dataCodewords) buf.push(padBytes[p++ % 2]);

  // Split into blocks, generate EC, then interleave.
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const [count, per] of groups) {
    for (let i = 0; i < count; i++) {
      const chunk = new Uint8Array(buf.slice(offset, offset + per));
      offset += per;
      dataBlocks.push(chunk);
      ecBlocks.push(rsEncode(chunk, ecPerBlock));
    }
  }

  const finalBytes: number[] = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of dataBlocks) if (i < b.length) finalBytes.push(b[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const b of ecBlocks) finalBytes.push(b[i]);
  }

  return renderMatrix(version, finalBytes);
}

function renderMatrix(version: number, codewords: number[]): QrResult {
  const size = version * 4 + 17;
  const modules: (boolean | null)[][] = Array.from({ length: size }, () =>
    Array<boolean | null>(size).fill(null),
  );

  const setFn = (x: number, y: number, v: boolean) => {
    modules[y][x] = v;
  };

  // Finder patterns + separators.
  const finder = (ox: number, oy: number) => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = ox + dx;
        const y = oy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const inRing =
          (dx >= 0 && dx <= 6 && (dy === 0 || dy === 6)) ||
          (dy >= 0 && dy <= 6 && (dx === 0 || dx === 6));
        const inCore = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        setFn(x, y, inRing || inCore);
      }
    }
  };
  finder(0, 0);
  finder(size - 7, 0);
  finder(0, size - 7);

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    setFn(i, 6, i % 2 === 0);
    setFn(6, i, i % 2 === 0);
  }

  // Alignment patterns.
  const centers = ALIGN[version - 1];
  for (const cy of centers) {
    for (const cx of centers) {
      const nearFinder =
        (cx <= 8 && cy <= 8) || (cx >= size - 9 && cy <= 8) || (cx <= 8 && cy >= size - 9);
      if (nearFinder) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ring = Math.max(Math.abs(dx), Math.abs(dy));
          setFn(cx + dx, cy + dy, ring !== 1);
        }
      }
    }
  }

  // Dark module.
  setFn(8, size - 8, true);

  // Reserve format areas so data placement skips them.
  const reserveFormat = () => {
    for (let i = 0; i <= 8; i++) {
      if (modules[8][i] === null) modules[8][i] = false;
      if (modules[i][8] === null) modules[i][8] = false;
    }
    for (let i = 0; i < 8; i++) {
      if (modules[size - 1 - i][8] === null) modules[size - 1 - i][8] = false;
      if (modules[8][size - 1 - i] === null) modules[8][size - 1 - i] = false;
    }
  };
  reserveFormat();

  if (version >= 7) {
    const vb = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((vb >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      setFn(a, b, bit);
      setFn(b, a, bit);
    }
  }

  // Zigzag data placement, right to left, skipping the timing column.
  let bitIndex = 0;
  const nextBit = (): boolean => {
    const byte = codewords[bitIndex >>> 3];
    const bit = byte === undefined ? 0 : (byte >>> (7 - (bitIndex & 7))) & 1;
    bitIndex++;
    return bit === 1;
  };

  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (let c = 0; c < 2; c++) {
        const x = right - c;
        if (modules[y][x] !== null) continue;
        modules[y][x] = nextBit();
      }
    }
    upward = !upward;
  }

  const grid = modules as boolean[][];

  // Try every mask, keep the lowest-penalty result.
  let best: boolean[][] | null = null;
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMask(grid, mask, size, version);
    const score = penalty(candidate, size);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
      bestMask = mask;
    }
  }

  const out = best!;
  writeFormat(out, bestMask, size);
  return { size, modules: out };
}

function isFunctionModule(x: number, y: number, size: number, version: number): boolean {
  if (x <= 8 && y <= 8) return true;
  if (x >= size - 8 && y <= 8) return true;
  if (x <= 8 && y >= size - 8) return true;
  if (x === 6 || y === 6) return true;
  if (version >= 7 && ((x < 6 && y >= size - 11) || (y < 6 && x >= size - 11))) return true;
  const centers = ALIGN[version - 1];
  for (const cy of centers) {
    for (const cx of centers) {
      const nearFinder =
        (cx <= 8 && cy <= 8) || (cx >= size - 9 && cy <= 8) || (cx <= 8 && cy >= size - 9);
      if (nearFinder) continue;
      if (Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2) return true;
    }
  }
  return false;
}

const MASK_FN: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(grid: boolean[][], mask: number, size: number, version: number): boolean[][] {
  const fn = MASK_FN[mask];
  const out = grid.map((row) => row.slice());
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isFunctionModule(x, y, size, version)) continue;
      if (fn(x, y)) out[y][x] = !out[y][x];
    }
  }
  return out;
}

function writeFormat(grid: boolean[][], mask: number, size: number) {
  const fb = formatBits(mask);
  for (let i = 0; i < 15; i++) {
    const bit = ((fb >>> i) & 1) === 1;
    // Around the top-left finder.
    if (i < 6) grid[i][8] = bit;
    else if (i < 8) grid[i + 1][8] = bit;
    else if (i === 8) grid[8][7] = bit;
    else grid[8][14 - i] = bit;
    // Mirrored copy.
    if (i < 8) grid[8][size - 1 - i] = bit;
    else grid[size - 15 + i][8] = bit;
  }
  grid[size - 8][8] = true;
}

function penalty(grid: boolean[][], size: number): number {
  let score = 0;

  // Rule 1 — runs of five or more.
  for (let i = 0; i < size; i++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const cur = horizontal ? grid[i][j] : grid[j][i];
        const prev = horizontal ? grid[i][j - 1] : grid[j - 1][i];
        if (cur === prev) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Rule 2 — 2x2 blocks of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = grid[y][x];
      if (v === grid[y][x + 1] && v === grid[y + 1][x] && v === grid[y + 1][x + 1]) score += 3;
    }
  }

  // Rule 3 — finder-like sequences.
  const pat = [true, false, true, true, true, false, true, false, false, false, false];
  const patRev = [false, false, false, false, true, false, true, true, true, false, true];
  const matches = (get: (k: number) => boolean, start: number) => {
    let a = true;
    let b = true;
    for (let k = 0; k < 11; k++) {
      const v = get(start + k);
      if (v !== pat[k]) a = false;
      if (v !== patRev[k]) b = false;
    }
    return a || b;
  };
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      if (matches((k) => grid[i][k], j)) score += 40;
      if (matches((k) => grid[k][i], j)) score += 40;
    }
  }

  // Rule 4 — global balance.
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (grid[y][x]) dark++;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;

  return score;
}

/** Renders a QR matrix as a standalone SVG path string. */
export function qrToSvgPath(qr: QrResult): string {
  let d = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) d += `M${x} ${y}h1v1h-1z`;
    }
  }
  return d;
}
