/** Growable little-endian buffer writer for TL serialization. */
export class Writer {
  buf: Buffer;
  pos = 0;

  constructor(size = 256) {
    this.buf = Buffer.allocUnsafe(size);
  }

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = Buffer.allocUnsafe(size);
    this.buf.copy(next, 0, 0, this.pos);
    this.buf = next;
  }

  int(v: number): void {
    this.ensure(4);
    this.buf.writeInt32LE(v | 0, this.pos);
    this.pos += 4;
  }
  uint(v: number): void {
    this.ensure(4);
    this.buf.writeUInt32LE(v >>> 0, this.pos);
    this.pos += 4;
  }
  long(v: bigint | number | string): void {
    this.ensure(8);
    this.buf.writeBigInt64LE(BigInt.asIntN(64, BigInt(v)), this.pos);
    this.pos += 8;
  }
  double(v: number): void {
    this.ensure(8);
    this.buf.writeDoubleLE(v, this.pos);
    this.pos += 8;
  }
  raw(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }
  /** TL bytes/string: length prefix + data + padding to 4 bytes. */
  bytes(b: Uint8Array): void {
    const len = b.length;
    let header: number;
    if (len <= 253) {
      this.ensure(1 + len + 3);
      this.buf[this.pos++] = len;
      header = 1;
    } else {
      this.ensure(4 + len + 3);
      this.buf[this.pos++] = 254;
      this.buf[this.pos++] = len & 0xff;
      this.buf[this.pos++] = (len >> 8) & 0xff;
      this.buf[this.pos++] = (len >> 16) & 0xff;
      header = 4;
    }
    this.buf.set(b, this.pos);
    this.pos += len;
    const pad = (4 - ((header + len) % 4)) % 4;
    for (let i = 0; i < pad; i++) this.buf[this.pos++] = 0;
  }
  string(s: string | Uint8Array): void {
    this.bytes(typeof s === 'string' ? Buffer.from(s, 'utf8') : s);
  }
  /** Fixed-size int128/int256 (raw bytes). */
  fixed(b: Uint8Array | bigint, size: number): void {
    if (typeof b === 'bigint') {
      const out = Buffer.alloc(size);
      let v = BigInt.asUintN(size * 8, b);
      for (let i = 0; i < size; i++) (out[i] = Number(v & 0xffn)), (v >>= 8n);
      b = out;
    }
    if (b.length !== size) throw new Error(`Expected ${size} bytes, got ${b.length}`);
    this.raw(b);
  }
  result(): Buffer {
    return this.buf.subarray(0, this.pos);
  }
}

/** Little-endian buffer reader for TL deserialization. */
export class Reader {
  pos = 0;
  constructor(readonly buf: Buffer) {}

  int(): number {
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  uint(): number {
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  long(): bigint {
    const v = this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    return v;
  }
  double(): number {
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }
  raw(n: number): Buffer {
    if (this.pos + n > this.buf.length) throw new RangeError('TL: unexpected end of data');
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  bytes(): Buffer {
    let len = this.buf[this.pos++];
    let header = 1;
    if (len === 254) {
      len = this.buf[this.pos] | (this.buf[this.pos + 1] << 8) | (this.buf[this.pos + 2] << 16);
      this.pos += 3;
      header = 4;
    }
    const v = this.raw(len);
    this.pos += (4 - ((header + len) % 4)) % 4;
    return Buffer.from(v); // copy: callers may keep it after the packet buffer is reused
  }
  string(): string {
    return this.bytes().toString('utf8');
  }
  get remaining(): number {
    return this.buf.length - this.pos;
  }
}
