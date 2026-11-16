import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Простой фильтр: { поле: значение } (точное совпадение по верхнему уровню). */
export type Filter = Record<string, unknown>;

/**
 * Драйвер хранилища. Реализуйте его, чтобы подключить свою БД.
 * Данные — JSON-объекты в «коллекциях» по строковому ключу.
 */
export interface Driver {
  readonly name: string;
  get(coll: string, key: string): Promise<any | undefined>;
  /** Синхронное чтение, если хранилище умеет (память, JSON, SQLite) — ускоряет ctx.user / ctx.session. */
  getSync?(coll: string, key: string): any | undefined;
  set(coll: string, key: string, value: any): Promise<void>;
  delete(coll: string, key: string): Promise<boolean>;
  /** Все записи коллекции (с фильтром, если драйвер умеет его выполнять сам). */
  list(coll: string, filter?: Filter, limit?: number): Promise<Array<[string, any]>>;
  count(coll: string, filter?: Filter): Promise<number>;
  close(): Promise<void>;
  /** Исходное подключение (pg Pool, mysql2 Pool, MongoClient, клиент Redis, DatabaseSync). */
  readonly raw: unknown;
}

const matches = (v: any, f?: Filter) => !f || Object.entries(f).every(([k, x]) => v?.[k] === x);

async function optional(pkg: string, db: string): Promise<any> {
  try {
    return await import(pkg);
  } catch {
    throw new Error(`Для ${db} установите драйвер: npm install ${pkg}`);
  }
}

// ---------------- память ----------------

export class MemoryDriver implements Driver {
  readonly name: string = 'memory';
  protected data = new Map<string, Map<string, string>>();
  get raw() {
    return this.data;
  }
  protected coll(c: string) {
    let m = this.data.get(c);
    if (!m) this.data.set(c, (m = new Map()));
    return m;
  }
  async get(c: string, k: string) {
    return this.getSync(c, k);
  }
  getSync(c: string, k: string) {
    const s = this.data.get(c)?.get(k);
    return s === undefined ? undefined : JSON.parse(s);
  }
  async set(c: string, k: string, v: any) {
    this.coll(c).set(k, JSON.stringify(v));
    this.changed();
  }
  async delete(c: string, k: string) {
    const ok = this.data.get(c)?.delete(k) ?? false;
    if (ok) this.changed();
    return ok;
  }
  async list(c: string, f?: Filter, limit = Infinity) {
    const out: Array<[string, any]> = [];
    for (const [k, s] of this.data.get(c) ?? []) {
      const v = JSON.parse(s);
      if (matches(v, f)) out.push([k, v]);
      if (out.length >= limit) break;
    }
    return out;
  }
  async count(c: string, f?: Filter) {
    return f ? (await this.list(c, f)).length : (this.data.get(c)?.size ?? 0);
  }
  protected changed() {}
  async close() {}
}

// ---------------- JSON-файл ----------------

export class JsonDriver extends MemoryDriver {
  override readonly name = 'json';
  private timer?: NodeJS.Timeout;
  constructor(readonly path: string) {
    super();
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>;
      for (const [c, items] of Object.entries(raw)) this.data.set(c, new Map(Object.entries(items).map(([k, v]) => [k, JSON.stringify(v)])));
    } catch {}
    process.once('exit', () => this.flush());
  }
  protected override changed() {
    this.timer ??= setTimeout(() => this.flush(), 300);
  }
  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const out: Record<string, Record<string, unknown>> = {};
    for (const [c, m] of this.data) out[c] = Object.fromEntries([...m].map(([k, s]) => [k, JSON.parse(s)]));
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path + '.tmp', JSON.stringify(out, null, 1));
    renameSync(this.path + '.tmp', this.path);
  }
  override async close() {
    this.flush();
  }
}

// ---------------- SQLite (встроен в Node.js 22.5+) ----------------

export async function sqliteDriver(path: string): Promise<Driver> {
  let mod: any;
  try {
    const name = 'node:sqlite';
    mod = await import(name);
  } catch {
    throw new Error('SQLite встроен в Node.js 22.13+. Обновите Node.js или используйте db: "data.json"');
  }
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new mod.DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec('CREATE TABLE IF NOT EXISTS wyscra_kv (coll TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (coll, key)) WITHOUT ROWID');
  const q = {
    get: db.prepare('SELECT value FROM wyscra_kv WHERE coll = ? AND key = ?'),
    set: db.prepare('INSERT INTO wyscra_kv (coll, key, value) VALUES (?, ?, ?) ON CONFLICT (coll, key) DO UPDATE SET value = excluded.value'),
    del: db.prepare('DELETE FROM wyscra_kv WHERE coll = ? AND key = ?'),
  };
  const where = (f?: Filter) => {
    const parts = ['coll = ?'];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(f ?? {})) {
      if (!/^\w+$/.test(k)) throw new Error(`Недопустимое имя поля: ${k}`);
      if (v === null) parts.push(`json_extract(value, '$.${k}') IS NULL`);
      else {
        parts.push(`json_extract(value, '$.${k}') = ?`);
        args.push(typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'object' ? JSON.stringify(v) : v);
      }
    }
    return { sql: parts.join(' AND '), args };
  };
  return {
    name: 'sqlite',
    raw: db,
    async get(c, k) {
      const r = q.get.get(c, k);
      return r ? JSON.parse(r.value) : undefined;
    },
    getSync(c, k) {
      const r = q.get.get(c, k);
      return r ? JSON.parse(r.value) : undefined;
    },
    async set(c, k, v) {
      q.set.run(c, k, JSON.stringify(v));
    },
    async delete(c, k) {
      return q.del.run(c, k).changes > 0;
    },
    async list(c, f, limit) {
      const w = where(f);
      const rows = db.prepare(`SELECT key, value FROM wyscra_kv WHERE ${w.sql}${limit ? ` LIMIT ${Number(limit)}` : ''}`).all(c, ...w.args);
      return rows.map((r: any) => [r.key, JSON.parse(r.value)]);
    },
    async count(c, f) {
      const w = where(f);
      return db.prepare(`SELECT COUNT(*) AS n FROM wyscra_kv WHERE ${w.sql}`).get(c, ...w.args).n;
    },
    async close() {
      db.close();
    },
  };
}

// ---------------- PostgreSQL (npm i pg) ----------------

export async function postgresDriver(url: string): Promise<Driver> {
  const pg = await optional('pg', 'PostgreSQL');
  const Pool = pg.Pool ?? pg.default?.Pool;
  const pool = new Pool({ connectionString: url });
  await pool.query('CREATE TABLE IF NOT EXISTS wyscra_kv (coll TEXT NOT NULL, key TEXT NOT NULL, value JSONB NOT NULL, PRIMARY KEY (coll, key))');
  return {
    name: 'postgres',
    raw: pool,
    async get(c, k) {
      const r = await pool.query('SELECT value FROM wyscra_kv WHERE coll = $1 AND key = $2', [c, k]);
      return r.rows[0]?.value;
    },
    async set(c, k, v) {
      await pool.query(
        'INSERT INTO wyscra_kv (coll, key, value) VALUES ($1, $2, $3) ON CONFLICT (coll, key) DO UPDATE SET value = EXCLUDED.value',
        [c, k, JSON.stringify(v)],
      );
    },
    async delete(c, k) {
      return (await pool.query('DELETE FROM wyscra_kv WHERE coll = $1 AND key = $2', [c, k])).rowCount > 0;
    },
    async list(c, f, limit) {
      const r = await pool.query(
        `SELECT key, value FROM wyscra_kv WHERE coll = $1 AND value @> $2::jsonb${limit ? ` LIMIT ${Number(limit)}` : ''}`,
        [c, JSON.stringify(f ?? {})],
      );
      return r.rows.map((x: any) => [x.key, x.value]);
    },
    async count(c, f) {
      const r = await pool.query('SELECT COUNT(*)::int AS n FROM wyscra_kv WHERE coll = $1 AND value @> $2::jsonb', [c, JSON.stringify(f ?? {})]);
      return r.rows[0].n;
    },
    async close() {
      await pool.end();
    },
  };
}

// ---------------- MySQL / MariaDB (npm i mysql2) ----------------

export async function mysqlDriver(url: string): Promise<Driver> {
  const mysql = await optional('mysql2/promise', 'MySQL');
  const pool = (mysql.createPool ?? mysql.default.createPool)(url);
  await pool.query(
    'CREATE TABLE IF NOT EXISTS wyscra_kv (coll VARCHAR(191) NOT NULL, `key` VARCHAR(191) NOT NULL, value JSON NOT NULL, PRIMARY KEY (coll, `key`))',
  );
  const parse = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
  return {
    name: 'mysql',
    raw: pool,
    async get(c, k) {
      const [rows] = await pool.query('SELECT value FROM wyscra_kv WHERE coll = ? AND `key` = ?', [c, k]);
      return rows[0] ? parse(rows[0].value) : undefined;
    },
    async set(c, k, v) {
      await pool.query('INSERT INTO wyscra_kv (coll, `key`, value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [c, k, JSON.stringify(v)]);
    },
    async delete(c, k) {
      const [r] = await pool.query('DELETE FROM wyscra_kv WHERE coll = ? AND `key` = ?', [c, k]);
      return r.affectedRows > 0;
    },
    async list(c, f, limit) {
      const [rows] = await pool.query(
        `SELECT \`key\`, value FROM wyscra_kv WHERE coll = ? AND JSON_CONTAINS(value, ?)${limit ? ` LIMIT ${Number(limit)}` : ''}`,
        [c, JSON.stringify(f ?? {})],
      );
      return rows.map((x: any) => [x.key, parse(x.value)]);
    },
    async count(c, f) {
      const [rows] = await pool.query('SELECT COUNT(*) AS n FROM wyscra_kv WHERE coll = ? AND JSON_CONTAINS(value, ?)', [c, JSON.stringify(f ?? {})]);
      return Number(rows[0].n);
    },
    async close() {
      await pool.end();
    },
  };
}

// ---------------- MongoDB (npm i mongodb) ----------------

export async function mongoDriver(url: string): Promise<Driver> {
  const mongo = await optional('mongodb', 'MongoDB');
  const client = new (mongo.MongoClient ?? mongo.default.MongoClient)(url);
  await client.connect();
  const db = client.db();
  const strip = (d: any) => {
    const { _id, ...rest } = d;
    return rest;
  };
  return {
    name: 'mongodb',
    raw: client,
    async get(c, k) {
      const d = await db.collection(c).findOne({ _id: k });
      return d ? strip(d) : undefined;
    },
    async set(c, k, v) {
      await db.collection(c).replaceOne({ _id: k }, { ...v, _id: k }, { upsert: true });
    },
    async delete(c, k) {
      return (await db.collection(c).deleteOne({ _id: k })).deletedCount > 0;
    },
    async list(c, f, limit) {
      let cur = db.collection(c).find(f ?? {});
      if (limit) cur = cur.limit(limit);
      return (await cur.toArray()).map((d: any) => [String(d._id), strip(d)]);
    },
    async count(c, f) {
      return db.collection(c).countDocuments(f ?? {});
    },
    async close() {
      await client.close();
    },
  };
}

// ---------------- Redis (npm i redis  или  npm i ioredis) ----------------

export async function redisDriver(url: string): Promise<Driver> {
  let client: any;
  const tryImport = async (name: string) => import(name).catch(() => undefined);
  const nodeRedis = await tryImport('redis');
  if (nodeRedis) {
    client = (nodeRedis.createClient ?? nodeRedis.default.createClient)({ url });
    await client.connect();
  } else {
    const ioredis = await tryImport('ioredis');
    if (!ioredis) throw new Error('Для Redis установите драйвер: npm install redis');
    const Redis = ioredis.default ?? ioredis;
    client = new Redis(url);
  }
  const key = (c: string) => `wyscra:${c}`;
  const hgetall = (c: string) => (client.hGetAll ? client.hGetAll(key(c)) : client.hgetall(key(c)));
  const driver: Driver = {
    name: 'redis',
    raw: client,
    async get(c, k) {
      const s = await (client.hGet ? client.hGet(key(c), k) : client.hget(key(c), k));
      return s == null ? undefined : JSON.parse(s);
    },
    async set(c, k, v) {
      await (client.hSet ? client.hSet(key(c), k, JSON.stringify(v)) : client.hset(key(c), k, JSON.stringify(v)));
    },
    async delete(c, k) {
      return (await (client.hDel ? client.hDel(key(c), k) : client.hdel(key(c), k))) > 0;
    },
    async list(c, f, limit = Infinity) {
      const out: Array<[string, any]> = [];
      for (const [k, s] of Object.entries((await hgetall(c)) ?? {})) {
        const v = JSON.parse(s as string);
        if (matches(v, f)) out.push([k, v]);
        if (out.length >= limit) break;
      }
      return out;
    },
    async count(c, f) {
      if (!f) return Number(await (client.hLen ? client.hLen(key(c)) : client.hlen(key(c))));
      return (await driver.list(c, f)).length;
    },
    async close() {
      await (client.quit ? client.quit() : client.disconnect());
    },
  };
  return driver;
}

/**
 * Подключение по строке:
 * - не указано / 'memory' — в памяти
 * - 'bot.db', 'sqlite://bot.db' — SQLite (встроен в Node.js, ничего ставить не нужно)
 * - 'data.json' — JSON-файл
 * - 'postgres://...', 'mysql://...', 'mongodb://...', 'redis://...' — нужен драйвер (pg / mysql2 / mongodb / redis)
 */
export async function connectDriver(url?: string): Promise<Driver> {
  if (!url || url === 'memory') return new MemoryDriver();
  const lower = url.toLowerCase();
  if (lower.startsWith('postgres://') || lower.startsWith('postgresql://')) return postgresDriver(url);
  if (lower.startsWith('mysql://') || lower.startsWith('mariadb://')) return mysqlDriver(url.replace(/^mariadb:/i, 'mysql:'));
  if (lower.startsWith('mongodb://') || lower.startsWith('mongodb+srv://')) return mongoDriver(url);
  if (lower.startsWith('redis://') || lower.startsWith('rediss://')) return redisDriver(url);
  if (lower.startsWith('json://')) return new JsonDriver(url.slice(7));
  if (lower.endsWith('.json')) return new JsonDriver(url);
  if (lower.startsWith('sqlite://')) return sqliteDriver(url.slice(9));
  if (/\.(db|sqlite3?)$/.test(lower) || url === ':memory:') return sqliteDriver(url);
  throw new Error(`Не понял адрес базы данных "${url}". Примеры: 'bot.db', 'data.json', 'postgres://...', 'mysql://...', 'mongodb://...', 'redis://...'`);
}
