import { connectDriver, matchesFilter, splitFilter, type Driver, type Filter } from './drivers.js';

type Id = string | number | bigint;
/** Запись коллекции: ваши поля + id. */
export type Doc<T> = T & { id: string | number };

/**
 * Коллекция — «таблица» с записями по id.
 * ```ts
 * const orders = bot.db.collection('orders');
 * await orders.set(1, { item: 'Пицца', price: 500 });
 * await orders.update(1, { paid: true });
 * const unpaid = await orders.find({ paid: false });
 * ```
 */
export class Collection<T extends object = Record<string, any>> {
  constructor(
    private readonly db: Database,
    readonly name: string,
  ) {}

  private key(id: Id): string {
    return String(id);
  }
  private doc(id: string, v: any): Doc<T> {
    return { ...v, id: v?.id ?? (/^-?\d+$/.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : id) };
  }

  /** Запись по id или undefined. */
  async get(id: Id): Promise<Doc<T> | undefined> {
    const v = await (await this.db.driver()).get(this.name, this.key(id));
    return v === undefined ? undefined : this.doc(this.key(id), v);
  }

  /** Есть ли запись. */
  async has(id: Id): Promise<boolean> {
    return (await this.get(id)) !== undefined;
  }

  /** Сохраняет запись целиком (создаёт или заменяет). */
  async set(id: Id, value: T): Promise<Doc<T>> {
    const doc = this.doc(this.key(id), { ...value, id: (value as any).id ?? id });
    await (await this.db.driver()).set(this.name, this.key(id), doc);
    return doc;
  }

  /**
   * Меняет только указанные поля (если записи нет — создаёт). Атомарно: одновременные `update`/`increment`
   * одной записи не затирают друг друга (в SQL — транзакция с блокировкой строки, в Mongo/Redis — compare-and-swap).
   * Можно передать функцию: `update(id, u => ({ balance: u.balance + 10 }))` — она может вызываться
   * повторно при конфликте, поэтому не делайте в ней побочных действий (отправку сообщений и т.п.).
   */
  async update(id: Id, patch: Partial<T> | ((current: Doc<T> | undefined) => Partial<T>)): Promise<Doc<T>> {
    const key = this.key(id);
    const apply = (raw: any): Doc<T> => {
      const current = raw == null ? undefined : this.doc(key, raw);
      const changes = typeof patch === 'function' ? patch(current) : patch;
      const merged: any = { ...(current ?? {}), ...changes };
      return this.doc(key, { ...merged, id: merged.id ?? id });
    };
    const d = await this.db.driver();
    if (d.update) return d.update(this.name, key, apply);
    // Свой драйвер без атомарного update: хотя бы внутри процесса изменения одной записи идут по очереди.
    return this.db.withLock(`${this.name}\0${key}`, async () => {
      const next = apply(await d.get(this.name, key));
      await d.set(this.name, key, next);
      return next;
    });
  }

  /** Увеличивает числовое поле: `increment(userId, 'balance', 100)`. Возвращает новое значение. */
  async increment(id: Id, field: keyof T & string, by = 1): Promise<number> {
    const doc = await this.update(id, (cur) => ({ [field]: Number((cur as any)?.[field] ?? 0) + by }) as Partial<T>);
    return (doc as any)[field];
  }

  /** Удаляет запись. */
  async delete(id: Id): Promise<boolean> {
    return (await this.db.driver()).delete(this.name, this.key(id));
  }

  /** Все записи. */
  async all(limit?: number): Promise<Array<Doc<T>>> {
    return this.find(undefined, limit);
  }

  /**
   * Поиск: объект `{ поле: значение }` или функция-условие.
   * Объект работает одинаково во всех базах: точное равенство, `null` — «null или поля нет»,
   * объекты и массивы сравниваются целиком. Простые значения проверяются в самой БД.
   * ```ts
   * await users.find({ city: 'Москва' });
   * await users.find(u => u.balance > 1000);
   * ```
   */
  async find(filter?: Partial<T> | ((doc: Doc<T>) => unknown), limit?: number): Promise<Array<Doc<T>>> {
    const d = await this.db.driver();
    let test: ((doc: Doc<T>) => unknown) | undefined;
    let simple: Filter | undefined;
    if (typeof filter === 'function') test = filter;
    else {
      const parts = splitFilter(filter as Filter | undefined);
      simple = parts.simple;
      if (parts.complex) test = (doc) => matchesFilter(doc, parts.complex);
    }
    if (!test) return (await d.list(this.name, simple, limit)).map(([k, v]) => this.doc(k, v));
    const out: Array<Doc<T>> = [];
    for (const [k, v] of await d.list(this.name, simple)) {
      const doc = this.doc(k, v);
      if (test(doc)) out.push(doc);
      if (limit && out.length >= limit) break;
    }
    return out;
  }

  /** Первая подходящая запись. */
  async findOne(filter: Partial<T> | ((doc: Doc<T>) => unknown)): Promise<Doc<T> | undefined> {
    return (await this.find(filter, 1))[0];
  }

  /** Количество записей (с фильтром или без). */
  async count(filter?: Partial<T>): Promise<number> {
    const { simple, complex } = splitFilter(filter as Filter | undefined);
    if (complex) return (await this.find(filter)).length;
    return (await this.db.driver()).count(this.name, simple);
  }

  /** Перебор всех записей: `for await (const u of users) ...` */
  async *[Symbol.asyncIterator](): AsyncGenerator<Doc<T>> {
    for (const [k, v] of await (await this.db.driver()).list(this.name)) yield this.doc(k, v);
  }
}

/** Пользователь Telegram, которого бот сохраняет автоматически. Дополните своими полями через UserData. */
export interface UserRecord {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  /** Когда впервые написал боту (ms). */
  firstSeen: number;
  /** Последняя активность (ms, с точностью до минуты). */
  lastSeen: number;
  /** Пользователь заблокировал бота (выставляется при рассылке). */
  blocked?: boolean;
}

/**
 * Ваши поля пользователя. Дополните для подсказок в редакторе:
 * ```ts
 * declare module 'wyscra-tg' { interface UserData { balance: number } }
 * ```
 */
export interface UserData {
  [key: string]: any;
}

/**
 * База данных бота. Подключение задаётся одной строкой: `new Bot({ db: 'bot.db' })`.
 * Встроенные коллекции: `users` (заполняется сама), `chats`, плюс любые свои через `collection(name)`.
 */
export class Database {
  private driverPromise?: Promise<Driver>;
  private readonly collections = new Map<string, Collection<any>>();
  /** Пользователи бота (сохраняются автоматически). */
  readonly users: Collection<UserRecord & UserData>;
  /** Чаты/группы, где есть бот (заполняются автоматически). */
  readonly chats: Collection<{ id: number; type: string; title?: string; username?: string; left?: boolean }>;

  constructor(readonly url?: string | Driver) {
    this.users = this.collection('users');
    this.chats = this.collection('chats');
  }

  private readonly locks = new Map<string, Promise<unknown>>();

  /** @internal Runs `fn` after previous holders of the same key (in-process mutex). */
  withLock<R>(key: string, fn: () => Promise<R>): Promise<R> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }

  /** @internal Driver once connected (lets hot paths skip an await). */
  resolved?: Driver;

  /** @internal */
  driver(): Promise<Driver> {
    return (this.driverPromise ??= (typeof this.url === 'object' ? Promise.resolve(this.url) : connectDriver(this.url)).then((d) => (this.resolved = d)));
  }

  /** Подключается сразу (иначе — при первом обращении). */
  async connect(): Promise<this> {
    await this.driver();
    return this;
  }

  /** Тип хранилища: memory, sqlite, json, postgres, mysql, mongodb, redis. */
  async kind(): Promise<string> {
    return (await this.driver()).name;
  }

  /** Коллекция по имени (создаётся сама). */
  collection<T extends object = Record<string, any>>(name: string): Collection<T> {
    let c = this.collections.get(name);
    if (!c) this.collections.set(name, (c = new Collection<T>(this, name)));
    return c as Collection<T>;
  }

  /** Исходное подключение драйвера для своих запросов (pg Pool, mysql2, MongoClient, Redis, node:sqlite). */
  async raw<T = any>(): Promise<T> {
    return (await this.driver()).raw as T;
  }

  async close(): Promise<void> {
    if (this.driverPromise) await (await this.driverPromise).close();
  }
}
