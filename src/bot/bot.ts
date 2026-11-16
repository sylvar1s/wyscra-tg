import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { printBanner, printStatus } from '../banner.js';
import { Api, type ApiOptions } from './api.js';
import { Composer, compose, type Middleware } from './composer.js';
import { Context, conversationKey, MESSAGE_UPDATES, toFile as toInputFile, type ContextHost, type FileArg, type Text, type WaitOptions } from './context.js';
import { HttpError, TelegramError } from './errors.js';
import {
  UPDATE_TYPES,
  type Message,
  type SendAudioParams,
  type SendDocumentParams,
  type SendMessageParams,
  type SendPhotoParams,
  type SendVideoParams,
  type SendVoiceParams,
  type Update,
  type UpdateType,
  type User,
} from './generated/types.js';
import { Database, type UserData, type UserRecord } from '../db/database.js';
import type { Driver } from '../db/drivers.js';
import { ButtonRegistry, normalize, type Friendly } from './friendly.js';
import { Scene, scenes, type SceneOptions } from './scenes.js';
import { I18n, type I18nOptions } from './i18n.js';
import { Scheduler, type Job } from './schedule.js';
import { parseDuration } from './duration.js';
import { InputFile } from './input-file.js';
import type { PreCheckoutQuery, SuccessfulPayment } from './generated/types.js';
import type { SessionOptions } from './session.js';

let envLoaded = false;
/** Loads .env from the current directory once (Node 20.12+), without overriding existing variables. */
function loadEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  try {
    process.loadEnvFile?.('.env');
  } catch {}
}



export interface BotOptions extends ApiOptions {
  /** Токен бота. Если не указан — берётся из BOT_TOKEN (файл .env подхватывается сам). */
  token?: string;
  /**
   * База данных одной строкой:
   * 'bot.db' (SQLite, встроен), 'data.json', 'postgres://...', 'mysql://...', 'mongodb://...', 'redis://...'.
   * По умолчанию — в памяти (данные пропадают при перезапуске). Можно передать готовый Database или свой Driver.
   */
  db?: string | Driver | Database;
  /** Встроенные сессии `ctx.session` (хранятся в db). Default: true. */
  session?: boolean | Omit<SessionOptions<any>, 'store'>;
  /** Сохранять пользователей в `db.users` и давать `ctx.user`. Default: true. */
  trackUsers?: boolean;
  /**
   * Переводы для `ctx.t(...)`: `{ locales: './locales' }` (папка с ru.json, en.json)
   * или `{ locales: { ru: {...}, en: {...} }, defaultLocale: 'ru' }`.
   */
  i18n?: I18nOptions | I18n;
  /**
   * Антиспам: не больше `limit` сообщений от одного пользователя за `per`. Лишние игнорируются.
   * `antiFlood: { limit: 5, per: '10s', message: 'Не так быстро!' }` или просто `antiFlood: true` (5 за 5 секунд).
   */
  antiFlood?: boolean | { limit?: number; per?: number | string; message?: string };
  /** Skip the getMe call on start by providing the bot info yourself. */
  botInfo?: User;
  /** Answer callback queries automatically if a handler didn't (removes the loading spinner). Default: true. */
  autoAnswerCallbacks?: boolean;
  /** Custom Context subclass. */
  ContextClass?: new (update: Update, host: ContextHost, type: UpdateType) => Context;
}

export interface PollingOptions {
  /** Long-poll timeout in seconds. Default: 30. */
  timeout?: number;
  /** Updates per request (1-100). Default: 100. */
  limit?: number;
  /** Update types to receive. Default: all of them (including chat_member and reactions). */
  allowedUpdates?: readonly UpdateType[];
  /** Skip updates that arrived while the bot was offline. */
  dropPendingUpdates?: boolean;
  /** Maximum updates processed at once (across chats; one chat is always sequential). Default: 500. */
  concurrency?: number;
  /** Stop gracefully on SIGINT/SIGTERM. Default: true. */
  handleSignals?: boolean;
}

export interface WebhookOptions {
  /** Expected secret token (X-Telegram-Bot-Api-Secret-Token header). */
  secretToken?: string;
  /** Wait for handlers before responding (needed on serverless platforms). Default: false. */
  waitForHandlers?: boolean;
}

export interface StartWebhookOptions extends WebhookOptions {
  /** Public HTTPS URL Telegram should call, e.g. `https://example.com/bot`. */
  url: string;
  /** Local port to listen on. Default: process.env.PORT or 3000. */
  port?: number;
  host?: string;
  allowedUpdates?: readonly UpdateType[];
  dropPendingUpdates?: boolean;
  maxConnections?: number;
  ipAddress?: string;
  handleSignals?: boolean;
}

type ErrorHandler<C> = (error: unknown, ctx: C) => unknown;

interface Waiter {
  resolve: (ctx: Context) => void;
  filter?: (ctx: Context) => boolean;
  timer: NodeJS.Timeout;
}

const defaultWaitFilter = (ctx: Context) =>
  ctx.updateType === 'callback_query' ||
  ((MESSAGE_UPDATES as readonly string[]).includes(ctx.updateType) && !ctx.updateType.startsWith('edited') && !ctx.command);

/**
 * A Telegram bot.
 * ```ts
 * const bot = new Bot(process.env.BOT_TOKEN!);
 * bot.start(ctx => ctx.reply('Hi!'));
 * bot.on('text', ctx => ctx.reply(ctx.text));
 * bot.start();
 * ```
 */
export class Bot<C extends Context = Context> extends Composer<C> implements ContextHost {
  readonly api: Api;
  private info?: User;
  private initPromise?: Promise<void>;
  private errorHandler: ErrorHandler<C> = (err, ctx) => {
    console.error(`[wyscra-tg] Ошибка в обработчике (update ${ctx.update.update_id}, ${ctx.updateType}):`, err);
  };
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly queues = new Map<string | number, Promise<void>>();
  private inFlight = 0;
  private drained?: () => void;
  private polling?: AbortController;
  private pollLoop?: Promise<void>;
  private server?: Server;
  private readonly options: BotOptions;
  /** База данных бота (см. опцию `db`). */
  readonly db: Database;
  private readonly buttons = new ButtonRegistry();
  private readonly sceneRegistry: Scene<any>[] = [];
  private builtins?: Middleware<C>;
  private readonly knownChats = new Set<number>();

  /**
   * ```ts
   * new Bot()                                   // токен из .env (BOT_TOKEN=...)
   * new Bot('123:ABC')
   * new Bot({ token: '123:ABC', db: 'bot.db' })
   * ```
   */
  constructor(token?: string | BotOptions, options: BotOptions = {}) {
    super();
    if (typeof token === 'object') (options = token), (token = token.token);
    loadEnv();
    token ??= options.token ?? process.env.BOT_TOKEN;
    if (!token) throw new Error('Не найден токен бота. Передайте его: new Bot("123:ABC") или добавьте BOT_TOKEN=... в файл .env');
    this.options = options;
    this.api = new Api(token, { ...options, apiRoot: options.apiRoot ?? process.env.BOT_API_ROOT });
    this.info = options.botInfo;
    this.db = options.db instanceof Database ? options.db : new Database(options.db);
    this.i18n = options.i18n instanceof I18n ? options.i18n : options.i18n ? new I18n(options.i18n) : undefined;
  }

  /** @internal onClick-кнопки */
  registerButton(fn: (ctx: Context) => unknown): string {
    return this.buttons.register(fn);
  }

  // ---------- оплата ----------

  private readonly payments = new Map<string, (ctx: Context, payment: SuccessfulPayment) => unknown>();

  /** @internal */
  registerPayment(payload: string, fn: (ctx: Context, payment: SuccessfulPayment) => unknown): void {
    this.payments.set(payload, fn);
    if (this.payments.size > 50_000) this.payments.delete(this.payments.keys().next().value!);
  }

  /**
   * Обработчик всех успешных оплат (работает и после перезапуска).
   * ```ts
   * bot.onPayment(async (ctx, payment) => {
   *   ctx.user.premium = true;
   *   await ctx.reply(`Оплачено ${payment.total_amount} ⭐`);
   * });
   * ```
   */
  onPayment(handler: (ctx: C, payment: SuccessfulPayment) => unknown): this {
    return this.on('successful_payment', (ctx) => handler(ctx as unknown as C, ctx.msg.successful_payment));
  }

  /**
   * Проверка перед оплатой (например, товар ещё в наличии). Верните true — оплата разрешена,
   * строку — отказ с этим текстом. Без этого обработчика оплаты подтверждаются автоматически.
   */
  onPreCheckout(handler: (ctx: C, query: PreCheckoutQuery) => boolean | string | Promise<boolean | string>): this {
    return this.on('pre_checkout_query', async (ctx) => {
      const r = await handler(ctx as unknown as C, ctx.preCheckoutQuery);
      await ctx.answerPreCheckout(r === true, typeof r === 'string' ? r : r ? undefined : 'Оплата недоступна');
    });
  }

  // ---------- админы ----------

  private readonly adminCache = new Map<number, { at: number; ids: Promise<Set<number>> }>();

  /** @internal Админы чата (кэш на минуту). */
  admins(chatId: number): Promise<Set<number>> {
    const hit = this.adminCache.get(chatId);
    if (hit && Date.now() - hit.at < 60_000) return hit.ids;
    const ids = this.api.getChatAdministrators({ chat_id: chatId }).then((list) => new Set(list.map((m) => m.user.id)));
    ids.catch(() => this.adminCache.delete(chatId));
    this.adminCache.set(chatId, { at: Date.now(), ids });
    return ids;
  }

  /** Обработчики только для админов чата. */
  onlyAdmins(...handlers: Middleware<C>[]): this {
    return this.filter((ctx) => ctx.isAdmin(), ...handlers);
  }

  // ---------- переводы ----------

  /** Переводы (если задана опция i18n). */
  readonly i18n?: I18n;

  /** Перевод вне обработчика (например, в рассылке): `bot.t(user.language_code, 'news')`. */
  t(lang: string | undefined, key: string, vars?: Record<string, unknown>): string {
    if (!this.i18n) throw new Error("Подключите переводы: new Bot({ i18n: { locales: './locales' } })");
    return this.i18n.t(lang ?? this.i18n.defaultLocale, key, vars);
  }

  // ---------- расписание ----------

  private readonly scheduler = new Scheduler((e, name) => console.error(`[wyscra-tg] Ошибка в задаче по расписанию (${name}):`, e));

  /** Повторять каждые N: `bot.every('1h', () => ...)`. */
  every(interval: number | string, fn: () => unknown): Job {
    return this.scheduler.every(interval, fn);
  }
  /** Каждый день в указанное время сервера: `bot.daily('09:00', () => bot.broadcast('Доброе утро!'))`. */
  daily(time: string, fn: () => unknown): Job {
    return this.scheduler.daily(time, fn);
  }
  /** По cron: `bot.cron('0 9 * * 1-5', fn)` — в 9:00 по будням. */
  cron(expression: string, fn: () => unknown): Job {
    return this.scheduler.cron(expression, fn);
  }
  /** Один раз: через время или в момент — `bot.once('10m', fn)`, `bot.once(new Date('2026-12-31T23:59'), fn)`. */
  once(when: number | string | Date, fn: () => unknown): Job {
    return this.scheduler.once(when, fn);
  }

  // ---------- статистика и админ-панель ----------

  /** Статистика бота по базе пользователей. */
  async stats(): Promise<{ users: number; activeToday: number; activeWeek: number; newToday: number; newWeek: number; blocked: number; chats: number }> {
    const now = Date.now();
    const day = now - 86_400_000;
    const week = now - 7 * 86_400_000;
    const s = { users: 0, activeToday: 0, activeWeek: 0, newToday: 0, newWeek: 0, blocked: 0, chats: 0 };
    for (const u of await this.db.users.all()) {
      s.users++;
      if (u.blocked) s.blocked++;
      if ((u.lastSeen ?? 0) >= day) s.activeToday++;
      if ((u.lastSeen ?? 0) >= week) s.activeWeek++;
      if ((u.firstSeen ?? 0) >= day) s.newToday++;
      if ((u.firstSeen ?? 0) >= week) s.newWeek++;
    }
    s.chats = (await this.db.chats.find((c) => !c.left)).length;
    return s;
  }

  /**
   * Встроенная админ-панель по команде /admin: статистика, рассылка, пользователи, выгрузка в CSV.
   * ```ts
   * bot.admin({ ids: [123456789] });   // или ADMIN_ID=123,456 в .env
   * ```
   */
  admin(options: { ids?: number[]; command?: string } = {}): this {
    const ids = new Set(options.ids ?? (process.env.ADMIN_ID ?? '').split(/[\s,]+/).filter(Boolean).map(Number));
    if (!ids.size) throw new Error('bot.admin(): укажите ids: [ваш_id] или ADMIN_ID=... в .env');
    const isAdmin = (ctx: Context) => !!ctx.from && ids.has(ctx.from.id);
    const menu = (ctx: Context, edit = false): Promise<unknown> => {
      const inline = [
        [{ text: '📊 Статистика', onClick: (c: Context) => showStats(c) }],
        [{ text: '📢 Рассылка', onClick: (c: Context) => askBroadcast(c) }],
        [{ text: '👥 Пользователи', onClick: (c: Context) => showUsers(c) }],
        [{ text: '📤 Выгрузить CSV', onClick: (c: Context) => exportCsv(c) }],
      ];
      return edit ? ctx.editText('⚙️ Админ-панель', { inline }) : ctx.reply('⚙️ Админ-панель', { inline });
    };
    const back = { text: '« Назад', onClick: (c: Context) => menu(c, true) };
    const showStats = async (c: Context) => {
      const s = await this.stats();
      await c.editText(
        `📊 Статистика\n\nВсего пользователей: ${s.users}\nАктивны за сутки: ${s.activeToday}\nАктивны за неделю: ${s.activeWeek}\nНовых за сутки: ${s.newToday}\nНовых за неделю: ${s.newWeek}\nЗаблокировали бота: ${s.blocked}\nГрупп и каналов: ${s.chats}`,
        { inline: [[{ text: '🔄 Обновить', onClick: showStats }], [back]] },
      );
    };
    const askBroadcast = async (c: Context) => {
      await c.answer();
      const msg = await c.ask('Отправьте текст рассылки (или /cancel):', { timeout: 10 * 60_000 }).catch(() => undefined);
      if (!msg?.text || msg.text.startsWith('/')) return c.reply('Рассылка отменена');
      const text = msg.text;
      const total = (await this.db.users.find((u) => !u.blocked)).length;
      await c.reply(`Отправить это сообщение ${total} пользователям?\n\n${text}`, {
        inline: [
          {
            text: '✅ Отправить',
            onClick: async (cc) => {
              await cc.editText('⏳ Рассылка идёт…');
              let lastEdit = Date.now();
              const r = await this.broadcast(text, {
                onProgress: (done, all) => {
                  if (Date.now() - lastEdit > 3000) {
                    lastEdit = Date.now();
                    void cc.editText(`⏳ Рассылка: ${done} из ${all}`).catch(() => {});
                  }
                },
              });
              await cc.editText(`✅ Рассылка завершена\nДоставлено: ${r.sent}\nЗаблокировали бота: ${r.blocked}\nОшибок: ${r.failed}`);
            },
          },
          { text: '❌ Отмена', onClick: (cc) => cc.editText('Рассылка отменена') },
        ],
      });
    };
    const showUsers = async (c: Context) => {
      await c.answer();
      const users = (await this.db.users.all()).sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
      await c.paginate(users, {
        title: (p, n) => `👥 Пользователи (${users.length}), стр. ${p}/${n}`,
        format: (u, i) => `${i + 1}. ${u.first_name}${u.username ? ' @' + u.username : ''} — ${u.id}${u.blocked ? ' 🚫' : ''}`,
        empty: 'Пользователей пока нет',
      });
    };
    const exportCsv = async (c: Context) => {
      await c.answer('Готовлю файл…');
      const users = await this.db.users.all();
      const cols = ['id', 'first_name', 'last_name', 'username', 'language_code', 'firstSeen', 'lastSeen', 'blocked'];
      const esc = (v: unknown) => (v === undefined || v === null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      const csv = [cols.join(','), ...users.map((u: any) => cols.map((k) => esc(k.endsWith('Seen') && u[k] ? new Date(u[k]).toISOString() : u[k])).join(','))].join('\n');
      await c.replyWithDocument(new InputFile(Buffer.from('﻿' + csv), `users_${new Date().toISOString().slice(0, 10)}.csv`), { caption: `Пользователей: ${users.length}` });
    };
    this.command(options.command ?? 'admin', (ctx, next) => (isAdmin(ctx) ? menu(ctx) : next()));
    return this;
  }

  /**
   * Создаёт сцену (многошаговый диалог), которая сразу подключена к боту.
   * ```ts
   * bot.scene('order')
   *   .step(ctx => ctx.reply('Что заказать?'))
   *   .step(ctx => ctx.reply(`Принято: ${ctx.text}`));
   * bot.command('order', ctx => ctx.scene.enter('order'));
   * ```
   */
  scene(id: string, options?: SceneOptions): Scene<C> {
    const s = new Scene<C>(id, options);
    this.sceneRegistry.push(s);
    this.builtins = undefined;
    return s;
  }

  private builtinMiddleware(): Middleware<C> {
    if (this.builtins) return this.builtins;
    const list: Middleware<C>[] = [];
    if (this.options.antiFlood) list.push(this.antiFloodMw());
    // ctx.user and ctx.session must be ready before onClick handlers and scenes run.
    if (this.options.trackUsers ?? true) list.push((ctx, next) => this.trackUser(ctx, next));
    if (this.options.session ?? true) list.push((ctx, next) => this.sessionMw(ctx, next));
    // invoice({ onPaid })
    list.push(async (ctx, next) => {
      const payment = ctx.msg?.successful_payment;
      const fn = payment && this.payments.get(payment.invoice_payload);
      if (fn) {
        this.payments.delete(payment.invoice_payload);
        await fn(ctx, payment);
      }
      return next();
    });
    // onClick buttons
    list.push(async (ctx, next) => {
      const fn = this.buttons.lookup(ctx.update.callback_query?.data);
      if (!fn) return next();
      if (fn === 'expired') {
        ctx._answered = true;
        await ctx.answer('Кнопка устарела — отправьте команду ещё раз', { show_alert: true }).catch(() => {});
        return;
      }
      await fn(ctx);
    });
    if (this.sceneRegistry.length) list.push(scenes(...this.sceneRegistry) as Middleware<C>);
    return (this.builtins = compose(list));
  }

  /**
   * Binds a DB record to `ctx[prop]`. With sync drivers (memory/JSON/SQLite) it is loaded only when the
   * handler touches it; it is saved after the handlers only if it changed.
   */
  private async bindRecord(
    ctx: C,
    prop: 'user' | 'session',
    coll: string,
    key: string,
    prepare: (stored: any) => any,
    eager: boolean,
    next: () => Promise<void>,
  ): Promise<void> {
    const d = this.db.resolved ?? (await this.db.driver());
    let loaded = false;
    let value: any;
    let json: string | undefined;
    const take = (stored: any) => {
      json = stored === undefined ? undefined : JSON.stringify(stored);
      value = prepare(stored);
      loaded = true;
    };
    if (eager || !d.getSync) {
      take(await d.get(coll, key));
      // New users are saved right away, so stats/broadcasts see them during their first update too.
      if (prop === 'user' && json === undefined) {
        await d.set(coll, key, value);
        json = JSON.stringify(value);
      }
    }
    (ctx._slots ??= {})[prop] = {
      get: () => {
        if (!loaded) take(d.getSync!(coll, key));
        return value;
      },
      set: (v) => {
        if (!loaded) take(d.getSync!(coll, key));
        value = v;
      },
    };
    try {
      await next();
    } finally {
      if (loaded) {
        if (value === null || value === undefined) {
          if (json !== undefined) await d.delete(coll, key);
        } else {
          const after = JSON.stringify(value);
          if (after !== json) await d.set(coll, key, value);
        }
      }
    }
  }

  private antiFloodMw(): Middleware<C> {
    const o = typeof this.options.antiFlood === 'object' ? this.options.antiFlood : {};
    const limit = o.limit ?? 5;
    const per = parseDuration(o.per ?? '5s') * 1000;
    const hits = new Map<number, { start: number; count: number; warned: boolean }>();
    return async (ctx, next) => {
      const id = ctx.from?.id;
      const counted = ctx.updateType === 'message' || ctx.updateType === 'callback_query' || ctx.updateType === 'business_message';
      if (id === undefined || !counted) return next();
      const now = Date.now();
      let h = hits.get(id);
      if (!h || now - h.start >= per) {
        if (hits.size > 100_000) for (const [k, v] of hits) if (now - v.start >= per) hits.delete(k);
        hits.set(id, (h = { start: now, count: 0, warned: false }));
      }
      if (++h.count <= limit) return next();
      if (!h.warned && o.message) {
        h.warned = true;
        if (ctx.updateType === 'callback_query') await ctx.answer(o.message).catch(() => {});
        else await ctx.reply(o.message).catch(() => {});
      }
    };
  }

  /** Last profile signature written per user: lets us skip DB writes for active users. */
  private readonly seen = new Map<number, { sig: string; at: number }>();

  private async trackUser(ctx: C, next: () => Promise<void>): Promise<void> {
    const chat = ctx.chat;
    if (chat && chat.type !== 'private' && !this.knownChats.has(chat.id)) {
      this.knownChats.add(chat.id);
      await this.db.chats.update(chat.id, { type: chat.type, title: chat.title, username: chat.username, left: false }).catch(() => {});
    }
    const mcm = ctx.update.my_chat_member;
    if (mcm && mcm.chat.type !== 'private' && ['left', 'kicked'].includes(mcm.new_chat_member.status)) {
      this.knownChats.delete(mcm.chat.id);
      await this.db.chats.update(mcm.chat.id, { left: true }).catch(() => {});
    }
    const from = ctx.from;
    if (!from || from.is_bot) return next();
    const now = Date.now();
    const sig = `${from.first_name}\u0001${from.last_name ?? ''}\u0001${from.username ?? ''}\u0001${from.language_code ?? ''}\u0001${from.is_premium ? 1 : 0}`;
    const mem = this.seen.get(from.id);
    const privateMcm = mcm?.chat.type === 'private';
    const refresh = !mem || mem.sig !== sig || now - mem.at > 60_000 || privateMcm;
    if (refresh) {
      this.seen.delete(from.id);
      this.seen.set(from.id, { sig, at: now });
      if (this.seen.size > 100_000) this.seen.delete(this.seen.keys().next().value!);
    }
    const prepare = (stored: any) => {
      const u: Record<string, any> = stored ? { ...stored } : {};
      u.id = from.id;
      u.firstSeen ??= now;
      if (refresh || !stored) {
        u.first_name = from.first_name;
        for (const k of ['last_name', 'username', 'language_code', 'is_premium'] as const) {
          if (from[k] === undefined) delete u[k];
          else u[k] = from[k];
        }
        u.lastSeen = now;
        if (u.blocked) u.blocked = false; // the user is talking to the bot again
        if (privateMcm) u.blocked = mcm!.new_chat_member.status === 'kicked';
      }
      return u;
    };
    return this.bindRecord(ctx, 'user', 'users', String(from.id), prepare, refresh, next);
  }

  private sessionMw(ctx: C, next: () => Promise<void>): Promise<void> {
    const o = typeof this.options.session === 'object' ? this.options.session : {};
    const key = o.getKey ? o.getKey(ctx) : (ctx.chatId ?? ctx.from?.id) !== undefined ? conversationKey(ctx) : undefined;
    if (key === undefined) return next();
    const initial = o.initial ?? (() => ({}));
    return this.bindRecord(ctx, 'session', 'sessions', key, (stored) => stored ?? initial(), false, next);
  }

  // ---------- отправка без ctx ----------

  private sendTo<R>(method: string, chatId: number | string, params: Record<string, unknown>, extra?: object): Promise<R> {
    const ex = normalize(extra as Friendly | undefined, (fn) => this.registerButton(fn));
    return this.api.call(method as 'sendMessage', { chat_id: chatId, ...params, ...ex } as never) as Promise<R>;
  }
  /** Отправить сообщение в любой чат: `bot.send(userId, 'Привет', { inline: ['Ок'] })`. */
  send(chatId: number | string, text: Text, extra?: Omit<SendMessageParams, 'chat_id' | 'text'> & Friendly): Promise<Message> {
    return this.sendTo('sendMessage', chatId, { text }, extra);
  }
  sendPhoto(chatId: number | string, photo: FileArg, extra?: Omit<SendPhotoParams, 'chat_id' | 'photo'> & Friendly): Promise<Message> {
    return this.sendTo('sendPhoto', chatId, { photo: toInputFile(photo) }, extra);
  }
  sendVideo(chatId: number | string, video: FileArg, extra?: Omit<SendVideoParams, 'chat_id' | 'video'> & Friendly): Promise<Message> {
    return this.sendTo('sendVideo', chatId, { video: toInputFile(video) }, extra);
  }
  sendDocument(chatId: number | string, document: FileArg, extra?: Omit<SendDocumentParams, 'chat_id' | 'document'> & Friendly): Promise<Message> {
    return this.sendTo('sendDocument', chatId, { document: toInputFile(document) }, extra);
  }
  sendAudio(chatId: number | string, audio: FileArg, extra?: Omit<SendAudioParams, 'chat_id' | 'audio'> & Friendly): Promise<Message> {
    return this.sendTo('sendAudio', chatId, { audio: toInputFile(audio) }, extra);
  }
  sendVoice(chatId: number | string, voice: FileArg, extra?: Omit<SendVoiceParams, 'chat_id' | 'voice'> & Friendly): Promise<Message> {
    return this.sendTo('sendVoice', chatId, { voice: toInputFile(voice) }, extra);
  }

  /**
   * Рассылка всем пользователям бота (из `db.users`), с учётом лимитов Telegram.
   * Тех, кто заблокировал бота, помечает `blocked: true` и пропускает в следующий раз.
   * ```ts
   * const r = await bot.broadcast('Новая акция!', { inline: [{ text: 'Подробнее', url: 'https://...' }] });
   * console.log(r); // { total, sent, blocked, failed }
   * await bot.broadcast(user => `Привет, ${user.first_name}!`, { filter: { language_code: 'ru' } });
   * ```
   */
  async broadcast(
    message: Text | ((user: UserRecord & UserData) => Text | undefined),
    options: Omit<SendMessageParams, 'chat_id' | 'text'> &
      Friendly & {
        filter?: Partial<UserRecord & UserData> | ((user: UserRecord & UserData) => unknown);
        onProgress?: (done: number, total: number) => void;
      } = {},
  ): Promise<{ total: number; sent: number; blocked: number; failed: number }> {
    const { filter, onProgress, ...extra } = options;
    const users = (await this.db.users.find(typeof filter === 'function' ? (u) => !u.blocked && filter(u) : { ...filter } as never)).filter((u) => !u.blocked);
    const stats = { total: users.length, sent: 0, blocked: 0, failed: 0 };
    let done = 0;
    let i = 0;
    const worker = async () => {
      while (i < users.length) {
        const u = users[i++];
        const text = typeof message === 'function' ? message(u) : message;
        try {
          if (text !== undefined) {
            await this.send(u.id, text, extra);
            stats.sent++;
          }
        } catch (e) {
          if (e instanceof TelegramError && (e.code === 403 || /chat not found/i.test(e.description))) {
            stats.blocked++;
            await this.db.users.update(u.id, { blocked: true } as never).catch(() => {});
          } else stats.failed++;
        }
        onProgress?.(++done, users.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(30, users.length) }, worker));
    return stats;
  }

  /** The bot's user info. Available after `init()` / `start()`. */
  get me(): User {
    if (!this.info) throw new Error('Бот ещё не запущен: вызовите await bot.init() или bot.start()');
    return this.info;
  }

  private async printDb(): Promise<void> {
    const kind = await this.db.kind();
    printStatus(kind === 'memory' ? 'База данных: в памяти (данные пропадут при перезапуске; чтобы сохранять — new Bot({ db: "bot.db" }))' : `База данных: ${kind}`);
  }

  /** Calls getMe (once). Called automatically by start/startWebhook/handleUpdate. */
  init(): Promise<void> {
    return (this.initPromise ??= (async () => {
      this.info ??= await this.api.getMe();
    })().catch((e) => {
      this.initPromise = undefined;
      throw e;
    }));
  }

  /** Sets the error handler for errors thrown by middleware. */
  catch(handler: ErrorHandler<C>): this {
    this.errorHandler = handler;
    return this;
  }

  /** Handler shortcut overload: `bot.start(ctx => ...)` registers /start; `bot.start()` launches polling. */
  override start(...handlers: Parameters<Composer<C>['start']>): this;
  override start(options?: PollingOptions): Promise<void> & this;
  override start(...args: unknown[]): any {
    if (typeof args[0] === 'function') return super.start(...(args as Parameters<Composer<C>['start']>));
    return this.launch(args[0] as PollingOptions | undefined);
  }

  /** Starts long polling. Resolves once the bot is up. */
  async launch(options: PollingOptions = {}): Promise<void> {
    if (this.polling) throw new Error('Бот уже запущен');
    printBanner();
    await this.init();
    await this.api.deleteWebhook({ drop_pending_updates: options.dropPendingUpdates ?? false });
    await this.syncCommands();
    const controller = (this.polling = new AbortController());
    if (options.handleSignals ?? true) this.handleSignals();
    this.pollLoop = this.poll(controller.signal, options);
    printStatus(`Бот @${this.me.username} запущен (long polling)`);
    await this.printDb();
  }

  private async poll(signal: AbortSignal, o: PollingOptions): Promise<void> {
    const allowed = o.allowedUpdates ?? UPDATE_TYPES;
    const concurrency = o.concurrency ?? 500;
    let offset = 0;
    let backoff = 0;
    while (!signal.aborted) {
      if (this.inFlight >= concurrency) {
        await new Promise<void>((r) => (this.drained = r));
        continue;
      }
      try {
        const updates = await this.api.getUpdates(
          { offset, limit: o.limit ?? 100, timeout: o.timeout ?? 30, allowed_updates: allowed as UpdateType[] },
          { signal },
        );
        backoff = 0;
        for (const u of updates) {
          offset = u.update_id + 1;
          this.enqueue(u);
        }
      } catch (err) {
        if (signal.aborted) break;
        if (err instanceof TelegramError && (err.code === 401 || err.code === 409)) {
          console.error(
            `[wyscra-tg] ${err.code === 401 ? 'Неверный токен бота' : 'Этот бот уже запущен в другом месте (конфликт getUpdates)'}: ${err.description}`,
          );
          process.exitCode = 1;
          this.polling = undefined;
          return;
        }
        backoff = Math.min(backoff ? backoff * 2 : 1000, 30_000);
        if (!(err instanceof HttpError)) console.error('[wyscra-tg] Ошибка получения апдейтов, повторяю:', err);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    // Confirm the last offset so processed updates are not delivered again after restart.
    if (offset) await this.api.getUpdates({ offset, limit: 1, timeout: 0 }).catch(() => {});
  }

  /** Stops polling / webhook server and waits for running handlers to finish. */
  async stop(): Promise<void> {
    const polling = this.polling;
    this.polling = undefined;
    polling?.abort();
    this.drained?.();
    await this.pollLoop;
    if (this.server) await new Promise((r) => this.server!.close(r));
    this.server = undefined;
    this.scheduler.stopAll();
    await Promise.all(this.queues.values());
    await this.db.close().catch(() => {});
  }

  private signalsBound = false;
  private handleSignals() {
    if (this.signalsBound) return;
    this.signalsBound = true;
    const stop = () => void this.stop().then(() => process.exit());
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }

  /** Publishes commands registered with descriptions to Telegram's command menu. */
  async syncCommands(): Promise<void> {
    if (!this.commandList.length) return;
    const seen = new Set<string>();
    const commands = this.commandList.filter((c) => !seen.has(c.command) && seen.add(c.command));
    await this.api.setMyCommands({ commands }).catch((e) => console.warn('[wyscra-tg] setMyCommands failed:', e.message));
  }

  /** Queues an update: different chats run in parallel, one chat runs in order. */
  private enqueue(update: Update): Promise<void> {
    const ctx = this.createContext(update);
    if (!ctx) return Promise.resolve();
    if (this.resolveWaiter(ctx)) return Promise.resolve();
    const key = ctx.chatId ?? ctx.from?.id ?? update.update_id;
    const prev = this.queues.get(key);
    this.inFlight++;
    const run = (prev ?? Promise.resolve()).then(() => this.run(ctx)).finally(() => {
      this.inFlight--;
      if (this.queues.get(key) === run) this.queues.delete(key);
      const d = this.drained;
      this.drained = undefined;
      d?.();
    });
    this.queues.set(key, run);
    return run;
  }

  private createContext(update: Update): C | undefined {
    let type: UpdateType | undefined;
    for (const k in update) if (k !== 'update_id') { type = k as UpdateType; break; }
    if (!type) return undefined;
    const Ctor = this.options.ContextClass ?? Context;
    return new Ctor(update, this, type) as C;
  }

  private async run(ctx: C): Promise<void> {
    try {
      const user = this.middleware();
      await this.builtinMiddleware()(ctx, () => user(ctx, async () => {}) as Promise<void>);
    } catch (err) {
      try {
        await this.errorHandler(err, ctx);
      } catch (e) {
        console.error('[wyscra-tg] Error in error handler:', e);
      }
    }
    if (ctx.updateType === 'pre_checkout_query' && !ctx._answered) {
      // Telegram cancels the payment if the bot doesn't answer within 10 s; approve unless onPreCheckout decided otherwise.
      await this.api.answerPreCheckoutQuery({ pre_checkout_query_id: ctx.update.pre_checkout_query!.id, ok: true }).catch(() => {});
    }
    if (ctx.updateType === 'callback_query' && !ctx._answered && (this.options.autoAnswerCallbacks ?? true)) {
      await this.api.answerCallbackQuery({ callback_query_id: ctx.update.callback_query!.id }).catch(() => {});
    }
  }

  /** Processes one update (e.g. from your own webhook server). */
  async handleUpdate(update: Update): Promise<void> {
    await this.init();
    await this.enqueue(update);
  }

  // ---------- conversations ----------

  /** @internal Used by ctx.ask / ctx.waitForReply. */
  waitFor(key: string, options: WaitOptions = {}): Promise<Context> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(key);
        if (list) {
          const i = list.indexOf(waiter);
          if (i >= 0) list.splice(i, 1);
          if (!list.length) this.waiters.delete(key);
        }
        reject(new Error('Timed out waiting for reply'));
      }, options.timeout ?? 5 * 60_000);
      const waiter: Waiter = { resolve, filter: options.filter, timer };
      const list = this.waiters.get(key);
      if (list) list.push(waiter);
      else this.waiters.set(key, [waiter]);
    });
  }

  private resolveWaiter(ctx: Context): boolean {
    if (!this.waiters.size) return false;
    const key = conversationKey(ctx);
    const list = this.waiters.get(key);
    if (!list) return false;
    const i = list.findIndex((w) => (w.filter ?? defaultWaitFilter)(ctx));
    if (i < 0) return false;
    const [w] = list.splice(i, 1);
    if (!list.length) this.waiters.delete(key);
    clearTimeout(w.timer);
    w.resolve(ctx);
    if (ctx.updateType === 'callback_query' && (this.options.autoAnswerCallbacks ?? true)) {
      // Give the waiting code a moment to answer itself, then clear the spinner.
      setTimeout(() => {
        if (!ctx._answered) this.api.answerCallbackQuery({ callback_query_id: ctx.update.callback_query!.id }).catch(() => {});
      }, 1000).unref();
    }
    return true;
  }

  // ---------- webhooks ----------

  /**
   * Node.js request handler for webhooks. Works with `http.createServer`, Express, Fastify (`.raw`), etc.
   * ```ts
   * app.post('/bot', bot.webhookCallback({ secretToken: 'abc' }));
   * ```
   */
  webhookCallback(options: WebhookOptions = {}): (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => Promise<void> {
    const secret = options.secretToken ? Buffer.from(options.secretToken) : undefined;
    return async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      if (secret) {
        const got = Buffer.from(String(req.headers['x-telegram-bot-api-secret-token'] ?? ''));
        if (got.length !== secret.length || !timingSafeEqual(got, secret)) {
          res.writeHead(401).end();
          return;
        }
      }
      let update: Update;
      try {
        if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) update = req.body as Update;
        else {
          let raw = '';
          if (req.body !== undefined) raw = String(req.body);
          else for await (const chunk of req) raw += chunk;
          update = JSON.parse(raw);
        }
      } catch {
        res.writeHead(400).end();
        return;
      }
      await this.init();
      if (options.waitForHandlers) {
        await this.enqueue(update);
        res.writeHead(200).end();
      } else {
        res.writeHead(200).end();
        void this.enqueue(update);
      }
    };
  }

  /**
   * Webhook handler on standard Request/Response: Bun, Deno, Cloudflare Workers, Vercel/Next.js route handlers.
   * Waits for handlers to finish before responding (required on serverless platforms).
   * ```ts
   * export const POST = bot.fetchHandler({ secretToken: process.env.SECRET });
   * Bun.serve({ fetch: bot.fetchHandler() });
   * ```
   */
  fetchHandler(options: Omit<WebhookOptions, 'waitForHandlers'> = {}): (req: Request) => Promise<Response> {
    const secret = options.secretToken;
    return async (req) => {
      if (req.method !== 'POST') return new Response(null, { status: 405 });
      if (secret) {
        const got = Buffer.from(req.headers.get('x-telegram-bot-api-secret-token') ?? '');
        const want = Buffer.from(secret);
        if (got.length !== want.length || !timingSafeEqual(got, want)) return new Response(null, { status: 401 });
      }
      let update: Update;
      try {
        update = (await req.json()) as Update;
      } catch {
        return new Response(null, { status: 400 });
      }
      await this.init();
      await this.enqueue(update);
      return new Response(null, { status: 200 });
    };
  }

  /** Starts a built-in HTTP server and registers the webhook with Telegram. Put HTTPS (nginx, Caddy, a tunnel) in front of it. */
  async startWebhook(options: StartWebhookOptions): Promise<void> {
    printBanner();
    await this.init();
    await this.syncCommands();
    const secretToken = options.secretToken ?? randomBytes(32).toString('hex');
    const path = new URL(options.url).pathname;
    const handler = this.webhookCallback({ ...options, secretToken });
    const port = options.port ?? Number(process.env.PORT ?? 3000);
    this.server = createServer((req, res) => {
      if ((req.url ?? '/').split('?')[0] !== path) {
        res.writeHead(404).end();
        return;
      }
      handler(req, res).catch(() => res.writeHead(500).end());
    });
    await new Promise<void>((resolve) => this.server!.listen(port, options.host, resolve));
    await this.api.setWebhook({
      url: options.url,
      secret_token: secretToken,
      allowed_updates: (options.allowedUpdates ?? UPDATE_TYPES) as UpdateType[],
      drop_pending_updates: options.dropPendingUpdates,
      max_connections: options.maxConnections,
      ip_address: options.ipAddress,
    });
    if (options.handleSignals ?? true) this.handleSignals();
    printStatus(`Бот @${this.me.username} запущен (вебхук ${options.url}, порт ${port})`);
    await this.printDb();
  }
}

export type { Middleware };
