export { Bot, type BotOptions, type PollingOptions, type StartWebhookOptions, type WebhookOptions } from './bot/bot.js';
export { Api, type ApiOptions, type ParseMode, type Transformer } from './bot/api.js';
export { Composer, compose, compileFilter, type FilterQuery, type Filtered, type Handler, type Middleware, type NextFn, type Trigger } from './bot/composer.js';
export { Context, type ContextHost, type FileArg, type SessionData, type Text, type WaitOptions } from './bot/context.js';
export { TelegramError, HttpError } from './bot/errors.js';
export { Formatted, html, md, fmt, escapeHtml, escapeMarkdown } from './bot/format.js';
export { InputFile, type InputFileSource } from './bot/input-file.js';
export { InlineKeyboard, Keyboard } from './bot/keyboard.js';
export { session, MemoryStore, FileStore, type SessionStore, type SessionOptions } from './bot/session.js';
export { Scene, SceneControl, scenes, type SceneOptions } from './bot/scenes.js';
export { throttle, type ThrottleOptions } from './bot/throttle.js';
export { type Friendly, type InlineButton, type ReplyButton, type InlineResult } from './bot/friendly.js';
export { validateWebAppData, validateWebAppSignature, checkLoginWidget, type WebAppData, type LoginWidgetData } from './bot/security.js';
export { I18n, type I18nOptions, type Locale, type Translation } from './bot/i18n.js';
export { Scheduler, parseCron, nextCron, type Job } from './bot/schedule.js';
export { parseDuration } from './bot/duration.js';
export type { InvoiceOptions, PaginateOptions } from './bot/context.js';
export { Database, Collection, type Doc, type UserRecord, type UserData } from './db/database.js';
export { connectDriver, MemoryDriver, JsonDriver, type Driver, type Filter } from './db/drivers.js';
export { VERSION } from './version.js';
export type { CallOptions } from './bot/generated/methods.js';
export * from './bot/generated/types.js';

import { InputFile, type InputFileSource } from './bot/input-file.js';
/** Shorthand: `file('./cat.jpg')` → InputFile. */
export const file = (source: InputFileSource, filename?: string) => new InputFile(source, filename);
