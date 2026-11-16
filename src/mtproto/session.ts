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

/** JSON file session (default). `new FileSession('bot')` → `bot.session.json`. Keep this file secret. */
export class FileSession implements SessionStorage {
  readonly path: string;
  constructor(path: string) {
    this.path = /\.json$/i.test(path) ? path : `${path}.session.json`;
  }
  load(): SessionData | undefined {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      return undefined;
    }
  }
  save(data: SessionData): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path + '.tmp', JSON.stringify(data), { mode: 0o600 });
    renameSync(this.path + '.tmp', this.path);
  }
  delete(): void {
    rmSync(this.path, { force: true });
  }
}

/**
 * Portable session in a single string (auth key + DC). Store it in an env variable.
 * Get one with `client.exportSession()`.
 */
export class StringSession implements SessionStorage {
  private data?: SessionData;
  constructor(value = '') {
    if (value) {
      const raw = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      this.data = { ...emptySession(), ...raw };
    }
  }
  load() {
    return this.data;
  }
  save(data: SessionData) {
    this.data = data;
  }
  static encode(data: SessionData): string {
    const { dcId, testServers, authKeys, authorizedDcs, userId, isBot } = data;
    return Buffer.from(JSON.stringify({ version: 1, dcId, testServers, authKeys: { [dcId]: authKeys[dcId] }, authorizedDcs: [dcId].filter((d) => authorizedDcs.includes(d)), userId, isBot })).toString('base64url');
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
