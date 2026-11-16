import { createCipheriv, createDecipheriv, type Cipher, type Decipher } from 'node:crypto';
import { isIPv6, connect as netConnect, type Socket } from 'node:net';
import { random, sha256 } from './crypto.js';

export type ProxyOptions =
  | { type: 'socks5'; host: string; port: number; username?: string; password?: string }
  | {
      type: 'mtproxy';
      host: string;
      port: number;
      /** Proxy secret in hex (plain 16-byte or `dd`-prefixed). Fake-TLS (`ee`) secrets are not supported yet. */
      secret: string;
    };

export interface TransportOptions {
  host: string;
  port: number;
  dcId: number;
  testServers?: boolean;
  media?: boolean;
  proxy?: ProxyOptions;
  /** Connect timeout in ms. Default: 10000. */
  timeout?: number;
}

/** Error code sent by the server instead of a packet (e.g. -404 = auth key not found). */
export class TransportError extends Error {
  constructor(readonly code: number) {
    super(`Transport error ${code}${code === -404 ? ' (auth key not found)' : code === -429 ? ' (too many connections)' : ''}`);
  }
}

const FORBIDDEN_STARTS = [0x44414548, 0x54534f50, 0x20544547, 0x4954504f, 0xdddddddd, 0xeeeeeeee, 0x02010316];

/** TCP connection using the obfuscated "intermediate" MTProto transport. */
export class Transport {
  onPacket: (packet: Buffer) => void = () => {};
  onClose: (error?: Error) => void = () => {};
  private socket?: Socket;
  private enc?: Cipher;
  private dec?: Decipher;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private padded = false;
  private closed = false;

  constructor(readonly options: TransportOptions) {}

  get connected(): boolean {
    return !!this.socket && !this.closed;
  }

  async connect(): Promise<void> {
    const { proxy } = this.options;
    const target = proxy?.type === 'mtproxy' ? proxy : { host: this.options.host, port: this.options.port };
    const socket = await this.openSocket(proxy?.type === 'socks5' ? proxy : undefined, target.host, target.port);
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);

    let secret: Buffer | undefined;
    if (proxy?.type === 'mtproxy') {
      let s = Buffer.from(proxy.secret.replace(/^(dd|ee)/i, (m) => m), 'hex');
      if (/^ee/i.test(proxy.secret)) throw new Error('Fake-TLS (ee) MTProxy secrets are not supported yet; use a dd/plain secret or SOCKS5');
      if (/^dd/i.test(proxy.secret)) {
        this.padded = true;
        s = s.subarray(1);
      }
      secret = s.subarray(0, 16);
    }
    socket.write(this.handshake(secret));
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.handleClose());
    socket.on('error', (e) => this.handleClose(e));
  }

  private openSocket(socks: Extract<ProxyOptions, { type: 'socks5' }> | undefined, host: string, port: number): Promise<Socket> {
    const timeout = this.options.timeout ?? 10_000;
    return new Promise<Socket>((resolve, reject) => {
      const s = netConnect({ host: socks?.host ?? host, port: socks?.port ?? port });
      const timer = setTimeout(() => (s.destroy(), reject(new Error(`Connection to ${host}:${port} timed out`))), timeout);
      s.once('error', (e) => (clearTimeout(timer), reject(e)));
      s.once('connect', async () => {
        try {
          if (socks) await socks5Handshake(s, socks, host, port);
          clearTimeout(timer);
          s.removeAllListeners('error');
          resolve(s);
        } catch (e) {
          clearTimeout(timer);
          s.destroy();
          reject(e);
        }
      });
    });
  }

  private handshake(secret?: Buffer): Buffer {
    let init: Buffer;
    do {
      init = random(64);
    } while (init[0] === 0xef || FORBIDDEN_STARTS.includes(init.readUInt32LE(0)) || init.readUInt32LE(4) === 0);
    init.writeUInt32LE(this.padded ? 0xdddddddd : 0xeeeeeeee, 56);
    let dc = this.options.dcId + (this.options.testServers ? 10000 : 0);
    if (this.options.media) dc = -dc;
    init.writeInt16LE(dc, 60);

    const rev = Buffer.from(init.subarray(8, 56)).reverse();
    let encKey: Buffer = init.subarray(8, 40);
    const encIv = init.subarray(40, 56);
    let decKey: Buffer = rev.subarray(0, 32);
    const decIv = rev.subarray(32, 48);
    if (secret) {
      encKey = sha256(encKey, secret);
      decKey = sha256(decKey, secret);
    }
    this.enc = createCipheriv('aes-256-ctr', encKey, encIv);
    this.dec = createDecipheriv('aes-256-ctr', decKey, decIv);
    const encrypted = this.enc.update(init);
    return Buffer.concat([init.subarray(0, 56), encrypted.subarray(56, 64)]);
  }

  send(payload: Buffer): void {
    if (!this.socket || this.closed) throw new Error('Not connected');
    let pad = 0;
    if (this.padded) pad = random(1)[0] % 16;
    const frame = Buffer.allocUnsafe(4 + payload.length + pad);
    frame.writeUInt32LE(payload.length + pad, 0);
    payload.copy(frame, 4);
    if (pad) random(pad).copy(frame, 4 + payload.length);
    this.socket.write(this.enc!.update(frame));
  }

  private onData(data: Buffer): void {
    this.chunks.push(this.dec!.update(data));
    this.buffered += data.length;
    while (this.buffered >= 4) {
      const head = this.chunks[0].length >= 4 ? this.chunks[0] : Buffer.concat(this.chunks);
      const len = head.readUInt32LE(0);
      if (this.buffered < 4 + len) break;
      const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
      let packet = all.subarray(4, 4 + len);
      const rest = all.subarray(4 + len);
      this.chunks = rest.length ? [rest] : [];
      this.buffered = rest.length;
      if (packet.length === 4) {
        this.handleClose(new TransportError(packet.readInt32LE(0)));
        return;
      }
      if (this.padded && packet.length > 8) {
        const excess = packet.readBigUInt64LE(0) === 0n ? (packet.length - 20) - packet.readUInt32LE(16) : (packet.length - 8) % 16;
        if (excess > 0) packet = packet.subarray(0, packet.length - excess);
      }
      try {
        this.onPacket(packet);
      } catch (e) {
        this.handleClose(e as Error);
        return;
      }
    }
  }

  private handleClose(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.socket?.destroy();
    this.onClose(error);
  }

  close(): void {
    this.handleClose();
  }
}

async function socks5Handshake(
  s: Socket,
  p: { username?: string; password?: string },
  host: string,
  port: number,
): Promise<void> {
  const read = (n: number) =>
    new Promise<Buffer>((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const onData = (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        if (buf.length >= n) {
          s.off('data', onData);
          s.off('error', reject);
          if (buf.length > n) s.unshift(buf.subarray(n));
          resolve(buf.subarray(0, n));
        }
      };
      s.on('data', onData);
      s.once('error', reject);
    });
  const auth = p.username !== undefined;
  s.write(Buffer.from(auth ? [5, 2, 0, 2] : [5, 1, 0]));
  const [ver, method] = await read(2);
  if (ver !== 5) throw new Error('SOCKS5: bad server version');
  if (method === 2) {
    const u = Buffer.from(p.username ?? '');
    const pw = Buffer.from(p.password ?? '');
    s.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([pw.length]), pw]));
    const [, status] = await read(2);
    if (status !== 0) throw new Error('SOCKS5: authentication failed');
  } else if (method !== 0) {
    throw new Error('SOCKS5: no acceptable auth method');
  }
  let addr: Buffer;
  if (isIPv6(host)) {
    addr = Buffer.concat([Buffer.from([4]), Buffer.from(host.split(':').flatMap((h) => { const n = parseInt(h || '0', 16); return [n >> 8, n & 0xff]; }))]);
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    addr = Buffer.from([1, ...host.split('.').map(Number)]);
  } else {
    addr = Buffer.concat([Buffer.from([3, host.length]), Buffer.from(host)]);
  }
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port);
  s.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, portBuf]));
  const head = await read(4);
  if (head[1] !== 0) throw new Error(`SOCKS5: connect failed (code ${head[1]})`);
  const atyp = head[3];
  await read(atyp === 1 ? 6 : atyp === 4 ? 18 : (await read(1))[0] + 2);
}
