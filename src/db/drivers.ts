import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Фильтр `{ поле: значение }` по полям верхнего уровня. Семантика одинакова во всех драйверах:
 * - строка / число / boolean — строгое равенство (`5` ≠ `'5'`, `true` ≠ `1`, массив `[5]` ≠ `5`);
 * - `null` — поле равно null **или отсутствует**;
 * - объект / массив — глубокое равенство (порядок ключей не важен, порядок элементов массива важен);
 * - `undefined` — условие пропускается.
 */
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
  /**
   * Записи коллекции. `filter` содержит только простые значения (строка, число, boolean, null) —
   * сложные условия `Collection` проверяет сама. Семантика — см. {@link Filter}.
   */
  list(coll: string, filter?: Filter, limit?: number): Promise<Array<[string, any]>>;
  count(coll: string, filter?: Filter): Promise<number>;
  /**
   * Атомарное чтение-изменение-запись одной записи: `fn` получает текущее значение (или undefined)
   * и возвращает новое. Может вызывать `fn` повторно при конфликте, поэтому `fn` должна быть без побочных эффектов.
   * Если драйвер его не реализует, `Collection.update` сериализует изменения внутри процесса.
   */
  update?(coll: string, key: string, fn: (current: any | undefined) => any): Promise<any>;
  close(): Promise<void>;
  /** Исходное подключение (pg Pool, mysql2 Pool, MongoClient, клиент Redis, DatabaseSync). */
  readonly raw: unknown;
}

// ---------------- общая семантика фильтров ----------------

const isPlain = (x: unknown): x is string | number | boolean | null =>
  x === null || typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x));
const FIELD = /^\w+$/;

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
}

/** Эталонная проверка фильтра (см. {@link Filter}). Драйверы, выполняющие фильтр в БД, обязаны совпадать с ней. */
export function matchesFilter(doc: any, filter?: Filter): boolean {
  if (!filter) return true;
  for (const [k, x] of Object.entries(filter)) {
    if (x === undefined) continue;
    const v = doc?.[k];
    if (x === null ? v != null : !deepEqual(v, x)) return false;
  }
  return true;
}

/**
 * Делит фильтр на часть, которую драйвер выполняет в БД (простые значения у обычных имён полей),
 * и часть, которую проверяет `Collection` (объекты, массивы, необычные имена полей).
 * @internal
 */
export function splitFilter(filter?: Filter): { simple?: Filter; complex?: Filter } {
  if (!filter) return {};
  let simple: Filter | undefined;
  let complex: Filter | undefined;
  for (const [k, x] of Object.entries(filter)) {
    if (x === undefined) continue;
    if (isPlain(x) && FIELD.test(k)) (simple ??= {})[k] = x;
    else (complex ??= {})[k] = x;
  }
  return { simple, complex };
}

const checkField = (k: string) => {
  if (!FIELD.test(k)) throw new Error(`Недопустимое имя поля в фильтре: ${k}`);
  return k;
};

// ---------------- повреждённые данные ----------------

/** Разбирает одну запись; при повреждении сообщает, какая именно запись сломана. */
function parseRow(coll: string, key: string, s: string): any {
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new Error(`[wyscra-tg] Повреждённая запись ${coll}/${key}: ${(e as Error).message}`);
  }
}

/** Разбор строк для list(): повреждённая запись пропускается с предупреждением, а не роняет весь запрос. */
function parseRows(coll: string, rows: Iterable<[string, string]>, f: Filter | undefined, limit = Infinity): Array<[string, any]> {
  const out: Array<[string, any]> = [];
  for (const [k, s] of rows) {
    let v: any;
    try {
      v = parseRow(coll, k, s);
    } catch (e) {
      console.warn((e as Error).message, '— пропускаю');
      continue;
    }
    if (matchesFilter(v, f)) out.push([k, v]);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Читает JSON-файл. Нет файла (или он пуст) → undefined. Файл есть, но повреждён → ошибка:
 * молча начать с пустых данных значило бы перезаписать файл и потерять всё.
 * @internal
 */
export function readJsonFile(path: string, what: string): any {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(
      `[wyscra-tg] ${what} ${path} повреждён (${(e as Error).message}). Данные не тронуты: восстановите файл из резервной копии или удалите его, чтобы начать заново.`,
    );
  }
}

/** Атомарная запись файла: во временный файл, затем rename. @internal */
export function writeFileAtomic(path: string, data: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + '.tmp', data, mode === undefined ? undefined : { mode });
  renameSync(path + '.tmp', path);
}

async function optional(pkg: string, db: string): Promise<any> {
  try {
    return await import(pkg);
  } catch {
    throw new Error(`Для ${db} установите драйвер: npm install ${pkg}`);
  }
}

const MAX_RETRIES = 100;
const conflict = (db: string) => new Error(`[wyscra-tg] ${db}: не удалось атомарно обновить запись — слишком много одновременных изменений`);

/** Repeats a transaction the database aborted because of a deadlock / lock conflict (the other one went through). */
async function retryTx<R>(isRetryable: (e: any) => boolean, run: () => Promise<R>): Promise<R> {
  for (let i = 0; ; i++) {
    try {
      return await run();
    } catch (e) {
      if (i >= MAX_RETRIES || !isRetryable(e)) throw e;
      await new Promise((r) => setTimeout(r, Math.random() * Math.min(50, 2 + i * 2)));
    }
  }
}
// Postgres: deadlock_detected, serialization_failure. MySQL: ER_LOCK_DEADLOCK, ER_LOCK_WAIT_TIMEOUT.
const pgRetryable = (e: any) => e?.code === '40P01' || e?.code === '40001';
const mysqlRetryable = (e: any) => e?.errno === 1213 || e?.errno === 1205;

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
  /** Атомарно: чтение и запись в одном синхронном шаге. */
  async update(c: string, k: string, fn: (cur: any) => any) {
    const next = fn(this.getSync(c, k));
    this.coll(c).set(k, JSON.stringify(next));
    this.changed();
    return next;
  }
  async delete(c: string, k: string) {
    const ok = this.data.get(c)?.delete(k) ?? false;
    if (ok) this.changed();
    return ok;
  }
  async list(c: string, f?: Filter, limit = Infinity) {
    return parseRows(c, this.data.get(c) ?? [], f, limit);
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
    const raw = readJsonFile(path, 'Файл базы данных') as Record<string, Record<string, unknown>> | undefined;
    for (const [c, items] of Object.entries(raw ?? {})) this.data.set(c, new Map(Object.entries(items).map(([k, v]) => [k, JSON.stringify(v)])));
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
    writeFileAtomic(this.path, JSON.stringify(out, null, 1));
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
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
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
      const p = `'$."${checkField(k)}"'`;
      if (v === null) parts.push(`COALESCE(json_type(value, ${p}), 'null') = 'null'`);
      else if (typeof v === 'boolean') parts.push(`json_type(value, ${p}) = '${v}'`);
      else if (typeof v === 'number') {
        parts.push(`json_type(value, ${p}) IN ('integer', 'real') AND json_extract(value, ${p}) = ?`);
        args.push(v);
      } else {
        parts.push(`json_type(value, ${p}) = 'text' AND json_extract(value, ${p}) = ?`);
        args.push(v);
      }
    }
    return { sql: parts.join(' AND '), args };
  };
  const read = (c: string, k: string) => {
    const r = q.get.get(c, k);
    return r ? parseRow(c, k, r.value) : undefined;
  };
  return {
    name: 'sqlite',
    raw: db,
    async get(c, k) {
      return read(c, k);
    },
    getSync: read,
    async set(c, k, v) {
      q.set.run(c, k, JSON.stringify(v));
    },
    async update(c, k, fn) {
      // BEGIN IMMEDIATE берёт блокировку записи сразу — атомарно и между процессами.
      db.exec('BEGIN IMMEDIATE');
      try {
        const next = fn(read(c, k));
        q.set.run(c, k, JSON.stringify(next));
        db.exec('COMMIT');
        return next;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async delete(c, k) {
      return q.del.run(c, k).changes > 0;
    },
    async list(c, f, limit) {
      const w = where(f);
      const rows = db.prepare(`SELECT key, value FROM wyscra_kv WHERE ${w.sql}${limit ? ` LIMIT ${Number(limit)}` : ''}`).all(c, ...w.args);
      return parseRows(c, rows.map((r: any) => [r.key, r.value] as [string, string]), undefined);
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
  const where = (c: string, f?: Filter) => {
    const parts = ['coll = $1'];
    const args: unknown[] = [c];
    for (const [k, v] of Object.entries(f ?? {})) {
      args.push(checkField(k));
      const field = `value -> ($${args.length}::text)`;
      if (v === null) parts.push(`(${field} IS NULL OR ${field} = 'null'::jsonb)`);
      else {
        args.push(JSON.stringify(v));
        parts.push(`${field} = $${args.length}::jsonb`);
      }
    }
    return { sql: parts.join(' AND '), args };
  };
  return {
    name: 'postgres',
    raw: pool,
    async get(c, k) {
      const r = await pool.query('SELECT value FROM wyscra_kv WHERE coll = $1 AND key = $2', [c, k]);
      return r.rows[0]?.value ?? undefined;
    },
    async set(c, k, v) {
      await pool.query(
        'INSERT INTO wyscra_kv (coll, key, value) VALUES ($1, $2, $3) ON CONFLICT (coll, key) DO UPDATE SET value = EXCLUDED.value',
        [c, k, JSON.stringify(v)],
      );
    },
    update: (c, k, fn) => retryTx(pgRetryable, async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Заготовка строки, чтобы было что блокировать, даже если записи ещё нет (JSON null = «нет записи»).
        await client.query("INSERT INTO wyscra_kv (coll, key, value) VALUES ($1, $2, 'null'::jsonb) ON CONFLICT DO NOTHING", [c, k]);
        const r = await client.query('SELECT value FROM wyscra_kv WHERE coll = $1 AND key = $2 FOR UPDATE', [c, k]);
        const next = fn(r.rows[0]?.value ?? undefined);
        await client.query('UPDATE wyscra_kv SET value = $3 WHERE coll = $1 AND key = $2', [c, k, JSON.stringify(next)]);
        await client.query('COMMIT');
        return next;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }),
    async delete(c, k) {
      return (await pool.query('DELETE FROM wyscra_kv WHERE coll = $1 AND key = $2', [c, k])).rowCount > 0;
    },
    async list(c, f, limit) {
      const w = where(c, f);
      const r = await pool.query(`SELECT key, value FROM wyscra_kv WHERE ${w.sql} AND value <> 'null'::jsonb${limit ? ` LIMIT ${Number(limit)}` : ''}`, w.args);
      return r.rows.map((x: any) => [x.key, x.value]);
    },
    async count(c, f) {
      const w = where(c, f);
      const r = await pool.query(`SELECT COUNT(*)::int AS n FROM wyscra_kv WHERE ${w.sql} AND value <> 'null'::jsonb`, w.args);
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
  const where = (c: string, f?: Filter) => {
    const parts = ['coll = ?', "JSON_TYPE(value) <> 'NULL'"];
    const args: unknown[] = [c];
    for (const [k, v] of Object.entries(f ?? {})) {
      const path = `$."${checkField(k)}"`;
      if (v === null) {
        parts.push("(JSON_EXTRACT(value, ?) IS NULL OR JSON_TYPE(JSON_EXTRACT(value, ?)) = 'NULL')");
        args.push(path, path);
      } else {
        parts.push('JSON_EXTRACT(value, ?) = CAST(? AS JSON)');
        args.push(path, JSON.stringify(v));
      }
    }
    return { sql: parts.join(' AND '), args };
  };
  return {
    name: 'mysql',
    raw: pool,
    async get(c, k) {
      const [rows] = await pool.query('SELECT value FROM wyscra_kv WHERE coll = ? AND `key` = ?', [c, k]);
      return rows[0] ? (parse(rows[0].value) ?? undefined) : undefined;
    },
    async set(c, k, v) {
      await pool.query('INSERT INTO wyscra_kv (coll, `key`, value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [c, k, JSON.stringify(v)]);
    },
    update: (c, k, fn) => retryTx(mysqlRetryable, async () => {
      const conn = await pool.getConnection();
      try {
        await conn.query('START TRANSACTION');
        await conn.query("INSERT IGNORE INTO wyscra_kv (coll, `key`, value) VALUES (?, ?, CAST('null' AS JSON))", [c, k]);
        const [rows] = await conn.query('SELECT value FROM wyscra_kv WHERE coll = ? AND `key` = ? FOR UPDATE', [c, k]);
        const next = fn(rows[0] ? (parse(rows[0].value) ?? undefined) : undefined);
        await conn.query('UPDATE wyscra_kv SET value = ? WHERE coll = ? AND `key` = ?', [JSON.stringify(next), c, k]);
        await conn.query('COMMIT');
        return next;
      } catch (e) {
        await conn.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        conn.release();
      }
    }),
    async delete(c, k) {
      const [r] = await pool.query('DELETE FROM wyscra_kv WHERE coll = ? AND `key` = ?', [c, k]);
      return r.affectedRows > 0;
    },
    async list(c, f, limit) {
      const w = where(c, f);
      const [rows] = await pool.query(`SELECT \`key\`, value FROM wyscra_kv WHERE ${w.sql}${limit ? ` LIMIT ${Number(limit)}` : ''}`, w.args);
      return rows.map((x: any) => [x.key, parse(x.value)]);
    },
    async count(c, f) {
      const w = where(c, f);
      const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM wyscra_kv WHERE ${w.sql}`, w.args);
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
  // Служебная версия записи для атомарного update (compare-and-swap); имя с префиксом, чтобы не задеть поля пользователя.
  const REV = '__wyscra_rev';
  // 0.2.0 хранила версию в `_v` (UUID); такие значения убираем при чтении, пользовательский `_v` не трогаем.
  const LEGACY_REV = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const strip = (d: any) => {
    const { _id, [REV]: _rev, ...rest } = d;
    if (_rev === undefined && typeof rest._v === 'string' && LEGACY_REV.test(rest._v)) delete rest._v;
    return rest;
  };
  const query = (f?: Filter) => {
    const and: Array<Record<string, unknown>> = [];
    for (const [k, v] of Object.entries(f ?? {})) {
      checkField(k);
      // { $eq } и { $type } в Mongo совпадают и с массивом, содержащим значение, поэтому массивы исключаем явно.
      if (v === null) and.push({ $or: [{ [k]: { $exists: false } }, { [k]: { $type: 'null', $not: { $type: 'array' } } }] });
      else and.push({ [k]: { $eq: v, $not: { $type: 'array' } } });
    }
    return and.length ? { $and: and } : {};
  };
  return {
    name: 'mongodb',
    raw: client,
    async get(c, k) {
      const d = await db.collection(c).findOne({ _id: k });
      return d ? strip(d) : undefined;
    },
    async set(c, k, v) {
      await db.collection(c).replaceOne({ _id: k }, { ...v, _id: k, [REV]: randomUUID() }, { upsert: true });
    },
    async update(c, k, fn) {
      const coll = db.collection(c);
      for (let i = 0; i < MAX_RETRIES; i++) {
        const d = await coll.findOne({ _id: k });
        const next = fn(d ? strip(d) : undefined);
        const doc = { ...next, _id: k, [REV]: randomUUID() };
        if (!d) {
          try {
            await coll.insertOne(doc);
            return next;
          } catch (e: any) {
            if (e?.code === 11000) continue; // кто-то успел создать запись — повторяем
            throw e;
          }
        }
        // Записи из 0.2.0 без REV сравниваем по старому `_v` (или по его отсутствию).
        const guard = d[REV] !== undefined ? { [REV]: d[REV] } : { [REV]: { $exists: false }, _v: d._v ?? { $exists: false } };
        const r = await coll.replaceOne({ _id: k, ...guard }, doc);
        if (r.matchedCount) return next;
      }
      throw conflict('MongoDB');
    },
    async delete(c, k) {
      return (await db.collection(c).deleteOne({ _id: k })).deletedCount > 0;
    },
    async list(c, f, limit) {
      let cur = db.collection(c).find(query(f));
      if (limit) cur = cur.limit(limit);
      return (await cur.toArray()).map((d: any) => [String(d._id), strip(d)]);
    },
    async count(c, f) {
      return db.collection(c).countDocuments(query(f));
    },
    async close() {
      await client.close();
    },
  };
}

// ---------------- Redis (npm i redis  или  npm i ioredis) ----------------

/** Compare-and-set поля хэша: записывает ARGV[3], только если текущее значение равно ARGV[2] ('' = поля нет). */
const REDIS_CAS = `local cur = redis.call('HGET', KEYS[1], ARGV[1])
if (cur == false and ARGV[2] == '') or cur == ARGV[2] then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
  return 1
end
return 0`;

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
  const isNode = !!client.hGet;
  const key = (c: string) => `wyscra:${c}`;
  const hget = (c: string, k: string): Promise<string | null> => (isNode ? client.hGet(key(c), k) : client.hget(key(c), k));
  const hgetall = (c: string) => (isNode ? client.hGetAll(key(c)) : client.hgetall(key(c)));
  const cas = async (c: string, k: string, prev: string | null, next: string): Promise<boolean> => {
    const args = [k, prev ?? '', next];
    const r = isNode ? await client.eval(REDIS_CAS, { keys: [key(c)], arguments: args }) : await client.eval(REDIS_CAS, 1, key(c), ...args);
    return Number(r) === 1;
  };
  const driver: Driver = {
    name: 'redis',
    raw: client,
    async get(c, k) {
      const s = await hget(c, k);
      return s == null ? undefined : parseRow(c, k, s);
    },
    async set(c, k, v) {
      await (isNode ? client.hSet(key(c), k, JSON.stringify(v)) : client.hset(key(c), k, JSON.stringify(v)));
    },
    async update(c, k, fn) {
      for (let i = 0; i < MAX_RETRIES; i++) {
        const s = await hget(c, k);
        const next = fn(s == null ? undefined : parseRow(c, k, s));
        if (await cas(c, k, s, JSON.stringify(next))) return next;
      }
      throw conflict('Redis');
    },
    async delete(c, k) {
      return (await (isNode ? client.hDel(key(c), k) : client.hdel(key(c), k))) > 0;
    },
    async list(c, f, limit = Infinity) {
      return parseRows(c, Object.entries((await hgetall(c)) ?? {}) as Array<[string, string]>, f, limit);
    },
    async count(c, f) {
      if (!f) return Number(await (isNode ? client.hLen(key(c)) : client.hlen(key(c))));
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
