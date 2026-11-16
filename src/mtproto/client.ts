import { EventEmitter } from 'node:events';
import { createReadStream, openSync, writeSync, closeSync, statSync } from 'node:fs';
import { hostname, release, type as osType } from 'node:os';
import { basename, extname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Readable } from 'node:stream';
import { printBanner, printStatus } from '../banner.js';
import { Formatted } from '../bot/format.js';
import { VERSION } from '../version.js';
import { computeSrp, random } from './crypto.js';
import { RpcError } from './errors.js';
import { DCS, DCS_IPV6, TEST_DCS, TEST_DCS_IPV6 } from './generated/dc.js';
import type { ApiProxy, Methods, tl } from './generated/tl.js';
import { toMessage } from './html.js';
import { Message, peerToId } from './message.js';
import { Sender, type InitConnectionParams } from './sender.js';
import {
  emptySession,
  FileSession,
  markedId,
  StringSession,
  unmarkId,
  type CachedPeer,
  type PeerType,
  type SessionData,
  type SessionStorage,
  type UpdateState,
} from './session.js';
import type { TlObject } from './tl/codec.js';
import type { ProxyOptions } from './transport.js';

export interface ClientOptions {
  /** From https://my.telegram.org */
  apiId: number;
  apiHash: string;
  /** Session: file name (default "wyscra"), `new StringSession(str)`, `new MemorySession()` or your own storage. */
  session?: string | SessionStorage;
  /** Encrypts the session file (AES-256-GCM) when `session` is a file name. Strongly recommended for user accounts. */
  sessionPassword?: string;
  testServers?: boolean;
  ipv6?: boolean;
  proxy?: ProxyOptions;
  /** Automatically sleep on FLOOD_WAIT up to this many seconds. Default: 60. */
  floodSleepThreshold?: number;
  /** Fetch updates missed while offline on start. Default: false. */
  catchUp?: boolean;
  /** Override initConnection values. */
  device?: Partial<Omit<InitConnectionParams, 'apiId'>>;
  /** Log level. Default: 'warn'. */
  logLevel?: 'debug' | 'warn' | 'none';
}

export interface StartOptions {
  /** Log in as a bot with a token from @BotFather. */
  botToken?: string;
  /** Phone number or function returning it. Asked in the console if omitted. */
  phone?: string | (() => string | Promise<string>);
  /** Login code provider. Asked in the console if omitted. */
  code?: () => string | Promise<string>;
  /** 2FA password (or provider). Asked in the console if needed and omitted. */
  password?: string | ((hint?: string) => string | Promise<string>);
  /** Name for registering a new account. */
  firstName?: string;
  lastName?: string;
}

export type PeerLike = number | bigint | string | tl.TypeInputPeer | tl.TypeUser | tl.TypeChat | tl.TypePeer | Message;

export interface SendMessageOptions {
  replyTo?: number;
  /** 'html' parses the text as HTML. html`` templates are detected automatically. */
  parseMode?: 'html';
  silent?: boolean;
  noWebpage?: boolean;
  /** Reply markup (for bots). */
  replyMarkup?: tl.TypeReplyMarkup;
  scheduleDate?: Date | number;
  /** Forum topic id. */
  topMsgId?: number;
}

export interface SendFileOptions extends Omit<SendMessageOptions, 'noWebpage'> {
  caption?: string | Formatted;
  /** Send images as files instead of compressed photos. */
  forceDocument?: boolean;
  fileName?: string;
  mimeType?: string;
  attributes?: tl.TypeDocumentAttribute[];
  /** Mark as spoiler. */
  spoiler?: boolean;
  onProgress?: (uploaded: number, total: number) => void;
}

export interface ClientEvents {
  /** New message (private, group or channel). */
  message: [Message];
  /** Service message (user joined, pinned message...). */
  service: [Message];
  editMessage: [Message];
  deleteMessages: [{ chatId?: number; ids: number[] }];
  /** Every raw update, with users/chats from the same batch. */
  update: [tl.TypeUpdate, { users: tl.TypeUser[]; chats: tl.TypeChat[] }];
  error: [Error];
}

type FileSource = string | Buffer | Uint8Array | Readable;

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.txt': 'text/plain', '.json': 'application/json', '.tgs': 'application/x-tgsticker',
};
const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const PART = 512 * 1024;
const BIG_FILE = 10 * 1024 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomId = () => random(8).readBigInt64LE(0);
const toUnix = (d?: Date | number) => (d === undefined ? undefined : typeof d === 'number' ? d : Math.floor(d.getTime() / 1000));

export interface TelegramClient {
  on<E extends keyof ClientEvents>(event: E, listener: (...args: ClientEvents[E]) => unknown): this;
  once<E extends keyof ClientEvents>(event: E, listener: (...args: ClientEvents[E]) => unknown): this;
  off<E extends keyof ClientEvents>(event: E, listener: (...args: ClientEvents[E]) => unknown): this;
  emit<E extends keyof ClientEvents>(event: E, ...args: ClientEvents[E]): boolean;
}

/**
 * MTProto client for user accounts and bots.
 * ```ts
 * const client = new TelegramClient({ apiId, apiHash });
 * await client.start();                       // asks phone/code/password in the console
 * client.on('message', msg => msg.text === 'ping' && msg.reply('pong'));
 * await client.sendMessage('me', 'Hello from wyscra-tg');
 * ```
 */
export class TelegramClient extends EventEmitter {
  /** Typed access to every API method: `client.api.messages.getDialogs({...})`. */
  readonly api: ApiProxy;
  private readonly storage: SessionStorage;
  private session: SessionData = emptySession();
  private readonly senders = new Map<number, Promise<Sender>>();
  private readonly peers = new Map<number, CachedPeer>();
  private readonly usernames = new Map<string, number>();
  private readonly channels = new Map<bigint, tl.Channel>();
  private dcOptions?: tl.TypeDcOption[];
  private state?: UpdateState;
  private updateChain: Promise<void> = Promise.resolve();
  private gettingDifference?: Promise<void>;
  private saveTimer?: NodeJS.Timeout;
  private loaded = false;
  private authorized = false;

  constructor(readonly options: ClientOptions) {
    super();
    if (!options.apiId || !options.apiHash) throw new Error('apiId and apiHash are required (get them at https://my.telegram.org)');
    const s = options.session ?? 'wyscra';
    this.storage = typeof s === 'string' ? new FileSession(s, { password: options.sessionPassword }) : s;
    const make = (path: string): any =>
      new Proxy(function () {}, {
        get: (_t, key) => (typeof key === 'string' && key !== 'then' ? make(path ? `${path}.${key}` : key) : undefined),
        apply: (_t, _this, args) => this.call(path as keyof Methods, args[0]),
      });
    this.api = make('');
  }

  /** Current account's user id (after start). */
  get selfId(): number | undefined {
    return this.session.userId ? Number(this.session.userId) : undefined;
  }
  get isBot(): boolean {
    return !!this.session.isBot;
  }

  private log(level: 'debug' | 'warn', msg: string): void {
    const want = this.options.logLevel ?? 'warn';
    if (want === 'none' || (want === 'warn' && level === 'debug')) return;
    console[level === 'warn' ? 'warn' : 'log'](`[wyscra-tg] ${msg}`);
  }

  // ======================= connection =======================

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const data = await this.storage.load();
    if (data) {
      this.session = { ...emptySession(), ...data };
      for (const [k, v] of Object.entries(this.session.peers)) {
        const marked = Number(k);
        const peer: CachedPeer = { type: v[0], id: BigInt(v[1]), accessHash: BigInt(v[2]), username: v[3] || undefined, phone: v[4] || undefined };
        this.peers.set(marked, peer);
        if (peer.username) this.usernames.set(peer.username.toLowerCase(), marked);
      }
    } else {
      this.session.testServers = !!this.options.testServers;
    }
  }

  private save(now = false): void {
    if (!now) {
      this.saveTimer ??= setTimeout(() => this.save(true), 1000);
      return;
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.session.state = this.state;
    const peers: SessionData['peers'] = {};
    for (const [k, p] of this.peers) if (!p.min) peers[k] = [p.type, String(p.id), String(p.accessHash), p.username, p.phone];
    this.session.peers = peers;
    Promise.resolve(this.storage.save(this.session)).catch((e) => this.log('warn', `session save failed: ${e.message}`));
  }

  private dcAddress(dcId: number): { host: string; port: number } {
    const test = this.session.testServers;
    const opt = this.dcOptions?.find(
      (o) => o._ === 'dcOption' && o.id === dcId && !o.media_only && !o.cdn && !o.tcpo_only && !!o.ipv6 === !!this.options.ipv6,
    ) as tl.DcOption | undefined;
    if (opt) return { host: opt.ip_address, port: opt.port };
    const list = test ? (this.options.ipv6 ? TEST_DCS_IPV6 : TEST_DCS) : this.options.ipv6 ? DCS_IPV6 : DCS;
    const dc = list.find((d) => d.id === dcId);
    if (!dc) throw new Error(`Unknown DC ${dcId}`);
    return { host: dc.ip, port: dc.port };
  }

  private initParams(): InitConnectionParams {
    return {
      apiId: this.options.apiId,
      deviceModel: this.options.device?.deviceModel ?? `wyscra-tg on ${hostname()}`,
      systemVersion: this.options.device?.systemVersion ?? `${osType()} ${release()}`,
      appVersion: this.options.device?.appVersion ?? VERSION,
      systemLangCode: this.options.device?.systemLangCode ?? 'en',
      langPack: this.options.device?.langPack ?? '',
      langCode: this.options.device?.langCode ?? 'en',
    };
  }

  private getSender(dcId = this.session.dcId): Promise<Sender> {
    let p = this.senders.get(dcId);
    if (p) return p;
    p = (async () => {
      const home = dcId === this.session.dcId;
      const key = this.session.authKeys[dcId];
      const sender = new Sender({
        dcId,
        ...this.dcAddress(dcId),
        testServers: this.session.testServers,
        proxy: this.options.proxy,
        authKey: key ? Buffer.from(key, 'hex') : undefined,
        init: this.initParams(),
        onAuthKey: (k) => {
          this.session.authKeys[dcId] = k.toString('hex');
          this.save(true);
        },
        onAuthKeyInvalid: () => {
          delete this.session.authKeys[dcId];
          this.session.authorizedDcs = this.session.authorizedDcs.filter((d) => d !== dcId);
          this.save(true);
          if (home) this.emit('error', new Error('Session was terminated by the server; log in again'));
        },
        onUpdates: home ? (u) => this.queueUpdates(u) : undefined,
        onNewSession: home ? () => this.state && this.getDifference() : undefined,
        log: (level, msg) => this.log(level, msg),
      });
      await sender.connect();
      if (!home && this.authorized && !this.session.authorizedDcs.includes(dcId)) {
        const exported = await this.call('auth.exportAuthorization', { dc_id: dcId });
        await sender.invoke({ _: 'auth.importAuthorization', id: exported.id, bytes: exported.bytes });
        this.session.authorizedDcs.push(dcId);
        this.save();
      }
      return sender;
    })();
    p.catch(() => this.senders.delete(dcId));
    this.senders.set(dcId, p);
    return p;
  }

  /** Connects to Telegram (without logging in). Called by start(). */
  async connect(): Promise<void> {
    printBanner();
    await this.load();
    await this.getSender();
  }

  /** Disconnects all DC connections and saves the session. */
  async disconnect(): Promise<void> {
    for (const p of this.senders.values()) (await p.catch(() => undefined))?.close();
    this.senders.clear();
    this.save(true);
  }

  /**
   * Session as a portable string (store it in an env var and pass `new StringSession(str)`).
   * With `password` the string is encrypted; load it with `new StringSession(str, { password })`.
   */
  exportSession(password?: string): string {
    return StringSession.encode(this.session, password);
  }

  // ======================= calling methods =======================

  /**
   * Calls any API method.
   * ```ts
   * const config = await client.call('help.getConfig');
   * ```
   */
  call<M extends keyof Methods>(method: M, params?: Methods[M]['params'], options: { dcId?: number } = {}): Promise<Methods[M]['result']> {
    return this.invoke({ _: method, ...(params ?? {}) } as TlObject, options);
  }

  /** Sends a raw TL request object (`{ _: 'messages.getDialogs', ... }`). */
  async invoke(request: TlObject, options: { dcId?: number } = {}): Promise<any> {
    await this.load();
    let dcId = options.dcId ?? this.session.dcId;
    for (let attempt = 0; ; attempt++) {
      try {
        const sender = await this.getSender(dcId);
        const result = await sender.invoke(request);
        this.processResult(result);
        return result;
      } catch (e) {
        if (!(e instanceof RpcError) || attempt >= 5) throw e;
        if ((e.is('FLOOD_WAIT') || e.is('FLOOD_PREMIUM_WAIT') || e.is('SLOWMODE_WAIT')) && (e.value ?? 0) <= (this.options.floodSleepThreshold ?? 60)) {
          this.log('debug', `${e.errorMessage}: sleeping ${e.value}s`);
          await sleep((e.value ?? 1) * 1000 + 100);
          continue;
        }
        if (e.type.endsWith('_MIGRATE') && e.value) {
          if (e.is('FILE_MIGRATE') || e.is('STATS_MIGRATE')) {
            dcId = e.value;
            continue;
          }
          if (this.authorized) throw e;
          this.log('debug', `migrating home DC to ${e.value}`);
          await this.switchHomeDc(e.value);
          dcId = e.value;
          continue;
        }
        if (e.code === 500 || e.is('RPC_CALL_FAIL') || e.is('RPC_MCGET_FAIL') || e.is('TIMEOUT')) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
  }

  private async switchHomeDc(dcId: number): Promise<void> {
    const old = this.senders.get(this.session.dcId);
    this.senders.delete(this.session.dcId);
    (await old?.catch(() => undefined))?.close();
    this.session.dcId = dcId;
    this.save(true);
  }

  private processResult(result: any): void {
    if (!result || typeof result !== 'object') return;
    this.cacheEntities(result);
    if (typeof result._ === 'string' && (result._.startsWith('updates') || result._.startsWith('updateShort'))) this.queueUpdates(result);
  }

  // ======================= auth =======================

  /** True if the session is logged in. */
  async isAuthorized(): Promise<boolean> {
    try {
      await this.call('updates.getState');
      return true;
    } catch (e) {
      if (e instanceof RpcError && (e.code === 401 || e.is('AUTH_KEY_UNREGISTERED'))) return false;
      throw e;
    }
  }

  /**
   * Connects and logs in if needed. Without options it asks for phone/code/2FA password in the console.
   * ```ts
   * await client.start({ botToken: process.env.BOT_TOKEN });
   * await client.start({ phone: '+79990000000', code: () => askSomehow() });
   * ```
   */
  async start(options: StartOptions = {}): Promise<tl.User> {
    await this.connect();
    if (!(await this.isAuthorized())) {
      if (options.botToken) {
        const auth = await this.call('auth.importBotAuthorization', {
          api_id: this.options.apiId,
          api_hash: this.options.apiHash,
          bot_auth_token: options.botToken,
          flags: 0,
        } as any);
        await this.onLoggedIn(auth);
      } else {
        await this.userLogin(options);
      }
    }
    this.authorized = true;
    if (!this.session.authorizedDcs.includes(this.session.dcId)) this.session.authorizedDcs.push(this.session.dcId);
    const me = await this.getMe();
    this.session.userId = String(me.id);
    this.session.isBot = !!me.bot;
    await this.initUpdates();
    this.save(true);
    printStatus(`Logged in as ${me.bot ? 'bot ' : ''}${me.username ? '@' + me.username : me.first_name} (MTProto, DC${this.session.dcId})`);
    return me;
  }

  private async prompt(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  }

  private async userLogin(o: StartOptions): Promise<void> {
    const phone = typeof o.phone === 'function' ? await o.phone() : o.phone ?? (await this.prompt('Phone number (international format): '));
    const sent = await this.call('auth.sendCode', {
      phone_number: phone,
      api_id: this.options.apiId,
      api_hash: this.options.apiHash,
      settings: { _: 'codeSettings' },
    });
    if (sent._ !== 'auth.sentCode') {
      await this.onLoggedIn((sent as any).authorization);
      return;
    }
    const via = sent.type._.replace('auth.sentCodeType', '');
    for (let attempt = 0; ; attempt++) {
      const code = o.code ? await o.code() : await this.prompt(`Code (sent via ${via}): `);
      try {
        const auth = await this.call('auth.signIn', { phone_number: phone, phone_code_hash: sent.phone_code_hash, phone_code: code });
        if (auth._ === 'auth.authorizationSignUpRequired') {
          const firstName = o.firstName ?? (await this.prompt('New account. First name: '));
          const up = await this.call('auth.signUp', { phone_number: phone, phone_code_hash: sent.phone_code_hash, first_name: firstName, last_name: o.lastName ?? '' });
          await this.onLoggedIn(up);
        } else {
          await this.onLoggedIn(auth);
        }
        return;
      } catch (e) {
        if (e instanceof RpcError && e.is('PHONE_CODE_INVALID') && attempt < 4) {
          console.log('Invalid code, try again.');
          continue;
        }
        if (e instanceof RpcError && e.is('SESSION_PASSWORD_NEEDED')) {
          await this.checkPassword(o.password);
          return;
        }
        throw e;
      }
    }
  }

  private async checkPassword(provider: StartOptions['password']): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const pwd = await this.call('account.getPassword');
      const password =
        typeof provider === 'string' ? provider
        : provider ? await provider(pwd.hint)
        : await this.prompt(`2FA password${pwd.hint ? ` (hint: ${pwd.hint})` : ''}: `);
      const algo = pwd.current_algo as tl.PasswordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow;
      if (!algo || algo._ !== 'passwordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow') throw new Error('Unsupported password algorithm');
      const { A, M1 } = computeSrp(algo, pwd.srp_B!, password);
      try {
        const auth = await this.call('auth.checkPassword', { password: { _: 'inputCheckPasswordSRP', srp_id: pwd.srp_id!, A, M1 } });
        await this.onLoggedIn(auth);
        return;
      } catch (e) {
        if (e instanceof RpcError && e.is('PASSWORD_HASH_INVALID') && typeof provider !== 'string' && attempt < 4) {
          console.log('Wrong password, try again.');
          continue;
        }
        throw e;
      }
    }
  }

  private async onLoggedIn(auth: any): Promise<void> {
    if (auth?.user) this.cacheEntities({ users: [auth.user] });
    this.authorized = true;
    this.session.authorizedDcs = [this.session.dcId];
    this.save(true);
  }

  /** Logs out and deletes the session. */
  async logOut(): Promise<void> {
    await this.call('auth.logOut').catch(() => {});
    await this.disconnect();
    await this.storage.delete?.();
    this.session = emptySession();
    this.authorized = false;
  }

  // ======================= peers =======================

  private cacheEntities(obj: { users?: any[]; chats?: any[] }): void {
    let changed = false;
    for (const u of obj.users ?? []) {
      if (u._ !== 'user' || u.access_hash === undefined) continue;
      const marked = markedId('user', u.id);
      const prev = this.peers.get(marked);
      if (u.min && prev && !prev.min) continue;
      this.peers.set(marked, { type: 'user', id: u.id, accessHash: u.access_hash, username: u.username, phone: u.phone, min: u.min });
      if (u.username) this.usernames.set(u.username.toLowerCase(), marked);
      changed ||= !prev || prev.accessHash !== u.access_hash;
    }
    for (const c of obj.chats ?? []) {
      if (c._ === 'chat' || c._ === 'chatForbidden') {
        const marked = markedId('chat', c.id);
        if (!this.peers.has(marked)) (this.peers.set(marked, { type: 'chat', id: c.id, accessHash: 0n }), (changed = true));
      } else if ((c._ === 'channel' || c._ === 'channelForbidden') && c.access_hash !== undefined) {
        const marked = markedId('channel', c.id);
        const prev = this.peers.get(marked);
        if (c.min && prev && !prev.min) continue;
        this.peers.set(marked, { type: 'channel', id: c.id, accessHash: c.access_hash, username: c.username, min: c.min });
        if (c._ === 'channel') this.channels.set(c.id, c);
        if (c.username) this.usernames.set(c.username.toLowerCase(), marked);
        changed ||= !prev || prev.accessHash !== c.access_hash;
      }
    }
    if (changed) this.save();
  }

  /** @internal */
  getCachedChannel(id: bigint): tl.Channel | undefined {
    return this.channels.get(id);
  }

  private inputFromCache(marked: number): tl.TypeInputPeer | undefined {
    if (marked === this.selfId) return { _: 'inputPeerSelf' };
    const p = this.peers.get(marked);
    if (!p) {
      const { type, id } = unmarkId(marked);
      return type === 'chat' ? { _: 'inputPeerChat', chat_id: id } : undefined;
    }
    if (p.type === 'user') return { _: 'inputPeerUser', user_id: p.id, access_hash: p.accessHash };
    if (p.type === 'chat') return { _: 'inputPeerChat', chat_id: p.id };
    return { _: 'inputPeerChannel', channel_id: p.id, access_hash: p.accessHash };
  }

  /**
   * Resolves anything peer-like to an InputPeer:
   * `'me'`, `'@username'`, `'username'`, `'t.me/username'`, `'+79990000000'`, a Bot-API-style id, or tl objects.
   */
  async resolvePeer(peer: PeerLike): Promise<tl.TypeInputPeer> {
    if (peer instanceof Message) return this.resolvePeer(peer.chatId);
    if (typeof peer === 'object') {
      const o = peer as any;
      if (typeof o._ === 'string' && o._.startsWith('inputPeer')) return o;
      if (o._ === 'user') return o.self ? { _: 'inputPeerSelf' } : { _: 'inputPeerUser', user_id: o.id, access_hash: o.access_hash ?? 0n };
      if (o._ === 'chat' || o._ === 'chatForbidden') return { _: 'inputPeerChat', chat_id: o.id };
      if (o._ === 'channel' || o._ === 'channelForbidden') return { _: 'inputPeerChannel', channel_id: o.id, access_hash: o.access_hash ?? 0n };
      const id = peerToId(o);
      if (id !== undefined) return this.resolvePeer(id);
      throw new TypeError(`Cannot resolve peer from ${o._}`);
    }
    if (typeof peer === 'bigint') peer = Number(peer);
    if (typeof peer === 'string') {
      const s = peer.trim();
      if (s === 'me' || s === 'self') return { _: 'inputPeerSelf' };
      if (/^-?\d+$/.test(s)) return this.resolvePeer(Number(s));
      if (/^\+?\d[\d\s()-]{5,}$/.test(s)) {
        const phone = s.replace(/\D/g, '');
        for (const [marked, p] of this.peers) if (p.phone === phone) return this.inputFromCache(marked)!;
        const r = await this.call('contacts.resolvePhone', { phone });
        return this.peerFromResolved(r.peer);
      }
      const username = s.replace(/^(https?:\/\/)?(t\.me\/|telegram\.me\/)?@?/i, '').split(/[/?]/)[0];
      const cached = this.usernames.get(username.toLowerCase());
      if (cached !== undefined) return this.inputFromCache(cached)!;
      const r = await this.call('contacts.resolveUsername', { username });
      return this.peerFromResolved(r.peer);
    }
    const input = this.inputFromCache(peer);
    if (input) return input;
    // Try to fetch: works for chats we're in / users the server lets us see by id (bots, recent contacts).
    const { type, id } = unmarkId(peer);
    if (type === 'user') {
      const users = await this.call('users.getUsers', { id: [{ _: 'inputUser', user_id: id, access_hash: 0n }] }).catch(() => []);
      this.cacheEntities({ users });
    } else if (type === 'channel') {
      const r = await this.call('channels.getChannels', { id: [{ _: 'inputChannel', channel_id: id, access_hash: 0n }] }).catch(() => undefined);
      if (r) this.cacheEntities(r);
    }
    const again = this.inputFromCache(peer);
    if (again) return again;
    throw new Error(`Peer ${peer} is not known yet: resolve it by @username/phone first, or load dialogs (client.getDialogs())`);
  }

  private peerFromResolved(peer: tl.TypePeer): tl.TypeInputPeer {
    const input = this.inputFromCache(peerToId(peer)!);
    if (!input) throw new Error('Resolved peer is missing from the response');
    return input;
  }

  /** Bot-API-style id of any peer. */
  async getPeerId(peer: PeerLike): Promise<number> {
    const p = await this.resolvePeer(peer);
    switch (p._) {
      case 'inputPeerSelf': return this.selfId!;
      case 'inputPeerUser': case 'inputPeerUserFromMessage': return markedId('user', p.user_id);
      case 'inputPeerChat': return markedId('chat', p.chat_id);
      case 'inputPeerChannel': case 'inputPeerChannelFromMessage': return markedId('channel', p.channel_id);
      default: throw new Error('Empty peer');
    }
  }

  private async inputUser(peer: PeerLike): Promise<tl.TypeInputUser> {
    const p = await this.resolvePeer(peer);
    if (p._ === 'inputPeerSelf') return { _: 'inputUserSelf' };
    if (p._ === 'inputPeerUser') return { _: 'inputUser', user_id: p.user_id, access_hash: p.access_hash };
    throw new TypeError('Peer is not a user');
  }

  private async inputChannel(peer: PeerLike): Promise<tl.TypeInputChannel> {
    const p = await this.resolvePeer(peer);
    if (p._ === 'inputPeerChannel') return { _: 'inputChannel', channel_id: p.channel_id, access_hash: p.access_hash };
    throw new TypeError('Peer is not a channel/supergroup');
  }

  /** Full user/chat/channel object. */
  async getEntity(peer: PeerLike): Promise<tl.TypeUser | tl.TypeChat> {
    const p = await this.resolvePeer(peer);
    if (p._ === 'inputPeerSelf' || p._ === 'inputPeerUser') return (await this.call('users.getUsers', { id: [await this.inputUser(p)] }))[0];
    if (p._ === 'inputPeerChat') return (await this.call('messages.getChats', { id: [p.chat_id] })).chats[0];
    if (p._ === 'inputPeerChannel') return (await this.call('channels.getChannels', { id: [await this.inputChannel(p)] })).chats[0];
    throw new Error('Cannot get entity');
  }

  /** The logged-in user. */
  async getMe(): Promise<tl.User> {
    const [me] = await this.call('users.getUsers', { id: [{ _: 'inputUserSelf' }] });
    return me as tl.User;
  }

  // ======================= messages =======================

  private async entitiesFor(text: string | Formatted, parseMode?: 'html') {
    const { message, entities } = toMessage(text, parseMode);
    if (entities) {
      for (const e of entities) {
        if (e._ === 'inputMessageEntityMentionName' && e.user_id._ === 'inputUser' && e.user_id.access_hash === 0n) {
          e.user_id = await this.inputUser(Number(e.user_id.user_id)).catch(() => e.user_id);
        }
      }
    }
    return { message, entities: entities as any as tl.TypeMessageEntity[] | undefined };
  }

  private replyTo(o: SendMessageOptions): tl.TypeInputReplyTo | undefined {
    if (o.replyTo === undefined && o.topMsgId === undefined) return undefined;
    return { _: 'inputReplyToMessage', reply_to_msg_id: o.replyTo ?? o.topMsgId!, top_msg_id: o.topMsgId };
  }

  private sentMessage(result: any, rid: bigint, peer: tl.TypeInputPeer, fallback: Partial<tl.Message>): Message {
    if (result._ === 'updateShortSentMessage') {
      const raw: tl.Message = {
        _: 'message',
        out: true,
        id: result.id,
        date: result.date,
        peer_id: this.peerOf(peer),
        message: '',
        media: result.media,
        entities: result.entities,
        ...fallback,
      } as tl.Message;
      return new Message(this, raw);
    }
    const updates: any[] = result.updates ?? (result.update ? [result.update] : []);
    const idUpd = updates.find((u) => u._ === 'updateMessageID' && u.random_id === rid);
    const msgUpd = updates.find(
      (u) => (u._ === 'updateNewMessage' || u._ === 'updateNewChannelMessage' || u._ === 'updateNewScheduledMessage') && (!idUpd || u.message.id === idUpd.id),
    );
    if (!msgUpd) throw new Error('Sent message not found in the server response');
    return new Message(this, msgUpd.message);
  }

  private peerOf(p: tl.TypeInputPeer): tl.TypePeer {
    switch (p._) {
      case 'inputPeerUser': return { _: 'peerUser', user_id: p.user_id };
      case 'inputPeerChat': return { _: 'peerChat', chat_id: p.chat_id };
      case 'inputPeerChannel': return { _: 'peerChannel', channel_id: p.channel_id };
      default: return { _: 'peerUser', user_id: BigInt(this.selfId ?? 0) };
    }
  }

  /**
   * Sends a text message.
   * ```ts
   * await client.sendMessage('@durov', html`Hi <b>there</b>`);
   * ```
   */
  async sendMessage(peer: PeerLike, text: string | Formatted, options: SendMessageOptions = {}): Promise<Message> {
    const p = await this.resolvePeer(peer);
    const { message, entities } = await this.entitiesFor(text, options.parseMode);
    const rid = randomId();
    const result = await this.call('messages.sendMessage', {
      peer: p,
      message,
      entities,
      random_id: rid,
      reply_to: this.replyTo(options),
      silent: options.silent,
      no_webpage: options.noWebpage,
      reply_markup: options.replyMarkup,
      schedule_date: toUnix(options.scheduleDate),
    });
    return this.sentMessage(result, rid, p, { message, entities });
  }

  async editMessage(peer: PeerLike, id: number, text: string | Formatted, options: Omit<SendMessageOptions, 'replyTo' | 'silent'> = {}): Promise<Message> {
    const p = await this.resolvePeer(peer);
    const { message, entities } = await this.entitiesFor(text, options.parseMode);
    const result: any = await this.call('messages.editMessage', { peer: p, id, message, entities, no_webpage: options.noWebpage, reply_markup: options.replyMarkup });
    const u = (result.updates ?? []).find((x: any) => x._ === 'updateEditMessage' || x._ === 'updateEditChannelMessage');
    return new Message(this, u?.message ?? { _: 'message', id, peer_id: this.peerOf(p), date: Math.floor(Date.now() / 1000), message });
  }

  async deleteMessages(peer: PeerLike, ids: number[], revoke = true): Promise<void> {
    const p = await this.resolvePeer(peer);
    if (p._ === 'inputPeerChannel') await this.call('channels.deleteMessages', { channel: await this.inputChannel(p), id: ids });
    else await this.call('messages.deleteMessages', { id: ids, revoke });
  }

  async forwardMessages(to: PeerLike, from: PeerLike, ids: number[], options: { silent?: boolean; dropAuthor?: boolean } = {}): Promise<Message[]> {
    const randomIds = ids.map(() => randomId());
    const result: any = await this.call('messages.forwardMessages', {
      from_peer: await this.resolvePeer(from),
      to_peer: await this.resolvePeer(to),
      id: ids,
      random_id: randomIds,
      silent: options.silent,
      drop_author: options.dropAuthor,
    });
    return (result.updates ?? [])
      .filter((u: any) => u._ === 'updateNewMessage' || u._ === 'updateNewChannelMessage')
      .map((u: any) => new Message(this, u.message));
  }

  async sendReaction(peer: PeerLike, msgId: number, emoji: string | string[]): Promise<void> {
    const list = Array.isArray(emoji) ? emoji : [emoji];
    await this.call('messages.sendReaction', {
      peer: await this.resolvePeer(peer),
      msg_id: msgId,
      reaction: list.map((e) => ({ _: 'reactionEmoji', emoticon: e })),
    });
  }

  async markAsRead(peer: PeerLike, maxId = 0): Promise<void> {
    const p = await this.resolvePeer(peer);
    if (p._ === 'inputPeerChannel') await this.call('channels.readHistory', { channel: await this.inputChannel(p), max_id: maxId });
    else await this.call('messages.readHistory', { peer: p, max_id: maxId });
  }

  /** Messages by id. */
  async getMessages(peer: PeerLike, ids: number[]): Promise<Array<Message | undefined>> {
    const p = await this.resolvePeer(peer);
    const input = ids.map((id) => ({ _: 'inputMessageID' as const, id }));
    const r: any =
      p._ === 'inputPeerChannel'
        ? await this.call('channels.getMessages', { channel: await this.inputChannel(p), id: input })
        : await this.call('messages.getMessages', { id: input });
    return r.messages.map((m: any) => (m._ === 'messageEmpty' ? undefined : new Message(this, m)));
  }

  /**
   * Iterates chat history from newest to oldest.
   * ```ts
   * for await (const msg of client.iterMessages('@channel', { limit: 100 })) console.log(msg.text);
   * ```
   */
  async *iterMessages(peer: PeerLike, options: { limit?: number; offsetId?: number; search?: string; fromUser?: PeerLike } = {}): AsyncGenerator<Message> {
    const p = await this.resolvePeer(peer);
    const limit = options.limit ?? Infinity;
    let offsetId = options.offsetId ?? 0;
    let count = 0;
    const from = options.fromUser ? await this.resolvePeer(options.fromUser) : undefined;
    while (count < limit) {
      const batch = Math.min(100, limit - count);
      const r: any =
        options.search !== undefined || from
          ? await this.call('messages.search', {
              peer: p, q: options.search ?? '', from_id: from, filter: { _: 'inputMessagesFilterEmpty' },
              min_date: 0, max_date: 0, offset_id: offsetId, add_offset: 0, limit: batch, max_id: 0, min_id: 0, hash: 0n,
            })
          : await this.call('messages.getHistory', { peer: p, offset_id: offsetId, offset_date: 0, add_offset: 0, limit: batch, max_id: 0, min_id: 0, hash: 0n });
      const msgs = (r.messages ?? []).filter((m: any) => m._ !== 'messageEmpty');
      if (!msgs.length) return;
      for (const m of msgs) {
        yield new Message(this, m);
        if (++count >= limit) return;
      }
      offsetId = msgs[msgs.length - 1].id;
      if (msgs.length < batch) return;
    }
  }

  /** Iterates dialogs (chats list). Also fills the peer cache. */
  async *iterDialogs(options: { limit?: number; archived?: boolean } = {}): AsyncGenerator<{ id: number; peer: tl.TypePeer; entity?: tl.TypeUser | tl.TypeChat; dialog: tl.Dialog; topMessage?: Message; title: string }> {
    const limit = options.limit ?? Infinity;
    let offsetDate = 0, offsetId = 0;
    let offsetPeer: tl.TypeInputPeer = { _: 'inputPeerEmpty' };
    let count = 0;
    const seen = new Set<number>();
    while (count < limit) {
      const r: any = await this.call('messages.getDialogs', {
        offset_date: offsetDate, offset_id: offsetId, offset_peer: offsetPeer, limit: 100, hash: 0n, folder_id: options.archived ? 1 : undefined,
      });
      if (r._ === 'messages.dialogsNotModified' || !r.dialogs.length) return;
      const users = new Map<number, any>(r.users.map((u: any) => [markedId('user', u.id), u]));
      const chats = new Map<number, any>(r.chats.map((c: any) => [markedId(c._.startsWith('channel') ? 'channel' : 'chat', c.id), c]));
      const msgs = new Map<string, any>(r.messages.map((m: any) => [`${peerToId(m.peer_id)}:${m.id}`, m]));
      let last: any;
      for (const d of r.dialogs) {
        if (d._ !== 'dialog') continue;
        const id = peerToId(d.peer)!;
        if (seen.has(id)) continue;
        seen.add(id);
        const entity = users.get(id) ?? chats.get(id);
        const m = msgs.get(`${id}:${d.top_message}`);
        if (m) last = m;
        const title = entity?._ === 'user' ? [entity.first_name, entity.last_name].filter(Boolean).join(' ') || entity.username || 'Deleted Account' : entity?.title ?? '';
        yield { id, peer: d.peer, entity, dialog: d, topMessage: m ? new Message(this, m) : undefined, title };
        if (++count >= limit) return;
      }
      if (r._ === 'messages.dialogs' || r.dialogs.length < 100 || !last) return;
      offsetDate = last.date;
      offsetId = last.id;
      offsetPeer = await this.resolvePeer(peerToId(last.peer_id)!);
    }
  }

  /** All dialogs as an array. */
  async getDialogs(limit = 100) {
    const out = [];
    for await (const d of this.iterDialogs({ limit })) out.push(d);
    return out;
  }

  /** Iterates members of a group/channel. */
  async *iterParticipants(peer: PeerLike, options: { limit?: number; search?: string } = {}): AsyncGenerator<tl.TypeUser> {
    const p = await this.resolvePeer(peer);
    if (p._ === 'inputPeerChat') {
      const full: any = await this.call('messages.getFullChat', { chat_id: p.chat_id });
      yield* full.users.slice(0, options.limit ?? Infinity);
      return;
    }
    const channel = await this.inputChannel(p);
    const limit = options.limit ?? Infinity;
    let offset = 0;
    while (offset < limit) {
      const r: any = await this.call('channels.getParticipants', {
        channel,
        filter: options.search ? { _: 'channelParticipantsSearch', q: options.search } : { _: 'channelParticipantsRecent' },
        offset, limit: Math.min(200, limit - offset), hash: 0n,
      });
      if (r._ !== 'channels.channelParticipants' || !r.users.length) return;
      for (const u of r.users) {
        yield u;
        if (++offset >= limit) return;
      }
      if (r.users.length < 200) return;
    }
  }

  // ======================= files =======================

  /** Uploads a file and returns an InputFile for sendMedia etc. */
  async uploadFile(source: FileSource, options: { fileName?: string; workers?: number; onProgress?: (uploaded: number, total: number) => void } = {}): Promise<tl.TypeInputFile> {
    let data: Buffer | undefined;
    let size: number;
    let path: string | undefined;
    if (typeof source === 'string') {
      path = source;
      size = statSync(source).size;
    } else if (source instanceof Uint8Array) {
      data = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
      size = data.length;
    } else {
      const chunks: Buffer[] = [];
      for await (const c of source) chunks.push(Buffer.from(c));
      data = Buffer.concat(chunks);
      size = data.length;
    }
    if (size === 0) throw new Error('Cannot upload an empty file');
    const name = options.fileName ?? (path ? basename(path) : 'file');
    const fileId = randomId();
    const parts = Math.ceil(size / PART);
    const big = size > BIG_FILE;
    const fd = path ? openSync(path, 'r') : undefined;
    let next = 0;
    let uploaded = 0;
    const readPart = async (i: number): Promise<Buffer> => {
      if (data) return data.subarray(i * PART, Math.min(size, (i + 1) * PART));
      const len = Math.min(PART, size - i * PART);
      return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        createReadStream('', { fd, start: i * PART, end: i * PART + len - 1, autoClose: false })
          .on('data', (c) => chunks.push(c as Buffer))
          .on('end', () => resolve(Buffer.concat(chunks)))
          .on('error', reject);
      });
    };
    const worker = async () => {
      while (next < parts) {
        const i = next++;
        const bytes = await readPart(i);
        if (big) await this.call('upload.saveBigFilePart', { file_id: fileId, file_part: i, file_total_parts: parts, bytes });
        else await this.call('upload.saveFilePart', { file_id: fileId, file_part: i, bytes });
        uploaded += bytes.length;
        options.onProgress?.(uploaded, size);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(options.workers ?? 4, parts) }, worker));
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    return big ? { _: 'inputFileBig', id: fileId, parts, name } : { _: 'inputFile', id: fileId, parts, name, md5_checksum: '' };
  }

  /**
   * Sends a photo or file. Images are sent as photos unless `forceDocument`.
   * ```ts
   * await client.sendFile('me', './cat.jpg', { caption: 'Cat' });
   * ```
   */
  async sendFile(peer: PeerLike, file: FileSource, options: SendFileOptions = {}): Promise<Message> {
    const p = await this.resolvePeer(peer);
    const name = options.fileName ?? (typeof file === 'string' ? basename(file) : 'file');
    const ext = extname(name).toLowerCase();
    const uploaded = await this.uploadFile(file, { fileName: name, onProgress: options.onProgress });
    const media: tl.TypeInputMedia =
      PHOTO_EXT.has(ext) && !options.forceDocument
        ? { _: 'inputMediaUploadedPhoto', file: uploaded, spoiler: options.spoiler }
        : {
            _: 'inputMediaUploadedDocument',
            file: uploaded,
            mime_type: options.mimeType ?? MIME[ext] ?? 'application/octet-stream',
            attributes: [{ _: 'documentAttributeFilename', file_name: name }, ...(options.attributes ?? [])],
            force_file: options.forceDocument,
            spoiler: options.spoiler,
          };
    const { message, entities } = options.caption !== undefined ? await this.entitiesFor(options.caption, options.parseMode) : { message: '', entities: undefined };
    const rid = randomId();
    const result = await this.call('messages.sendMedia', {
      peer: p, media, message, entities, random_id: rid, reply_to: this.replyTo(options), silent: options.silent,
      reply_markup: options.replyMarkup, schedule_date: toUnix(options.scheduleDate),
    });
    return this.sentMessage(result, rid, p, { message });
  }

  /** Downloads photo/document media to `dest` (returns the path) or to a Buffer. */
  async downloadMedia(media: tl.TypeMessageMedia | Message, dest: string): Promise<string>;
  async downloadMedia(media: tl.TypeMessageMedia | Message): Promise<Buffer>;
  async downloadMedia(media: tl.TypeMessageMedia | Message, dest?: string): Promise<Buffer | string> {
    const m = media instanceof Message ? media.media : media;
    let location: tl.TypeInputFileLocation;
    let dcId: number;
    let size: number;
    if (m?._ === 'messageMediaPhoto' && m.photo?._ === 'photo') {
      const photo = m.photo;
      const best = photo.sizes
        .filter((s): s is tl.PhotoSize | tl.PhotoSizeProgressive => s._ === 'photoSize' || s._ === 'photoSizeProgressive')
        .sort((a, b) => a.w * a.h - b.w * b.h)
        .pop();
      if (!best) throw new Error('Photo has no downloadable sizes');
      location = { _: 'inputPhotoFileLocation', id: photo.id, access_hash: photo.access_hash, file_reference: photo.file_reference, thumb_size: best.type };
      dcId = photo.dc_id;
      size = best._ === 'photoSize' ? best.size : Math.max(...best.sizes);
    } else if (m?._ === 'messageMediaDocument' && m.document?._ === 'document') {
      const doc = m.document;
      location = { _: 'inputDocumentFileLocation', id: doc.id, access_hash: doc.access_hash, file_reference: doc.file_reference, thumb_size: '' };
      dcId = doc.dc_id;
      size = Number(doc.size);
    } else {
      throw new Error(`Cannot download ${m?._ ?? 'empty media'}`);
    }
    return this.downloadFile(location, { dcId, size, dest });
  }

  /** Low-level download of an InputFileLocation (parallel 1 MB chunks). */
  async downloadFile(location: tl.TypeInputFileLocation, options: { dcId?: number; size?: number; dest?: string; workers?: number }): Promise<Buffer | string> {
    const CHUNK = 1024 * 1024;
    const dcId = options.dcId ?? this.session.dcId;
    const fd = options.dest ? openSync(options.dest, 'w') : undefined;
    const parts: Buffer[] = [];
    let next = 0;
    let done = false;
    const total = options.size ? Math.ceil(options.size / CHUNK) : Infinity;
    const worker = async () => {
      while (!done && next < total) {
        const i = next++;
        const r: any = await this.call('upload.getFile', { location, offset: BigInt(i * CHUNK), limit: CHUNK, precise: false }, { dcId });
        if (r._ !== 'upload.file') throw new Error(`Unsupported download response ${r._}`);
        const bytes: Buffer = r.bytes;
        if (fd !== undefined) writeSync(fd, bytes, 0, bytes.length, i * CHUNK);
        else parts[i] = bytes;
        if (bytes.length < CHUNK) done = true;
      }
    };
    try {
      await Promise.all(Array.from({ length: Number.isFinite(total) ? Math.min(options.workers ?? 4, total) : 1 }, worker));
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    return options.dest ?? Buffer.concat(parts.filter(Boolean));
  }

  // ======================= updates =======================

  private async initUpdates(): Promise<void> {
    const saved = this.session.state;
    if (this.options.catchUp && saved) {
      this.state = { ...saved, channels: { ...saved.channels } };
      await this.getDifference();
    } else {
      const s = await this.call('updates.getState');
      this.state = { pts: s.pts, qts: s.qts, date: s.date, seq: s.seq, channels: {} };
    }
  }

  private queueUpdates(u: any): void {
    this.updateChain = this.updateChain
      .then(() => this.processUpdates(u))
      .catch((e) => {
        this.log('warn', `update handling failed: ${e.message}`);
        this.emit('error', e);
      });
  }

  private async processUpdates(u: any): Promise<void> {
    const empty = { users: [], chats: [] };
    switch (u._) {
      case 'updatesTooLong':
        return this.getDifference();
      case 'updateShort':
        return this.applyUpdate(u.update, empty);
      case 'updateShortMessage':
      case 'updateShortChatMessage': {
        const fromId = u._ === 'updateShortMessage' ? (u.out ? BigInt(this.selfId ?? 0) : u.user_id) : u.from_id;
        const message = {
          _: 'message', out: u.out, mentioned: u.mentioned, media_unread: u.media_unread, silent: u.silent, id: u.id,
          from_id: { _: 'peerUser', user_id: fromId },
          peer_id: u._ === 'updateShortMessage' ? { _: 'peerUser', user_id: u.user_id } : { _: 'peerChat', chat_id: u.chat_id },
          message: u.message, date: u.date, fwd_from: u.fwd_from, via_bot_id: u.via_bot_id, reply_to: u.reply_to, entities: u.entities, ttl_period: u.ttl_period,
        };
        if (this.needsDifference(message)) return this.getDifference();
        return this.applyUpdate({ _: 'updateNewMessage', message, pts: u.pts, pts_count: u.pts_count }, empty);
      }
      case 'updateShortSentMessage':
        return this.applyUpdate({ _: 'updateShortSentMessage_pts', pts: u.pts, pts_count: u.pts_count }, empty, true);
      case 'updates':
      case 'updatesCombined': {
        this.cacheEntities(u);
        const s = this.state;
        if (s && u.seq !== 0) {
          const start = u._ === 'updatesCombined' ? u.seq_start : u.seq;
          if (start > s.seq + 1) return this.getDifference();
        }
        for (const upd of u.updates) await this.applyUpdate(upd, { users: u.users, chats: u.chats });
        if (s && u.seq !== 0) {
          s.seq = Math.max(s.seq, u.seq);
          s.date = Math.max(s.date, u.date);
        }
        this.save();
        return;
      }
    }
  }

  /** Short messages from unknown users need full data from getDifference. */
  private needsDifference(message: any): boolean {
    const from = peerToId(message.from_id);
    return from !== undefined && from !== this.selfId && !this.peers.has(from);
  }

  private channelIdOf(upd: any): bigint | undefined {
    if (upd.channel_id !== undefined) return upd.channel_id;
    const peer = upd.message?.peer_id;
    if ((upd._ === 'updateNewChannelMessage' || upd._ === 'updateEditChannelMessage') && peer?._ === 'peerChannel') return peer.channel_id;
    return undefined;
  }

  private async applyUpdate(upd: any, entities: { users: any[]; chats: any[] }, silent = false): Promise<void> {
    const s = this.state;
    if (upd._ === 'updateChannelTooLong') {
      await this.getChannelDifference(upd.channel_id);
      return;
    }
    if (s && upd.pts !== undefined && upd.pts_count !== undefined) {
      const channelId = this.channelIdOf(upd);
      if (channelId !== undefined) {
        const key = String(channelId);
        const local = s.channels[key];
        if (local !== undefined) {
          if (local + upd.pts_count > upd.pts) return; // duplicate
          if (local + upd.pts_count < upd.pts) return this.getChannelDifference(channelId);
        }
        s.channels[key] = upd.pts;
      } else {
        if (s.pts + upd.pts_count > upd.pts) return;
        if (s.pts + upd.pts_count < upd.pts) return this.getDifference();
        s.pts = upd.pts;
      }
    } else if (s && upd.qts !== undefined && upd._ !== 'updateNewEncryptedMessage') {
      if (s.qts + 1 > upd.qts) return;
      if (s.qts + 1 < upd.qts) return this.getDifference();
      s.qts = upd.qts;
    }
    if (!silent) this.dispatch(upd, entities);
  }

  private dispatch(upd: any, entities: { users: any[]; chats: any[] }): void {
    this.emit('update', upd, entities);
    switch (upd._) {
      case 'updateNewMessage':
      case 'updateNewChannelMessage':
        if (upd.message._ === 'message') this.emit('message', new Message(this, upd.message));
        else if (upd.message._ === 'messageService') this.emit('service', new Message(this, upd.message));
        break;
      case 'updateEditMessage':
      case 'updateEditChannelMessage':
        if (upd.message._ !== 'messageEmpty') this.emit('editMessage', new Message(this, upd.message));
        break;
      case 'updateDeleteMessages':
        this.emit('deleteMessages', { ids: upd.messages });
        break;
      case 'updateDeleteChannelMessages':
        this.emit('deleteMessages', { chatId: markedId('channel', upd.channel_id), ids: upd.messages });
        break;
    }
  }

  /** Fetches updates missed because of a gap. */
  getDifference(): Promise<void> {
    return (this.gettingDifference ??= (async () => {
      const s = this.state;
      if (!s) return;
      for (;;) {
        const r: any = await this.call('updates.getDifference', { pts: s.pts, date: s.date, qts: s.qts });
        if (r._ === 'updates.differenceEmpty') {
          s.date = r.date;
          s.seq = r.seq;
          break;
        }
        if (r._ === 'updates.differenceTooLong') {
          s.pts = r.pts;
          break;
        }
        this.cacheEntities(r);
        const entities = { users: r.users, chats: r.chats };
        for (const m of r.new_messages) this.dispatch({ _: 'updateNewMessage', message: m }, entities);
        for (const upd of r.other_updates) {
          if (upd._ === 'updateChannelTooLong') {
            void this.getChannelDifference(upd.channel_id);
            continue;
          }
          const ch = this.channelIdOf(upd);
          if (ch !== undefined && upd.pts !== undefined) s.channels[String(ch)] = upd.pts;
          this.dispatch(upd, entities);
        }
        const st = r._ === 'updates.differenceSlice' ? r.intermediate_state : r.state;
        Object.assign(s, { pts: st.pts, qts: st.qts, date: st.date, seq: st.seq });
        if (r._ !== 'updates.differenceSlice') break;
      }
      this.save();
    })().finally(() => (this.gettingDifference = undefined)));
  }

  private readonly channelDiffs = new Map<bigint, Promise<void>>();

  private getChannelDifference(channelId: bigint): Promise<void> {
    let p = this.channelDiffs.get(channelId);
    if (p) return p;
    p = (async () => {
      const s = this.state;
      const cached = this.peers.get(markedId('channel', channelId));
      if (!s || !cached) return;
      const key = String(channelId);
      let pts = s.channels[key];
      if (pts === undefined) return;
      const channel: tl.TypeInputChannel = { _: 'inputChannel', channel_id: channelId, access_hash: cached.accessHash };
      for (;;) {
        const r: any = await this.call('updates.getChannelDifference', {
          channel, filter: { _: 'channelMessagesFilterEmpty' }, pts, limit: this.isBot ? 100000 : 100, force: false,
        });
        this.cacheEntities(r);
        const entities = { users: r.users ?? [], chats: r.chats ?? [] };
        if (r._ === 'updates.channelDifferenceEmpty') {
          pts = r.pts;
        } else if (r._ === 'updates.channelDifferenceTooLong') {
          pts = r.dialog.pts ?? pts;
          for (const m of r.messages) this.dispatch({ _: 'updateNewChannelMessage', message: m }, entities);
        } else {
          pts = r.pts;
          for (const m of r.new_messages) this.dispatch({ _: 'updateNewChannelMessage', message: m }, entities);
          for (const upd of r.other_updates) this.dispatch(upd, entities);
        }
        s.channels[key] = pts;
        if (r.final) break;
      }
      this.save();
    })().finally(() => this.channelDiffs.delete(channelId));
    this.channelDiffs.set(channelId, p);
    return p;
  }

  /** Keeps the process alive until disconnect (handy at the end of scripts with event handlers). */
  idle(): Promise<void> {
    return new Promise((resolve) => {
      const t = setInterval(() => {}, 1 << 30);
      const stop = async () => {
        clearInterval(t);
        await this.disconnect();
        resolve();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  }
}

export type { PeerType };
