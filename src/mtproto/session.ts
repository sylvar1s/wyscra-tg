import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type PeerType = 'user' | 'chat' | 'channel';

/** Cached peer: enough to build an InputPeer. */
export interface CachedPeer {
  type: PeerType;
  id: bigint;
  accessHash: bigint;
  username?: string;
  phone?: string;
  /** min peers only have a limited access hash */
  min?: boolean;
}

export interface UpdateState {
  pts: number;
  qts: number;
  date: number;
  seq: number;
  channels: Record<string, number>;
}

export interface SessionData {
  version: 1;
  dcId: number;
  testServers: boolean;
  /** hex auth keys per DC */
  authKeys: Record<string, string>;
  /** DCs where the account authorization was imported */
  authorizedDcs: number[];
  userId?: string;
  isBot?: boolean;
  state?: UpdateState;
  /** markedId → [type, id, accessHash, username?, phone?] */
  peers: Record<string, [PeerType, string, string, string?, string?]>;
}

export const emptySession = (): SessionData => ({ version: 1, dcId: 2, testServers: false, authKeys: {}, authorizedDcs: [], peers: {} });

/** Where the session is stored. Implement it to keep sessions in a database. */
export interface SessionStorage {
  load(): SessionData | undefined | Promise<SessionData | undefined>;
  save(data: SessionData): void | Promise<void>;
  delete?(): void | Promise<void>;
}

/** Keeps the session in memory only (lost on exit). */
export class MemorySession implements SessionStorage {
  constructor(private data?: SessionData) {}
  load() {
    return this.data;
  }
  save(data: SessionData) {
    this.data = data;
  }
  delete() {
    this.data = undefined;
  }
}

export interface SessionEncryption {
  /**
   * Пароль для шифрования сессии (AES-256-GCM, ключ из scrypt). Без него auth key лежит открытым текстом
   * и даёт полный доступ к аккаунту любому, кто прочитает файл или строку.
   * Храните пароль отдельно от сессии, например в переменной окружения.
   */
  password?: string;
}

const ENC_FORMAT = 'wyscra-aes256gcm-scrypt';
const SCRYPT = { N: 1 << 14, r: 8, p: 1 };

/** Derives the key once per salt (scrypt is deliberately slow; sessions are saved often). */
class SessionCipher {
  private salt?: Buffer;
  private key?: Buffer;
  constructor(private readonly password: string) {
    if (!password) throw new Error('[wyscra-tg] Пустой пароль сессии');
  }
  private keyFor(salt: Buffer): Buffer {
    if (!this.key || !this.salt?.equals(salt)) {
      this.salt = Buffer.from(salt);
      this.key = scryptSync(this.password, salt, 32, SCRYPT);
    }
    return this.key;
  }
  /** → salt(16) | iv(12) | tag(16) | ciphertext */
  seal(plain: string): Buffer {
    const salt = this.salt ?? randomBytes(16);
    const key = this.keyFor(salt);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return Buffer.concat([salt, iv, c.getAuthTag(), ct]);
  }
  open(buf: Buffer): string {
    if (buf.length < 44) throw new Error('слишком короткие данные');
    const key = this.keyFor(buf.subarray(0, 16));
    const d = createDecipheriv('aes-256-gcm', key, buf.subarray(16, 28));
    d.setAuthTag(buf.subarray(28, 44));
    try {
      return Buffer.concat([d.update(buf.subarray(44)), d.final()]).toString('utf8');
    } catch {
      throw new Error('неверный пароль или данные повреждены');
    }
  }
}

/**
 * JSON file session (default). `new FileSession('bot')` → `bot.session.json`. Keep this file secret.
 * `new FileSession('bot', { password: process.env.SESSION_PASSWORD })` — файл зашифрован
 * (найденный открытый файл загрузится и перешифруется при следующем сохранении).
 */
export class FileSession implements SessionStorage {
  readonly path: string;
  private readonly cipher?: SessionCipher;
  constructor(path: string, options: SessionEncryption = {}) {
    this.path = /\.json$/i.test(path) ? path : `${path}.session.json`;
    if (options.password !== undefined) this.cipher = new SessionCipher(options.password);
  }
  load(): SessionData | undefined {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
    // A broken session must not be silently replaced by a fresh one: the next save would overwrite the auth key.
    const fail = (why: string) =>
      new Error(`[wyscra-tg] Не удалось прочитать сессию ${this.path}: ${why}. Файл не тронут — исправьте его или удалите, чтобы войти заново.`);
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw fail(`файл повреждён (${(e as Error).message})`);
    }
    if (parsed?.format !== ENC_FORMAT) return parsed;
    if (!this.cipher) throw fail('сессия зашифрована, передайте password');
    try {
      return JSON.parse(this.cipher.open(Buffer.from(parsed.data, 'base64')));
    } catch (e) {
      throw fail((e as Error).message);
    }
  }
  save(data: SessionData): void {
    const json = JSON.stringify(data);
    const out = this.cipher ? JSON.stringify({ format: ENC_FORMAT, data: this.cipher.seal(json).toString('base64') }) : json;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path + '.tmp', out, { mode: 0o600 });
    renameSync(this.path + '.tmp', this.path);
  }
  delete(): void {
    rmSync(this.path, { force: true });
  }
}

const ENC_PREFIX = 'enc1.';

/**
 * Portable session in a single string (auth key + DC). Store it in an env variable.
 * Get one with `client.exportSession()`; `client.exportSession(password)` gives an encrypted string
 * that loads with `new StringSession(str, { password })`.
 */
export class StringSession implements SessionStorage {
  private data?: SessionData;
  constructor(value = '', options: SessionEncryption = {}) {
    if (value) {
      let json: string;
      if (value.startsWith(ENC_PREFIX)) {
        if (options.password === undefined) throw new Error('[wyscra-tg] Строка сессии зашифрована, передайте password');
        try {
          json = new SessionCipher(options.password).open(Buffer.from(value.slice(ENC_PREFIX.length), 'base64url'));
        } catch (e) {
          throw new Error(`[wyscra-tg] Не удалось расшифровать строку сессии: ${(e as Error).message}`);
        }
      } else json = Buffer.from(value, 'base64url').toString('utf8');
      let raw: any;
      try {
        raw = JSON.parse(json);
      } catch {
        throw new Error('[wyscra-tg] Строка сессии повреждена');
      }
      this.data = { ...emptySession(), ...raw };
    }
  }
  load() {
    return this.data;
  }
  save(data: SessionData) {
    this.data = data;
  }
  static encode(data: SessionData, password?: string): string {
    const { dcId, testServers, authKeys, authorizedDcs, userId, isBot } = data;
    const json = JSON.stringify({ version: 1, dcId, testServers, authKeys: { [dcId]: authKeys[dcId] }, authorizedDcs: [dcId].filter((d) => authorizedDcs.includes(d)), userId, isBot });
    if (password === undefined) return Buffer.from(json).toString('base64url');
    return ENC_PREFIX + new SessionCipher(password).seal(json).toString('base64url');
  }
}

/** Marked peer id (Bot API style): users > 0, chats < 0, channels -100… */
export function markedId(type: PeerType, id: bigint | number): number {
  const n = Number(id);
  if (type === 'user') return n;
  if (type === 'chat') return -n;
  return -(1_000_000_000_000 + n);
}

export function unmarkId(marked: number): { type: PeerType; id: bigint } {
  if (marked > 0) return { type: 'user', id: BigInt(marked) };
  if (marked <= -1_000_000_000_000) return { type: 'channel', id: BigInt(-marked - 1_000_000_000_000) };
  return { type: 'chat', id: BigInt(-marked) };
}
