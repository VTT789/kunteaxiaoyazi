import crypto from 'crypto';

export const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
export const CHROMIUM_FULL_VERSION = '143.0.3650.75';
export const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split('.')[0];
export const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;

const WIN_EPOCH = 11644473600;

const _SHA256_INITIAL: readonly number[] = [
  0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
  0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19,
];

const _SHA256_STATE: readonly number[] = [
  0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A,
  0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2,
];

const _SHA256_SCHEDULE: readonly number[] = [
  0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA,
  0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6,
  0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33,
  0xD258B060, 0x72766564,
];

const _SHA256_ROUND_CONSTANTS: readonly number[] = [
  0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5,
  0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
  0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3,
  0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
  0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC,
  0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
  0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7,
  0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
  0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13,
  0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
  0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3,
  0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5,
  0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
  0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208,
  0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
];

const _SHA256_ADJUSTMENT = 0xC9DC06A7;
const _SHA256_BLOCK_CONSTANTS: readonly number[] = [
  ..._SHA256_ROUND_CONSTANTS.slice(0, 14),
  _SHA256_ADJUSTMENT,
  ..._SHA256_ROUND_CONSTANTS.slice(15),
];

const _CS64_COEFFICIENTS: ReadonlyArray<readonly [number, number]> = [
  [0xE82E91B1, 0xB32700D0],
  [0x44DE24C6, 0x88DFF51D],
  [0x3BEB65BC, 0x29514038],
  [0xC89C5933, 0xB328CBDF],
  [0x8D1EC211, 0xD405B4D5],
  [0x314EF5D5, 0x26E55F3C],
  [0xE92491B1, 0x607801C6],
  [0xF0A5B9D5, 0x82B2C1FB],
  [0x06064CF3, 0xFA51A3DA],
  [0xDA79FA60, 0x207CC464],
  [0xBED20560, 0x3C3C74F3],
  [0x89F9C9F8, 0xD2D14B61],
  [0x35FA38C6, 0xBB04A2C1],
  [0xCB49E3C6, 0xC5626167],
];

const _CS64_FACTOR = 0x82893933;
const _CS64_ADJUSTMENT0 = 0xF2F90B1A;
const _CS64_ADJUSTMENT1 = 0x0B1A0000;

function _rol16(value: number): number {
  return (((value << 16) | (value >>> 16)) >>> 0);
}

function rotr(x: number, n: number): number {
  return (((x >>> n) | (x << (32 - n))) >>> 0);
}

function sigma0(x: number): number {
  return (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
}

function sigma1(x: number): number {
  return (rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10)) >>> 0;
}

function _words_le4_even(data: Buffer): number[] {
  const pad = (4 - (data.length % 4)) % 4;
  const padded = pad > 0 ? Buffer.concat([data, Buffer.alloc(pad, 0)]) : data;
  const words: number[] = [];
  for (let i = 0; i < padded.length; i += 4) {
    words.push(padded.readUInt32LE(i));
  }
  if (words.length % 2 !== 0) {
    words.push(0);
  }
  return words;
}

function sha256Rounds(state: readonly number[], words: number[], firstRound = 0): number[] {
  let [a, b, c, d, e, f, g, h] = state;
  const k = firstRound === 14 ? _SHA256_BLOCK_CONSTANTS : _SHA256_ROUND_CONSTANTS;
  for (let i = firstRound; i < 64; i++) {
    const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
    const ch = ((e & f) ^ ((~e) & g)) >>> 0;
    const t1 = (BigInt(h >>> 0) + BigInt(s1) + BigInt(ch) + BigInt(k[i] >>> 0) + BigInt(words[i] >>> 0)) & 0xffffffffn;
    const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
    const maj = (((a & b) | (c & (a | b)))) >>> 0;
    const t2 = (BigInt(s0) + BigInt(maj)) & 0xffffffffn;

    h = g;
    g = f;
    f = e;
    e = Number((BigInt(d >>> 0) + t1) & 0xffffffffn);
    d = c;
    c = b;
    b = a;
    a = Number((t1 + t2) & 0xffffffffn);
  }
  return [a, b, c, d, e, f, g, h];
}

function expandSchedule(words: number[], firstWord = 16): void {
  for (let index = firstWord; index < 64; index++) {
    const x = words[index - 2];
    const y = words[index - 15];
    const s1 = sigma1(x);
    const s0 = sigma0(y);
    const sum = (BigInt(s1) + BigInt(words[index - 7] >>> 0) + BigInt(s0) + BigInt(words[index - 16] >>> 0)) & 0xffffffffn;
    words.push(Number(sum));
  }
}

let _initCachedState: number[] | null = null;
let _initCachedKey = '';

function sha256Init(data: Buffer): number[] {
  const key = data.toString('hex');
  if (_initCachedState && _initCachedKey === key) {
    return _initCachedState;
  }
  const words: number[] = new Array(14).fill(0);
  words.push((data[0] << 16) | (data[1] << 8) | data[2]);
  words.push(((data[3] << 24) | (data[4] << 16) | (data[5] << 8) | data[6]) >>> 0);

  for (let index = 16; index < 30; index++) {
    let value = BigInt(_SHA256_SCHEDULE[index - 16] >>> 0);
    if (index - 2 >= 14) {
      const s1 = index === 16 ? ((sigma1(words[index - 2]) ^ 0x000B92C0) >>> 0) : sigma1(words[index - 2]);
      value += BigInt(s1);
    }
    if (index - 7 >= 14) {
      value += BigInt(words[index - 7] >>> 0);
    }
    if (index - 15 >= 14) {
      const s0 = index === 29 ? ((sigma0(words[index - 15]) ^ 0x059C0B80) >>> 0) : sigma0(words[index - 15]);
      value += BigInt(s0);
    }
    words.push(Number(value & 0xffffffffn));
  }
  const w30 = (
    BigInt(sigma1(words[28])) +
    BigInt(words[23] >>> 0) +
    BigInt(sigma0(words[15])) +
    BigInt(words[14] >>> 0) +
    BigInt(_SHA256_ADJUSTMENT >>> 0) -
    BigInt(_SHA256_ROUND_CONSTANTS[14] >>> 0)
  ) & 0xffffffffn;
  words.push(Number(w30));

  expandSchedule(words, 31);
  const working = sha256Rounds(_SHA256_STATE, words, 14);
  const res = _SHA256_INITIAL.map((x, i) => Number((BigInt(x >>> 0) + BigInt(working[i] >>> 0)) & 0xffffffffn));
  _initCachedState = res;
  _initCachedKey = key;
  return res;
}

function sha256Digest(data: Buffer): Buffer {
  if (data.length < 7) {
    throw new Error('Token salt must contain at least seven bytes');
  }
  const length = 57 + data.length;
  const padLen = ((55 - length) % 64 + 64) % 64;
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeBigUInt64BE(BigInt(length) * 8n);
  const padded = Buffer.concat([
    data.subarray(7),
    Buffer.from([0x80]),
    Buffer.alloc(padLen, 0),
    lenBuf,
  ]);

  let state = sha256Init(data.subarray(0, 7));
  for (let offset = 0; offset < padded.length; offset += 64) {
    const chunk = padded.subarray(offset, offset + 64);
    const words: number[] = [];
    for (let i = 0; i < 64; i += 4) {
      words.push(chunk.readUInt32BE(i));
    }
    expandSchedule(words);
    const working = sha256Rounds(state, words);
    state = state.map((x, i) => Number((BigInt(x >>> 0) + BigInt(working[i] >>> 0)) & 0xffffffffn));
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) {
    out.writeUInt32BE(state[i] >>> 0, i * 4);
  }
  return out;
}

function cs64Digest(data: Buffer, digest: Buffer): [number, number] {
  const key_a = (digest.readUInt32LE(0) | 1) >>> 0;
  const key_b = (digest.readUInt32LE(4) | 1) >>> 0;

  const factors = [
    Number((BigInt(key_a) * BigInt(_CS64_FACTOR)) & 0xffffffffn),
    Number((BigInt(key_b) * BigInt(_CS64_FACTOR)) & 0xffffffffn),
  ];

  const terms = _CS64_COEFFICIENTS.map(([coeff], idx) =>
    Number((BigInt(coeff) * BigInt(factors[idx % 2])) & 0xffffffffn)
  );

  const offsets = _CS64_COEFFICIENTS.map(([, offset]) => offset);

  const dataPadded = Buffer.concat([Buffer.from([0]), data]);
  const words = _words_le4_even(dataPadded);

  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    let term = (BigInt(word) * BigInt(index % 2 === 0 ? key_a : key_b)) & 0xffffffffn;
    let offset = (BigInt(_rol16(word)) * BigInt(index % 2 === 0 ? 0xEF0569FB : 0xC31713DB)) & 0xffffffffn;

    if (index === 0) {
      term = (term + BigInt(_CS64_ADJUSTMENT0) * BigInt(factors[0])) & 0xffffffffn;
      offset = (offset + BigInt(_CS64_ADJUSTMENT1)) & 0xffffffffn;
    }
    terms.push(Number(term));
    offsets.push(Number(offset));
  }

  let swap_acc = 0n;
  let swap_last = 0n;
  let state = 0n;
  let acc = 0n;

  for (let index = 0; index < terms.length; index += 2) {
    const x = BigInt(terms[index]);
    const y = BigInt(terms[index + 1]);

    let t = BigInt(_rol16(Number((BigInt(offsets[index]) + x) & 0xffffffffn)));
    let q = (t * 0x76F50F34n) & 0xffffffffn;
    swap_acc = (swap_acc + (BigInt(_rol16(Number(q))) * 0xC3EFEA97n + q) & 0xffffffffn) & 0xffffffffn;

    t = BigInt(_rol16(Number((BigInt(offsets[index + 1]) + y) & 0xffffffffn)));
    q = (t * 0x1881CE3Cn) & 0xffffffffn;
    swap_last = (BigInt(_rol16(Number(q))) * 0x35BD1EC9n + q) & 0xffffffffn;
    swap_acc = (swap_acc + swap_last) & 0xffffffffn;

    state = ((state * BigInt(key_a) + x) & 0xffffffffn);
    state = (BigInt(_rol16(Number(state))) * 0xCF98B111n) & 0xffffffffn;
    state = (BigInt(_rol16(Number(state))) * 0x87085B9Fn) & 0xffffffffn;
    state = (BigInt(_rol16(Number(state))) * 0x12CEB96Dn) & 0xffffffffn;
    state = (BigInt(_rol16(Number(state))) * 0x257E1D83n) & 0xffffffffn;
    acc = (acc + state) & 0xffffffffn;

    t = (state * BigInt(key_b) + y) & 0xffffffffn;
    t = (BigInt(_rol16(Number(t))) * 0xA27416F5n) & 0xffffffffn;
    t = (BigInt(_rol16(Number(t))) * 0xD38396FFn) & 0xffffffffn;
    state = (BigInt(_rol16(Number((BigInt(_rol16(Number(t))) * 0x7C932B89n) & 0xffffffffn))) * 0xBFA49F69n) & 0xffffffffn;
    acc = (acc + state) & 0xffffffffn;
  }

  const word0 = Number((swap_last ^ state) & 0xffffffffn);
  const word1 = Number((swap_acc ^ acc) & 0xffffffffn);
  return [word0, word1];
}

export function generateSecMsGecV2(unixTimestamp?: number): string {
  let ticks = (unixTimestamp !== undefined ? unixTimestamp : (Date.now() / 1000));
  ticks += WIN_EPOCH;
  ticks -= ticks % 300;
  const ticksBig = BigInt(Math.floor(ticks)) * 10000000n;
  const strToHash = `${ticksBig.toString()}${TRUSTED_CLIENT_TOKEN}`;
  const data = Buffer.from(strToHash, 'ascii');

  const digest = sha256Digest(data);
  const [cs0, cs1] = cs64Digest(data, digest);

  const cs64Buf = Buffer.alloc(8);
  cs64Buf.writeUInt32LE(cs0 >>> 0, 0);
  cs64Buf.writeUInt32LE(cs1 >>> 0, 4);
  const cs64Hex = cs64Buf.toString('hex').toUpperCase();
  const shaHex = digest.toString('hex').toUpperCase();

  return `${cs64Hex}-${shaHex}`;
}

export function generateMuid(): string {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}
