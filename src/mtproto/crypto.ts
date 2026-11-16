import { createCipheriv, createDecipheriv, createHash, createPublicKey, pbkdf2Sync, randomBytes } from 'node:crypto';
import { Writer } from './tl/binary.js';

export const sha1 = (...parts: Uint8Array[]): Buffer => {
  const h = createHash('sha1');
  for (const p of parts) h.update(p);
  return h.digest();
};
export const sha256 = (...parts: Uint8Array[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};
export const random = (n: number): Buffer => randomBytes(n);

// ---------- bigint helpers ----------

export function toBigInt(buf: Uint8Array): bigint {
  return buf.length ? BigInt('0x' + Buffer.from(buf).toString('hex')) : 0n;
}
export function fromBigInt(v: bigint, size?: number): Buffer {
  let hex = v.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const b = Buffer.from(hex, 'hex');
  if (size === undefined || b.length === size) return b;
  if (b.length > size) throw new RangeError('fromBigInt: number too large');
  return Buffer.concat([Buffer.alloc(size - b.length), b]);
}
export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base %= mod;
  if (base < 0n) base += mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}
const gcd = (a: bigint, b: bigint): bigint => {
  while (b) [a, b] = [b, a % b];
  return a < 0n ? -a : a;
};

/** Pollard–Brent factorization of the 64-bit pq from resPQ. Returns [p, q] with p < q. */
export function factorize(pq: bigint): [bigint, bigint] {
  if (pq % 2n === 0n) return [2n, pq / 2n];
  for (let attempt = 0n; attempt < 20n; attempt++) {
    let y = (toBigInt(random(8)) % (pq - 1n)) + 1n;
    const c = (toBigInt(random(8)) % (pq - 1n)) + 1n;
    const m = 128n;
    let g = 1n, r = 1n, q = 1n, x = 0n, ys = 0n;
    while (g === 1n) {
      x = y;
      for (let i = 0n; i < r; i++) y = (y * y + c) % pq;
      let k = 0n;
      while (k < r && g === 1n) {
        ys = y;
        const lim = m < r - k ? m : r - k;
        for (let i = 0n; i < lim; i++) {
          y = (y * y + c) % pq;
          q = (q * (x > y ? x - y : y - x)) % pq;
        }
        g = gcd(q, pq);
        k += m;
      }
      r *= 2n;
    }
    if (g === pq) {
      do {
        ys = (ys * ys + c) % pq;
        g = gcd(x > ys ? x - ys : ys - x, pq);
      } while (g <= 1n);
    }
    if (g !== pq && g > 1n) {
      const other = pq / g;
      return g < other ? [g, other] : [other, g];
    }
  }
  throw new Error('Failed to factorize pq');
}

// ---------- AES-256-IGE ----------

function ige(data: Buffer, key: Buffer, iv: Buffer, encrypt: boolean): Buffer {
  if (data.length % 16) throw new Error('AES-IGE: data length must be a multiple of 16');
  const cipher = encrypt ? createCipheriv('aes-256-ecb', key, null) : createDecipheriv('aes-256-ecb', key, null);
  cipher.setAutoPadding(false);
  const out = Buffer.allocUnsafe(data.length);
  // For encryption: prevX = previous ciphertext (iv[0..16]), prevY = previous plaintext (iv[16..32]).
  let x = iv.subarray(0, 16);
  let y = iv.subarray(16, 32);
  if (!encrypt) [x, y] = [y, x];
  const block = Buffer.allocUnsafe(16);
  for (let off = 0; off < data.length; off += 16) {
    const chunk = data.subarray(off, off + 16);
    for (let i = 0; i < 16; i++) block[i] = chunk[i] ^ x[i];
    const r = cipher.update(block);
    const dst = out.subarray(off, off + 16);
    for (let i = 0; i < 16; i++) dst[i] = r[i] ^ y[i];
    x = dst;
    y = chunk;
  }
  return out;
}
export const aesIgeEncrypt = (data: Buffer, key: Buffer, iv: Buffer) => ige(data, key, iv, true);
export const aesIgeDecrypt = (data: Buffer, key: Buffer, iv: Buffer) => ige(data, key, iv, false);

// ---------- MTProto 2.0 message keys ----------

/** x = 0 for client→server, 8 for server→client. */
export function messageKeys(authKey: Buffer, msgKey: Buffer, x: 0 | 8): { key: Buffer; iv: Buffer } {
  const a = sha256(msgKey, authKey.subarray(x, x + 36));
  const b = sha256(authKey.subarray(40 + x, 40 + x + 36), msgKey);
  return {
    key: Buffer.concat([a.subarray(0, 8), b.subarray(8, 24), a.subarray(24, 32)]),
    iv: Buffer.concat([b.subarray(0, 8), a.subarray(8, 24), b.subarray(24, 32)]),
  };
}

// ---------- RSA ----------

export interface RsaKey {
  n: bigint;
  e: bigint;
  fingerprint: bigint;
}

export function parseRsaKey(pem: string): RsaKey {
  const jwk = createPublicKey({ key: pem, format: 'pem', type: 'pkcs1' }).export({ format: 'jwk' });
  const nBuf = Buffer.from(jwk.n!, 'base64url');
  const eBuf = Buffer.from(jwk.e!, 'base64url');
  const w = new Writer();
  w.bytes(nBuf);
  w.bytes(eBuf);
  const fingerprint = sha1(w.result()).readBigInt64LE(12);
  return { n: toBigInt(nBuf), e: toBigInt(eBuf), fingerprint };
}

/** RSA_PAD encryption used in req_DH_params (MTProto 2.0). */
export function rsaPad(data: Buffer, key: RsaKey): Buffer {
  if (data.length > 144) throw new Error('rsaPad: data too long');
  const padded = Buffer.concat([data, random(192 - data.length)]);
  const reversed = Buffer.from(padded).reverse();
  for (;;) {
    const tempKey = random(32);
    const withHash = Buffer.concat([reversed, sha256(tempKey, padded)]);
    const aes = aesIgeEncrypt(withHash, tempKey, Buffer.alloc(32));
    const h = sha256(aes);
    const xored = Buffer.allocUnsafe(32);
    for (let i = 0; i < 32; i++) xored[i] = tempKey[i] ^ h[i];
    const keyAes = toBigInt(Buffer.concat([xored, aes]));
    if (keyAes >= key.n) continue;
    return fromBigInt(modPow(keyAes, key.e, key.n), 256);
  }
}

// ---------- DH checks ----------

/** The well-known 2048-bit safe prime used by Telegram; any other prime is rejected. */
export const KNOWN_DH_PRIME = BigInt(
  '0xc71caeb9c6b1c9048e6c522f70f13f73980d40238e3e21c14934d037563d930f48198a0aa7c14058229493d22530f4dbfa336f6e0ac925139543aed44cce7c3720fd51f69458705ac68cd4fe6b6b13abdc9746512969328454f18faf8c595f642477fe96bb2a941d5bcd1d4ac8cc49880708fa9b378e3c4f3a9060bee67cf9a4a4a695811051907e162753b56b0f6b410dba74d8a84b2a14b3144e0ef1284754fd17ed950d5965b4b9dd46582db1178d169c6bc465b0d6ff9ca3928fef5b9ae4e418fc15e83ebea0f87fa9ff5eed70050ded2849f47bf959d956850ce929851f0d8115f635b105ee2e4e15d04b2454bf6f4fadf034b10403119cd8e3b92fcc5b',
);

function isProbablePrime(n: bigint, rounds = 20): boolean {
  if (n < 4n) return n === 2n || n === 3n;
  if (n % 2n === 0n) return false;
  let d = n - 1n;
  let s = 0;
  while (d % 2n === 0n) (d /= 2n), s++;
  outer: for (let i = 0; i < rounds; i++) {
    const a = (toBigInt(random(32)) % (n - 3n)) + 2n;
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    for (let j = 1; j < s; j++) {
      x = (x * x) % n;
      if (x === n - 1n) continue outer;
    }
    return false;
  }
  return true;
}

const verifiedPrimes = new Set<bigint>([KNOWN_DH_PRIME]);

/** Validates the DH prime and generator as required by the MTProto spec. */
export function checkDhParams(prime: bigint, g: number): void {
  if (g < 2 || g > 7) throw new Error(`Bad DH generator ${g}`);
  if (prime >> 2047n !== 1n || prime >> 2048n !== 0n) throw new Error('DH prime must be 2048-bit');
  const ok =
    g === 2 ? prime % 8n === 7n
    : g === 3 ? prime % 3n === 2n
    : g === 4 ? true
    : g === 5 ? [1n, 4n].includes(prime % 5n)
    : g === 6 ? [19n, 23n].includes(prime % 24n)
    : [3n, 5n, 6n].includes(prime % 7n);
  if (!ok) throw new Error(`DH generator ${g} is not a quadratic residue generator for this prime`);
  if (verifiedPrimes.has(prime)) return;
  if (!isProbablePrime(prime) || !isProbablePrime((prime - 1n) / 2n)) throw new Error('DH prime is not a safe prime');
  verifiedPrimes.add(prime);
}

/** Checks 1 < x < p-1 and 2^{2048-64} <= x <= p - 2^{2048-64}. */
export function checkDhValue(x: bigint, p: bigint): void {
  const min = 1n << (2048n - 64n);
  if (x <= 1n || x >= p - 1n || x < min || x > p - min) throw new Error('DH value out of safe range');
}

// ---------- SRP (2FA password) ----------

export interface SrpAlgo {
  salt1: Uint8Array;
  salt2: Uint8Array;
  g: number;
  p: Uint8Array;
}

/** Computes inputCheckPasswordSRP fields for account.password. */
export function computeSrp(algo: SrpAlgo, srpB: Uint8Array, password: string): { A: Buffer; M1: Buffer } {
  const p = toBigInt(algo.p);
  const g = BigInt(algo.g);
  checkDhParams(p, algo.g);
  const B = toBigInt(srpB);
  if (B <= 0n || B >= p) throw new Error('Bad srp_B');
  const pBuf = fromBigInt(p, 256);
  const gBuf = fromBigInt(g, 256);
  const bBuf = fromBigInt(B, 256);

  const SH = (data: Uint8Array, salt: Uint8Array) => sha256(salt, data, salt);
  const ph1 = SH(SH(Buffer.from(password, 'utf8'), algo.salt1), algo.salt2);
  const ph2 = SH(pbkdf2Sync(ph1, algo.salt1, 100000, 64, 'sha512'), algo.salt2);
  const x = toBigInt(ph2);
  const v = modPow(g, x, p);
  const k = toBigInt(sha256(pBuf, gBuf));
  const kv = (k * v) % p;

  for (;;) {
    const a = toBigInt(random(256));
    const A = modPow(g, a, p);
    if (A <= 0n || A >= p) continue;
    const aBuf = fromBigInt(A, 256);
    const u = toBigInt(sha256(aBuf, bBuf));
    if (u === 0n) continue;
    let t = (B - kv) % p;
    if (t < 0n) t += p;
    const sA = modPow(t, a + u * x, p);
    const kA = sha256(fromBigInt(sA, 256));
    const hp = sha256(pBuf);
    const hg = sha256(gBuf);
    for (let i = 0; i < 32; i++) hp[i] ^= hg[i];
    const M1 = sha256(hp, sha256(algo.salt1), sha256(algo.salt2), aBuf, bBuf, kA);
    return { A: aBuf, M1 };
  }
}
