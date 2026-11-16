import { createAuthKey } from './auth-key.js';
import { aesIgeDecrypt, aesIgeEncrypt, messageKeys, random, sha1, sha256 } from './crypto.js';
import { RpcError } from './errors.js';
import { LAYER } from './generated/schema.js';
import { Reader, Writer } from './tl/binary.js';
import { ID, maybeGzip, readObject, readValue, resultType, serialize, type TlObject } from './tl/codec.js';
import { Transport, TransportError, type ProxyOptions } from './transport.js';
import { gunzipSync } from 'node:zlib';

export interface InitConnectionParams {
  apiId: number;
  deviceModel: string;
  systemVersion: string;
  appVersion: string;
  systemLangCode: string;
  langPack: string;
  langCode: string;
}

export interface SenderOptions {
  dcId: number;
  host: string;
  port: number;
  testServers?: boolean;
  media?: boolean;
  proxy?: ProxyOptions;
  authKey?: Buffer;
  init: InitConnectionParams;
  /** Called when a new auth key was generated (persist it). */
  onAuthKey?: (key: Buffer) => void;
  /** Server-pushed updates. */
  onUpdates?: (updates: TlObject) => void;
  /** Server created a new session: updates may have been missed. */
  onNewSession?: () => void;
  /** Auth key was rejected by the server (-404). */
  onAuthKeyInvalid?: () => void;
  log?: (level: 'debug' | 'warn', msg: string) => void;
}

interface Pending {
  method: string;
  body: Buffer;
  contentRelated: boolean;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  msgId?: bigint;
  wrapped?: boolean;
}

const UPDATE_IDS = new Set(['updates', 'updatesCombined', 'updateShort', 'updateShortMessage', 'updateShortChatMessage', 'updateShortSentMessage', 'updatesTooLong']);
const MAX_CONTAINER = 64;
const MAX_CONTAINER_BYTES = 512 * 1024;

/** One encrypted MTProto session to one DC. Batches queued requests into containers. */
export class Sender {
  authKey?: Buffer;
  private authKeyId = 0n;
  private salt = 0n;
  private sessionId = random(8);
  private seq = 0;
  private lastMsgId = 0n;
  private timeOffset = 0;
  private transport?: Transport;
  private readonly queue: Pending[] = [];
  private readonly pending = new Map<bigint, Pending>();
  private readonly containers = new Map<bigint, bigint[]>();
  private acks: bigint[] = [];
  private flushScheduled = false;
  private initialized = false;
  private connecting?: Promise<void>;
  private closedByUser = false;
  private reconnectDelay = 0;
  private pingTimer?: NodeJS.Timeout;
  private lastReceive = Date.now();

  constructor(readonly options: SenderOptions) {
    if (options.authKey) this.setAuthKey(options.authKey);
  }

  private setAuthKey(key: Buffer): void {
    this.authKey = key;
    this.authKeyId = sha1(key).readBigInt64LE(12);
  }

  get dcId(): number {
    return this.options.dcId;
  }

  private log(level: 'debug' | 'warn', msg: string) {
    this.options.log?.(level, `[DC${this.options.dcId}${this.options.media ? ' media' : ''}] ${msg}`);
  }

  /** Connects (creating an auth key if needed). Safe to call repeatedly. */
  connect(): Promise<void> {
    this.closedByUser = false;
    return (this.connecting ??= this.doConnect().finally(() => (this.connecting = undefined)));
  }

  private async doConnect(): Promise<void> {
    const { host, port, dcId, testServers, media, proxy } = this.options;
    if (!this.authKey) {
      const t = new Transport({ host, port, dcId, testServers, media, proxy });
      await t.connect();
      try {
        const res = await createAuthKey(t, { dcId, testServers, media });
        this.setAuthKey(res.authKey);
        this.salt = res.serverSalt;
        this.timeOffset = res.timeOffset;
        this.options.onAuthKey?.(res.authKey);
        this.log('debug', 'auth key created');
      } finally {
        t.close();
      }
    }
    const t = new Transport({ host, port, dcId, testServers, media, proxy });
    t.onPacket = (p) => this.onPacket(p);
    t.onClose = (e) => this.onTransportClose(t, e);
    await t.connect();
    this.transport = t;
    this.initialized = false;
    this.reconnectDelay = 0;
    this.lastReceive = Date.now();
    this.startPing();
    // Requests that were in flight on the old connection are sent again.
    for (const p of this.pending.values()) this.queue.unshift(p);
    this.pending.clear();
    this.containers.clear();
    this.scheduleFlush();
    this.log('debug', `connected to ${host}:${port}`);
  }

  private onTransportClose(t: Transport, error?: Error): void {
    if (this.transport !== t) return;
    this.transport = undefined;
    clearInterval(this.pingTimer);
    if (this.closedByUser) return;
    if (error instanceof TransportError && error.code === -404) {
      this.log('warn', 'auth key rejected by server (-404)');
      this.authKey = undefined;
      this.options.onAuthKeyInvalid?.();
    } else if (error) {
      this.log('debug', `connection lost: ${error.message}`);
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.reconnectDelay = Math.min(this.reconnectDelay ? this.reconnectDelay * 2 : 500, 30_000);
    setTimeout(() => {
      if (this.closedByUser || this.transport) return;
      this.connect().catch((e) => {
        this.log('warn', `reconnect failed: ${e.message}`);
        this.scheduleReconnect();
      });
    }, this.reconnectDelay);
  }

  /** Closes the connection; pending requests are rejected. */
  close(): void {
    this.closedByUser = true;
    clearInterval(this.pingTimer);
    this.transport?.close();
    this.transport = undefined;
    const err = new Error('Client disconnected');
    for (const p of [...this.pending.values(), ...this.queue]) p.reject(err);
    this.pending.clear();
    this.queue.length = 0;
  }

  /** Sends an API request and resolves with its result. */
  invoke(obj: TlObject): Promise<any> {
    return new Promise((resolve, reject) => {
      this.queue.push({ method: obj._, body: serialize(obj).result(), contentRelated: true, resolve, reject });
      this.scheduleFlush();
      if (!this.transport && !this.connecting && !this.closedByUser) this.connect().catch(reject);
    });
  }

  private startPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.transport) return;
      if (Date.now() - this.lastReceive > 90_000) {
        this.log('debug', 'no data for 90s, reconnecting');
        this.transport.close();
        return;
      }
      this.invoke({ _: 'ping_delay_disconnect', ping_id: random(8).readBigInt64LE(0), disconnect_delay: 75 }).catch(() => {});
    }, 60_000);
    this.pingTimer.unref();
  }

  // ---------- sending ----------

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  private nextMsgId(): bigint {
    const ms = Date.now() + this.timeOffset * 1000;
    let id = (BigInt(Math.floor(ms / 1000)) << 32n) | (BigInt(Math.floor(((ms % 1000) * 0x100000000) / 1000)) & ~3n);
    if (id <= this.lastMsgId) id = this.lastMsgId + 4n;
    this.lastMsgId = id;
    return id;
  }

  private nextSeq(contentRelated: boolean): number {
    if (!contentRelated) return this.seq * 2;
    return this.seq++ * 2 + 1;
  }

  private bodyFor(p: Pending): Buffer {
    if (this.initialized || p.method.startsWith('ping') || p.method === 'msgs_ack') return p.body;
    p.wrapped = true;
    const i = this.options.init;
    return serialize({
      _: 'invokeWithLayer',
      layer: LAYER,
      query: {
        _: 'initConnection',
        api_id: i.apiId,
        device_model: i.deviceModel,
        system_version: i.systemVersion,
        app_version: i.appVersion,
        system_lang_code: i.systemLangCode,
        lang_pack: i.langPack,
        lang_code: i.langCode,
        query: p.body,
      },
    }).result();
  }

  private flush(): void {
    const t = this.transport;
    if (!t || !this.authKey) return;
    while (this.queue.length || this.acks.length) {
      const batch: Array<{ msgId: bigint; seq: number; body: Buffer; p?: Pending }> = [];
      let size = 0;
      if (this.acks.length) {
        const ackBody = serialize({ _: 'msgs_ack', msg_ids: this.acks.splice(0, 8192) }).result();
        batch.push({ msgId: this.nextMsgId(), seq: this.nextSeq(false), body: ackBody });
        size += ackBody.length;
      }
      while (this.queue.length && batch.length < MAX_CONTAINER) {
        const p = this.queue[0];
        const body = maybeGzip(this.bodyFor(p));
        if (batch.length && size + body.length > MAX_CONTAINER_BYTES) break;
        this.queue.shift();
        const msgId = this.nextMsgId();
        p.msgId = msgId;
        this.pending.set(msgId, p);
        batch.push({ msgId, seq: this.nextSeq(p.contentRelated), body, p });
        size += body.length;
      }
      if (batch.length === 1) {
        const m = batch[0];
        this.sendEncrypted(m.msgId, m.seq, m.body);
        continue;
      }
      const w = new Writer(size + 16 * batch.length + 8);
      w.uint(ID.msgContainer);
      w.int(batch.length);
      for (const m of batch) {
        w.long(m.msgId);
        w.int(m.seq);
        w.int(m.body.length);
        w.raw(m.body);
      }
      const containerId = this.nextMsgId();
      this.containers.set(containerId, batch.filter((m) => m.p).map((m) => m.msgId));
      this.sendEncrypted(containerId, this.nextSeq(false), w.result());
    }
  }

  private sendEncrypted(msgId: bigint, seq: number, body: Buffer): void {
    const authKey = this.authKey!;
    let pad = 16 - ((32 + body.length) % 16);
    if (pad < 12) pad += 16;
    const w = new Writer(32 + body.length + pad);
    w.long(this.salt);
    w.raw(this.sessionId);
    w.long(msgId);
    w.int(seq);
    w.int(body.length);
    w.raw(body);
    w.raw(random(pad));
    const plain = w.result();
    const msgKey = sha256(authKey.subarray(88, 120), plain).subarray(8, 24);
    const { key, iv } = messageKeys(authKey, msgKey, 0);
    const out = new Writer(24 + plain.length);
    out.long(this.authKeyId);
    out.raw(msgKey);
    out.raw(aesIgeEncrypt(plain, key, iv));
    try {
      this.transport!.send(out.result());
    } catch (e) {
      this.log('debug', `send failed: ${(e as Error).message}`);
    }
  }

  // ---------- receiving ----------

  private onPacket(packet: Buffer): void {
    this.lastReceive = Date.now();
    const authKey = this.authKey;
    if (!authKey || packet.length < 24) return;
    if (packet.readBigInt64LE(0) !== this.authKeyId) {
      this.log('warn', 'packet with unknown auth_key_id');
      return;
    }
    const msgKey = packet.subarray(8, 24);
    const { key, iv } = messageKeys(authKey, msgKey, 8);
    const plain = aesIgeDecrypt(packet.subarray(24), key, iv);
    if (!sha256(authKey.subarray(96, 128), plain).subarray(8, 24).equals(msgKey)) {
      this.log('warn', 'msg_key mismatch, dropping packet');
      return;
    }
    if (!plain.subarray(8, 16).equals(this.sessionId)) return; // stale session
    const msgId = plain.readBigInt64LE(16);
    const seq = plain.readInt32LE(24);
    const len = plain.readInt32LE(28);
    const padding = plain.length - 32 - len;
    if (len < 0 || padding < 12 || padding > 1024) {
      this.log('warn', 'bad message length');
      return;
    }
    this.handleMessage(msgId, seq, plain.subarray(32, 32 + len));
    if (this.acks.length) this.scheduleFlush();
  }

  private handleMessage(msgId: bigint, seq: number, body: Buffer): void {
    if (seq & 1) this.acks.push(msgId);
    const id = body.readUInt32LE(0);
    if (id === ID.msgContainer) {
      const r = new Reader(body);
      r.pos = 4;
      const n = r.int();
      for (let i = 0; i < n; i++) {
        const innerId = r.long();
        const innerSeq = r.int();
        const len = r.int();
        this.handleMessage(innerId, innerSeq, r.raw(len));
      }
      return;
    }
    if (id === ID.gzipPacked) {
      const r = new Reader(body);
      r.pos = 4;
      return this.handleMessage(msgId, 0, gunzipSync(r.bytes()));
    }
    if (id === ID.rpcResult) return this.handleRpcResult(body);

    let obj: any;
    try {
      obj = readObject(new Reader(body));
    } catch (e) {
      this.log('warn', `cannot parse message: ${(e as Error).message}`);
      return;
    }
    this.handleService(obj, msgId);
  }

  private handleRpcResult(body: Buffer): void {
    const r = new Reader(body);
    r.pos = 4;
    const reqId = r.long();
    const p = this.pending.get(reqId);
    this.pending.delete(reqId);
    if (!p) return;
    try {
      const inner = r.buf.readUInt32LE(r.pos);
      if (inner === 0x2144ca19) {
        const err = readObject(r);
        p.reject(new RpcError(err.error_code, err.error_message, p.method));
        return;
      }
      let result: any;
      if (inner === ID.gzipPacked) {
        r.pos += 4;
        result = readValue(new Reader(gunzipSync(r.bytes())), resultType(p.method));
      } else {
        result = readValue(r, resultType(p.method));
      }
      if (p.wrapped) this.initialized = true;
      p.resolve(result);
    } catch (e) {
      p.reject(e as Error);
    }
  }

  private resend(msgId: bigint): void {
    const ids = this.containers.get(msgId) ?? [msgId];
    this.containers.delete(msgId);
    for (const id of ids) {
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      this.queue.unshift(p);
    }
    this.scheduleFlush();
  }

  private handleService(obj: any, msgId: bigint): void {
    switch (obj._) {
      case 'pong': {
        const p = this.pending.get(obj.msg_id);
        if (p) {
          this.pending.delete(obj.msg_id);
          p.resolve(obj);
        }
        return;
      }
      case 'bad_server_salt':
        this.salt = obj.new_server_salt;
        this.resend(obj.bad_msg_id);
        return;
      case 'bad_msg_notification': {
        const code = obj.error_code;
        if (code === 16 || code === 17) {
          this.timeOffset = Number(msgId >> 32n) - Math.floor(Date.now() / 1000);
          this.lastMsgId = 0n;
          this.log('debug', `time corrected by ${this.timeOffset}s`);
        } else if (code === 32 || code === 33) {
          this.sessionId = random(8);
          this.seq = 0;
          this.initialized = false;
          this.log('debug', 'seqno mismatch, new session');
        } else {
          const ids = this.containers.get(obj.bad_msg_id) ?? [obj.bad_msg_id];
          for (const id of ids) {
            const p = this.pending.get(id);
            this.pending.delete(id);
            p?.reject(new Error(`bad_msg_notification ${code}`));
          }
          return;
        }
        this.resend(obj.bad_msg_id);
        return;
      }
      case 'new_session_created':
        this.salt = obj.server_salt;
        this.options.onNewSession?.();
        return;
      case 'msg_detailed_info':
      case 'msg_new_detailed_info':
        this.acks.push(obj.answer_msg_id);
        return;
      case 'msgs_ack':
      case 'future_salts':
      case 'msgs_state_info':
      case 'msgs_all_info':
      case 'destroy_session_ok':
      case 'destroy_session_none':
        return;
      default:
        if (UPDATE_IDS.has(obj._)) this.options.onUpdates?.(obj);
        else this.log('debug', `unhandled ${obj._}`);
    }
  }
}
