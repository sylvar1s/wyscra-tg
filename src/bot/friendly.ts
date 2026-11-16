import type { Context } from './context.js';
import type { InlineKeyboardButton, InlineQueryResult, KeyboardButton } from './generated/types.js';
import { InlineKeyboard, Keyboard } from './keyboard.js';

/**
 * Инлайн-кнопка (под сообщением):
 * - `'Текст'` — кнопка, которая присылает боту свой текст (ловится `bot.action('Текст', ...)`)
 * - `{ text: 'Да', onClick: ctx => ... }` — что делать при нажатии, сразу здесь
 * - `{ text: 'Купить', data: 'buy:42' }` — своё значение для `bot.action`
 * - `{ text: 'Сайт', url: 'https://...' }` — ссылка
 * - `{ text: 'Открыть', webApp: 'https://...' }` — мини-приложение
 * - `{ text: 'Скопировать', copy: 'промокод' }` — копирует текст
 * - `{ text: 'Поделиться', share: 'текст' }` — выбрать чат и отправить inline-запрос
 */
export interface InlineButton {
  text: string;
  onClick?: (ctx: Context) => unknown;
  data?: string;
  url?: string;
  webApp?: string;
  copy?: string;
  share?: string;
  /** inline-запрос в текущем чате */
  inlineHere?: string;
  login?: string;
  pay?: boolean;
  /** Цвет кнопки: 'primary' | 'success' | 'danger' (Bot API 9.4+) */
  style?: string;
}

/**
 * Обычная кнопка (вместо клавиатуры телефона):
 * - `'Текст'` — отправляет этот текст (ловится `bot.hears('Текст', ...)`)
 * - `{ text: '📱 Телефон', contact: true }`, `{ text: '📍', location: true }`
 * - `{ text: 'Опрос', poll: true | 'quiz' }`, `{ text: 'Открыть', webApp: 'https://...' }`
 */
export interface ReplyButton {
  text: string;
  contact?: boolean;
  location?: boolean;
  poll?: boolean | 'quiz' | 'regular';
  webApp?: string;
  style?: string;
}

type Rows<B> = Array<B | string> | Array<Array<B | string>>;

/** Удобные опции отправки. Работают в ctx.reply, ctx.replyWith*, ctx.editText, bot.send и т.д. */
export interface Friendly {
  /**
   * Кнопки под сообщением.
   * `['А', 'Б']` — один ряд; `[['А', 'Б'], ['В']]` — несколько рядов.
   */
  inline?: Rows<InlineButton | InlineKeyboardButton>;
  /**
   * Клавиатура вместо обычной (под полем ввода).
   * `['Меню', 'Помощь']` — один ряд; `[['Каталог', 'Корзина'], ['Помощь']]` — несколько рядов.
   */
  keyboard?: Rows<ReplyButton | KeyboardButton>;
  /** Разбить плоский список кнопок на ряды по N штук. */
  columns?: number;
  /** Спрятать клавиатуру после нажатия. */
  oneTime?: boolean;
  /** Подсказка в поле ввода. */
  placeholder?: string;
  /** Убрать клавиатуру. */
  removeKeyboard?: boolean;
  /** Текст в HTML (`<b>жирный</b>`). */
  html?: boolean;
  /** Текст в MarkdownV2. */
  markdown?: boolean;
  /** Без звука уведомления. */
  silent?: boolean;
  /** Запретить пересылку и сохранение. */
  protect?: boolean;
  /** Не показывать превью ссылок. */
  noPreview?: boolean;
  /** Ответить на сообщение с этим id. */
  replyTo?: number;
}

const FRIENDLY_KEYS = ['inline', 'keyboard', 'columns', 'oneTime', 'placeholder', 'removeKeyboard', 'html', 'markdown', 'silent', 'protect', 'noPreview', 'replyTo'];

function toRows<T>(items: Rows<T>, columns?: number): Array<Array<T | string>> {
  if (!items.length) return [];
  if (items.some(Array.isArray)) return (items as unknown[]).map((r) => (Array.isArray(r) ? r : [r])) as Array<Array<T | string>>;
  const flat = items as Array<T | string>;
  if (!columns) return [flat];
  const rows: Array<Array<T | string>> = [];
  for (let i = 0; i < flat.length; i += columns) rows.push(flat.slice(i, i + columns));
  return rows;
}

function inlineButton(b: InlineButton | InlineKeyboardButton | string, register: (fn: (ctx: Context) => unknown) => string): InlineKeyboardButton {
  if (typeof b === 'string') return { text: b, callback_data: b };
  const f = b as InlineButton;
  const extra = f.style ? { style: f.style } : {};
  if (f.onClick) return { text: f.text, callback_data: register(f.onClick), ...extra };
  if (f.url) return { text: f.text, url: f.url, ...extra };
  if (f.webApp) return { text: f.text, web_app: { url: f.webApp }, ...extra };
  if (f.copy !== undefined) return { text: f.text, copy_text: { text: f.copy }, ...extra };
  if (f.share !== undefined) return { text: f.text, switch_inline_query: f.share, ...extra };
  if (f.inlineHere !== undefined) return { text: f.text, switch_inline_query_current_chat: f.inlineHere, ...extra };
  if (f.login) return { text: f.text, login_url: { url: f.login }, ...extra };
  if (f.pay) return { text: f.text, pay: true, ...extra };
  if (f.data !== undefined) return { text: f.text, callback_data: f.data, ...extra };
  const raw = b as InlineKeyboardButton;
  if (Object.keys(raw).length > 1) return raw; // already a Bot API button
  return { text: f.text, callback_data: f.text, ...extra };
}

function replyButton(b: ReplyButton | KeyboardButton | string): KeyboardButton {
  if (typeof b === 'string') return { text: b };
  const f = b as ReplyButton;
  const out: KeyboardButton = { text: f.text };
  if (f.style) out.style = f.style;
  if (f.contact) out.request_contact = true;
  else if (f.location) out.request_location = true;
  else if (f.poll) out.request_poll = f.poll === true ? {} : { type: f.poll };
  else if (f.webApp) out.web_app = { url: f.webApp };
  else return { ...(b as KeyboardButton) };
  return out;
}

/** Converts friendly options into Bot API params. Unknown keys pass through unchanged. */
export function normalize(
  extra: (Friendly & Record<string, any>) | undefined,
  register: (fn: (ctx: Context) => unknown) => string,
): Record<string, any> {
  if (!extra) return {};
  let has = false;
  for (const k of FRIENDLY_KEYS) if (k in extra) (has = true);
  if (!has) return extra;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(extra)) if (!FRIENDLY_KEYS.includes(k)) out[k] = v;

  if (extra.inline) {
    out.reply_markup = InlineKeyboard.from(toRows(extra.inline, extra.columns).map((r) => r.map((b) => inlineButton(b, register))));
  } else if (extra.keyboard) {
    const kb = Keyboard.from(toRows(extra.keyboard, extra.columns).map((r) => r.map(replyButton))).resized();
    if (extra.oneTime) kb.oneTime();
    if (extra.placeholder) kb.placeholder(extra.placeholder);
    out.reply_markup = kb;
  } else if (extra.removeKeyboard) {
    out.reply_markup = Keyboard.remove();
  }
  if (extra.html) out.parse_mode = 'HTML';
  if (extra.markdown) out.parse_mode = 'MarkdownV2';
  if (extra.silent) out.disable_notification = true;
  if (extra.protect) out.protect_content = true;
  if (extra.noPreview) out.link_preview_options = { is_disabled: true };
  if (extra.replyTo) out.reply_parameters = { message_id: extra.replyTo, allow_sending_without_reply: true };
  return out;
}

/**
 * Простой результат inline-режима:
 * - `{ title, text }` — статья (отправит text)
 * - `{ photo: url }` — фото
 * - `{ gif: url }`, `{ video: url, title }`, `{ document: url, title }`
 * Плюс `description`, `thumb`, `inline` (кнопки), `html: true`, `id`.
 */
export interface InlineResult {
  id?: string;
  title?: string;
  text?: string;
  description?: string;
  thumb?: string;
  photo?: string;
  gif?: string;
  video?: string;
  document?: string;
  caption?: string;
  html?: boolean;
  inline?: Friendly['inline'];
}

export function toInlineResult(r: InlineResult | InlineQueryResult, index: number, register: (fn: (ctx: Context) => unknown) => string): InlineQueryResult {
  if ('type' in r && typeof (r as InlineQueryResult).type === 'string') return r as InlineQueryResult;
  const s = r as InlineResult;
  const id = s.id ?? String(index);
  const markup = s.inline ? (normalize({ inline: s.inline }, register).reply_markup as InlineKeyboard).toJSON() : undefined;
  const parse_mode = s.html ? ('HTML' as const) : undefined;
  if (s.photo) return { type: 'photo', id, photo_url: s.photo, thumbnail_url: s.thumb ?? s.photo, title: s.title, description: s.description, caption: s.caption, parse_mode, reply_markup: markup };
  if (s.gif) return { type: 'gif', id, gif_url: s.gif, thumbnail_url: s.thumb ?? s.gif, title: s.title, caption: s.caption, parse_mode, reply_markup: markup };
  if (s.video) return { type: 'video', id, video_url: s.video, mime_type: 'video/mp4', thumbnail_url: s.thumb ?? s.video, title: s.title ?? 'Видео', description: s.description, caption: s.caption, parse_mode, reply_markup: markup };
  if (s.document) return { type: 'document', id, document_url: s.document, mime_type: s.document.endsWith('.zip') ? 'application/zip' : 'application/pdf', title: s.title ?? 'Файл', description: s.description, caption: s.caption, parse_mode, reply_markup: markup };
  if (!s.title) throw new Error('Inline-результат: нужен title (и text), или photo/gif/video/document');
  return {
    type: 'article',
    id,
    title: s.title,
    description: s.description,
    thumbnail_url: s.thumb,
    input_message_content: { message_text: s.text ?? s.title, parse_mode },
    reply_markup: markup,
  };
}

/** Registry for `onClick` handlers (in memory; capped, oldest are evicted). */
export class ButtonRegistry {
  private readonly map = new Map<string, (ctx: Context) => unknown>();
  private seq = 0;
  private readonly prefix = `~wb~${Date.now().toString(36)}:`;

  constructor(private readonly max = 50_000) {}

  register(fn: (ctx: Context) => unknown): string {
    const id = this.prefix + (this.seq++).toString(36);
    this.map.set(id, fn);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    return id;
  }

  /** Returns: handler, 'expired' for an old onClick button, or undefined if not ours. */
  lookup(data: string | undefined): ((ctx: Context) => unknown) | 'expired' | undefined {
    if (!data) return undefined;
    const fn = this.map.get(data);
    if (fn) return fn;
    return data.startsWith('~wb~') ? 'expired' : undefined;
  }
}
