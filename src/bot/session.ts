import { readJsonFile, writeFileAtomic } from '../db/drivers.js';
import type { Middleware } from './composer.js';
import { conversationKey, type Context, type SessionData } from './context.js';

export interface SessionStore<T = SessionData> {
  get(key: string): T | undefined | Promise<T | undefined>;
  set(key: string, value: T): unknown;
  delete(key: string): unknown;
}

/** In-memory store (default). Optional TTL in ms. */
export class MemoryStore<T = SessionData> implements SessionStore<T> {
  private readonly map = new Map<string, { value: T; expires: number }>();
  constructor(private readonly ttl = 0) {}
  get(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires && e.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }
  set(key: string, value: T): void {
    this.map.set(key, { value, expires: this.ttl ? Date.now() + this.ttl : 0 });
  }
  delete(key: string): void {
    this.map.delete(key);
  }
}

/** Persists sessions to a JSON file (debounced atomic writes). Good for small bots; use a DB store for large ones. */
export class FileStore<T = SessionData> implements SessionStore<T> {
  private data: Record<string, T> = {};
  private timer?: NodeJS.Timeout;
  constructor(
    private readonly path = 'sessions.json',
    private readonly debounceMs = 500,
  ) {
    this.data = readJsonFile(path, 'Файл сессий') ?? {};
    process.once('exit', () => this.flush());
  }
  get(key: string): T | undefined {
    return this.data[key];
  }
  set(key: string, value: T): void {
    this.data[key] = value;
    this.schedule();
  }
  delete(key: string): void {
    delete this.data[key];
    this.schedule();
  }
  private schedule() {
    this.timer ??= setTimeout(() => this.flush(), this.debounceMs);
  }
  /** Writes pending changes now. */
  flush(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    writeFileAtomic(this.path, JSON.stringify(this.data));
  }
}

export interface SessionOptions<T> {
  /** Initial value for new sessions. Default: `{}`. */
  initial?: () => T;
  /** Where sessions live. Default: MemoryStore. */
  store?: SessionStore<T>;
  /** Session key. Default: chat + user (`"chatId:userId"`). Return undefined to skip. */
  getKey?: (ctx: Context) => string | undefined;
}

/**
 * Session middleware: `ctx.session` persists between updates.
 * ```ts
 * bot.use(session({ initial: () => ({ count: 0 }) }));
 * bot.on('text', ctx => ctx.reply(`#${++ctx.session.count}`));
 * ```
 * Set `ctx.session = null` to delete it.
 */
export function session<T extends object = SessionData>(options: SessionOptions<T> = {}): Middleware {
  const store = options.store ?? new MemoryStore<T>();
  const initial = options.initial ?? (() => ({}) as T);
  const getKey = options.getKey ?? ((ctx: Context) => (ctx.chatId ?? ctx.from?.id) !== undefined ? conversationKey(ctx) : undefined);
  return async (ctx, next) => {
    const key = getKey(ctx);
    if (key === undefined) return next();
    const loaded = await store.get(key);
    const value = loaded ?? initial();
    const before = loaded === undefined ? undefined : JSON.stringify(loaded);
    ctx.session = value as SessionData;
    await next();
    const after = ctx.session as unknown;
    if (after === null || after === undefined) {
      if (loaded !== undefined) await store.delete(key);
      return;
    }
    if (before === undefined || after !== loaded || JSON.stringify(after) !== before) await store.set(key, after as T);
  };
}
