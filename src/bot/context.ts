import { Readable } from 'node:stream';
import type { Api } from './api.js';
import type { Formatted } from './format.js';
import { InputFile } from './input-file.js';
import type { SceneControl } from './scenes.js';
import { normalize, toInlineResult, type Friendly, type InlineButton, type InlineResult } from './friendly.js';
import { parseDuration, untilDate } from './duration.js';
import { TelegramError } from './errors.js';
import type { I18n } from './i18n.js';
import type { LabeledPrice, SuccessfulPayment } from './generated/types.js';
import type { Database, UserData, UserRecord } from '../db/database.js';
import {
  UPDATE_TYPES,
  type AnswerCallbackQueryParams,
  type AnswerInlineQueryParams,
  type Chat,
  type CopyMessageParams,
  type EditMessageCaptionParams,
  type EditMessageMediaParams,
  type EditMessageReplyMarkupParams,
  type EditMessageTextParams,
  type ForwardMessageParams,
  type InlineQueryResult,
  type InputMedia,
  type InputMediaAudio,
  type InputMediaDocument,
  type InputMediaPhoto,
  type InputMediaVideo,
  type Message,
  type MessageEntity,
  type ReactionTypeEmoji,
  type ReactionType,
  type SendAnimationParams,
  type SendAudioParams,
  type SendChatActionParams,
  type SendContactParams,
  type SendDiceParams,
  type SendDocumentParams,
  type SendInvoiceParams,
  type SendLocationParams,
  type SendMediaGroupParams,
  type SendMessageParams,
  type SendPhotoParams,
  type SendPollParams,
  type SendStickerParams,
  type SendVenueParams,
  type SendVideoNoteParams,
  type SendVideoParams,
  type SendVoiceParams,
  type ShippingOption,
  type Update,
  type UpdateType,
  type User,
} from './generated/types.js';

/** Text accepted by reply helpers: a plain string or `html`/`md` formatted text. */
export type Text = string | Formatted;
/** A file to send: file_id / URL string, InputFile, Buffer, stream or Blob. */
export type FileArg = string | InputFile | Buffer | Uint8Array | Blob | Readable;

type Extra<P, K extends keyof P> = Omit<P, K | 'chat_id'> & { chat_id?: number | string } & Friendly;
/** Edit options: Bot API fields + friendly options (inline buttons, html...). */
type EditExtra<P> = Omit<P, 'chat_id' | 'message_id' | 'inline_message_id'> & Pick<Friendly, 'inline' | 'columns' | 'html' | 'markdown' | 'noPreview'>;

export type CamelCase<S extends string> = S extends `${infer A}_${infer B}` ? `${A}${Capitalize<CamelCase<B>>}` : S;
const camel = (s: string) => s.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());

/** `ctx.message`, `ctx.callbackQuery`, `ctx.chatJoinRequest`... one getter per update type. */
export type UpdateGetters = { readonly [K in UpdateType as CamelCase<K>]?: NonNullable<Update[K]> };

/** Message-carrying update types. */
export const MESSAGE_UPDATES = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'business_message',
  'edited_business_message',
  'guest_message',
] as const satisfies readonly UpdateType[];

export interface WaitOptions {
  /** Milliseconds to wait. Default: 5 minutes. */
  timeout?: number;
  /** Accept only answers that pass this check (others go to normal handlers). */
  filter?: (ctx: Context) => boolean;
}

/** Счёт на оплату (по умолчанию — в звёздах Telegram). */
export interface InvoiceOptions {
  title: string;
  description?: string;
  /** Цена в звёздах (Stars). */
  stars?: number;
  /** Свои позиции цены (для других валют/провайдеров). */
  prices?: LabeledPrice[];
  /** Валюта. Default: 'XTR' (звёзды). */
  currency?: string;
  /** Токен платёжного провайдера (не нужен для звёзд). */
  providerToken?: string;
  /** Ваши данные заказа (вернутся в оплате). */
  payload?: string;
  /** Картинка товара. */
  photo?: string;
  /** Что сделать после успешной оплаты. */
  onPaid?: (ctx: Context, payment: SuccessfulPayment) => unknown;
  /** Любые другие параметры sendInvoice. */
  extra?: Partial<SendInvoiceParams>;
}

export interface PaginateOptions<T> {
  /** Элементов на странице. Default: 6 кнопками / 10 текстом. */
  perPage?: number;
  /** Заголовок: строка или (страница, всего) => строка. */
  title?: string | ((page: number, pages: number) => string);
  /** Текст элемента (режим списка текстом). */
  format?: (item: T, index: number) => string;
  /** Текст кнопки элемента (режим кнопок). */
  label?: (item: T) => string;
  /** Нажали на элемент — включает режим кнопок. */
  onSelect?: (ctx: Context, item: T) => unknown;
  /** Кнопок в ряд. Default: 1. */
  columns?: number;
  /** Текст, если список пуст. */
  empty?: string;
}

/** What Context needs from the bot. */
export interface ContextHost {
  readonly api: Api;
  readonly me: User;
  readonly db: Database;
  waitFor(key: string, options?: WaitOptions): Promise<Context>;
  registerButton(fn: (ctx: Context) => unknown): string;
  registerPayment(payload: string, fn: (ctx: Context, payment: SuccessfulPayment) => unknown): void;
  admins(chatId: number): Promise<Set<number>>;
  readonly i18n?: I18n;
}

export const toFile = (f: FileArg): InputFile | string =>
  typeof f === 'string' || f instanceof InputFile ? f : new InputFile(f as never);

export interface Context extends UpdateGetters {}

/** Handler context: the update plus shortcuts that know where to reply. */
export class Context {
  /** Values captured by `hears`/`action`/`command` regexes. */
  match: RegExpExecArray | null = null;
  /** Free-form per-update storage for your middleware. */
  state: Record<string, unknown> = {};
  /** Данные сессии (чат + пользователь). Сохраняются автоматически. `ctx.session = null` — удалить. */
  declare session: SessionData;
  /** @internal lazily loaded records (user/session) */
  _slots: { user?: RecordSlot; session?: RecordSlot } | undefined = undefined;
  /** @internal */
  _session: SessionData | undefined = undefined;
  /** @internal */
  _user: (UserRecord & UserData) | undefined = undefined;
  /** Set by the scenes middleware. */
  scene!: SceneControl;
  /**
   * Пользователь из базы данных: Telegram-данные + ваши поля. Изменения сохраняются автоматически.
   * ```ts
   * ctx.user.balance = (ctx.user.balance ?? 0) + 100;
   * ```
   * Нет в апдейтах без отправителя (например, посты каналов).
   */
  declare user: UserRecord & UserData;
  /** @internal */
  _answered = false;

  constructor(
    readonly update: Update,
    readonly host: ContextHost,
    /** The kind of this update (`message`, `callback_query`...). */
    readonly updateType: UpdateType,
  ) {}

  get api(): Api {
    return this.host.api;
  }
  /** База данных бота: `ctx.db.users`, `ctx.db.collection('orders')`. */
  get db(): Database {
    return this.host.db;
  }
  /** The bot's own user (from getMe). */
  get me(): User {
    return this.host.me;
  }

  /** The update payload, whatever its type. */
  get payload(): Record<string, any> {
    return (this.update as any)[this.updateType];
  }

  /** Any message in this update: new, edited, channel post, business, or the message of a callback query. */
  get msg(): Message | undefined {
    const p = this.payload;
    if ((MESSAGE_UPDATES as readonly string[]).includes(this.updateType)) return p as Message;
    const m = p?.message ?? p?.pinned_message;
    return m && 'date' in m && m.date !== 0 ? (m as Message) : undefined;
  }

  /** The chat this update belongs to. */
  get chat(): Chat | undefined {
    const p = this.payload;
    return p?.chat ?? p?.message?.chat ?? p?.message_chat;
  }
  get chatId(): number | undefined {
    return this.chat?.id;
  }

  /** The user who caused this update. */
  get from(): User | undefined {
    const p = this.payload;
    if (!p) return undefined;
    if (this.updateType === 'business_connection' || this.updateType === 'purchased_paid_media') return p.user;
    return p.from ?? p.user ?? p.source?.user ?? p.boost?.source?.user;
  }

  /** Text or caption of the message. */
  get text(): string | undefined {
    const m = this.msg;
    return m?.text ?? m?.caption ?? (this.payload?.query as string | undefined);
  }
  get entities(): MessageEntity[] {
    const m = this.msg;
    return m?.entities ?? m?.caption_entities ?? [];
  }
  /** Data of the pressed inline button. */
  get callbackData(): string | undefined {
    return this.update.callback_query?.data;
  }
  get inlineMessageId(): string | undefined {
    return this.payload?.inline_message_id;
  }
  get businessConnectionId(): string | undefined {
    return this.msg?.business_connection_id ?? this.payload?.business_connection_id;
  }

  /** `/start abc` → `"abc"`; text after the command. */
  get args(): string {
    const e = this.entities[0];
    if (!e || e.type !== 'bot_command' || e.offset !== 0) return '';
    return (this.text ?? '').slice(e.length).trim();
  }
  /** The command name without `/` and `@bot`, if the message starts with a command. */
  get command(): string | undefined {
    const e = this.entities[0];
    if (!e || e.type !== 'bot_command' || e.offset !== 0) return undefined;
    return (this.text ?? '').slice(1, e.length).split('@')[0].toLowerCase();
  }

  // ---------- sending ----------

  private target(extra: { chat_id?: number | string } = {}): Record<string, unknown> {
    const chat_id = extra.chat_id ?? this.chatId ?? this.from?.id;
    if (chat_id === undefined) throw new Error(`Cannot reply to "${this.updateType}": no chat in this update`);
    const t: Record<string, unknown> = { chat_id };
    const m = this.msg;
    if (extra.chat_id === undefined) {
      const bc = this.businessConnectionId;
      if (bc) t.business_connection_id = bc;
      if (m?.is_topic_message && m.message_thread_id) t.message_thread_id = m.message_thread_id;
    }
    return t;
  }

  /** Converts friendly options (inline, keyboard, html...) to Bot API params. */
  opts(extra?: object): Record<string, any> {
    return normalize(extra as Friendly | undefined, (fn) => this.host.registerButton(fn));
  }

  private send<R>(method: string, params: Record<string, unknown>, extra?: object): Promise<R> {
    const ex = this.opts(extra);
    return this.api.call(method as 'sendMessage', { ...this.target(ex), ...params, ...ex } as never) as Promise<R>;
  }

  /** Sends a text message to this chat. */
  reply(text: Text, extra?: Extra<SendMessageParams, 'text'>): Promise<Message> {
    return this.send('sendMessage', { text }, extra);
  }
  /** Replies quoting the current message. */
  quote(text: Text, extra?: Extra<SendMessageParams, 'text'>): Promise<Message> {
    const id = this.msg?.message_id;
    return this.reply(text, { ...(id ? { reply_parameters: { message_id: id } } : {}), ...extra });
  }
  replyWithPhoto(photo: FileArg, extra?: Extra<SendPhotoParams, 'photo'>): Promise<Message> {
    return this.send('sendPhoto', { photo: toFile(photo) }, extra);
  }
  replyWithVideo(video: FileArg, extra?: Extra<SendVideoParams, 'video'>): Promise<Message> {
    return this.send('sendVideo', { video: toFile(video) }, extra);
  }
  replyWithAnimation(animation: FileArg, extra?: Extra<SendAnimationParams, 'animation'>): Promise<Message> {
    return this.send('sendAnimation', { animation: toFile(animation) }, extra);
  }
  replyWithAudio(audio: FileArg, extra?: Extra<SendAudioParams, 'audio'>): Promise<Message> {
    return this.send('sendAudio', { audio: toFile(audio) }, extra);
  }
  replyWithDocument(document: FileArg, extra?: Extra<SendDocumentParams, 'document'>): Promise<Message> {
    return this.send('sendDocument', { document: toFile(document) }, extra);
  }
  replyWithVoice(voice: FileArg, extra?: Extra<SendVoiceParams, 'voice'>): Promise<Message> {
    return this.send('sendVoice', { voice: toFile(voice) }, extra);
  }
  replyWithVideoNote(note: FileArg, extra?: Extra<SendVideoNoteParams, 'video_note'>): Promise<Message> {
    return this.send('sendVideoNote', { video_note: toFile(note) }, extra);
  }
  replyWithSticker(sticker: FileArg, extra?: Extra<SendStickerParams, 'sticker'>): Promise<Message> {
    return this.send('sendSticker', { sticker: toFile(sticker) }, extra);
  }
  /** Album of 2-10 photos/videos/documents/audios. */
  replyWithMediaGroup(
    media: Array<InputMediaPhoto | InputMediaVideo | InputMediaDocument | InputMediaAudio>,
    extra?: Extra<SendMediaGroupParams, 'media'>,
  ): Promise<Message[]> {
    return this.send('sendMediaGroup', { media }, extra);
  }
  replyWithLocation(latitude: number, longitude: number, extra?: Extra<SendLocationParams, 'latitude' | 'longitude'>): Promise<Message> {
    return this.send('sendLocation', { latitude, longitude }, extra);
  }
  replyWithVenue(
    latitude: number,
    longitude: number,
    title: string,
    address: string,
    extra?: Extra<SendVenueParams, 'latitude' | 'longitude' | 'title' | 'address'>,
  ): Promise<Message> {
    return this.send('sendVenue', { latitude, longitude, title, address }, extra);
  }
  replyWithContact(phone: string, firstName: string, extra?: Extra<SendContactParams, 'phone_number' | 'first_name'>): Promise<Message> {
    return this.send('sendContact', { phone_number: phone, first_name: firstName }, extra);
  }
  /** `ctx.replyWithPoll('Best?', ['A', 'B'])` */
  replyWithPoll(question: Text, options: Array<string | { text: string }>, extra?: Extra<SendPollParams, 'question' | 'options'>): Promise<Message> {
    return this.send('sendPoll', { question, options: options.map((o) => (typeof o === 'string' ? { text: o } : o)) }, extra);
  }
  replyWithDice(emoji?: string, extra?: Extra<SendDiceParams, 'emoji'>): Promise<Message> {
    return this.send('sendDice', emoji ? { emoji } : {}, extra);
  }
  replyWithInvoice(invoice: Extra<SendInvoiceParams, never>): Promise<Message> {
    return this.send('sendInvoice', {}, invoice);
  }
  /** Shows "typing…", "uploading photo…" etc. */
  replyWithChatAction(action: SendChatActionParams['action'] = 'typing', extra?: Extra<SendChatActionParams, 'action'>): Promise<boolean> {
    return this.send('sendChatAction', { action }, extra);
  }

  // ---------- editing current message ----------

  private where(): Record<string, unknown> {
    const inline = this.inlineMessageId;
    if (inline) return { inline_message_id: inline };
    const m = this.msg;
    if (!m) throw new Error(`No message to edit in "${this.updateType}"`);
    const w: Record<string, unknown> = { chat_id: m.chat.id, message_id: m.message_id };
    if (m.business_connection_id) w.business_connection_id = m.business_connection_id;
    return w;
  }

  /**
   * Меняет текст текущего сообщения (например, того, где нажали кнопку).
   * ```ts
   * ctx.editText('Готово ✅', { inline: [{ text: 'Ещё раз', onClick: again }] })
   * ```
   */
  editText(text: Text, extra?: Omit<EditExtra<EditMessageTextParams>, 'text'>): Promise<Message | boolean> {
    return this.api.call('editMessageText', { ...this.where(), text, ...this.opts(extra) } as never);
  }
  /** Меняет подпись к медиа. */
  editCaption(caption?: Text, extra?: Omit<EditExtra<EditMessageCaptionParams>, 'caption'>): Promise<Message | boolean> {
    return this.api.call('editMessageCaption', { ...this.where(), caption, ...this.opts(extra) } as never);
  }
  /** Заменяет медиа (фото/видео/файл) в сообщении. */
  editMedia(media: InputMedia, extra?: Omit<EditExtra<EditMessageMediaParams>, 'media'>): Promise<Message | boolean> {
    return this.api.call('editMessageMedia', { ...this.where(), media, ...this.opts(extra) } as never);
  }
  /** Меняет только кнопки: `ctx.editButtons([{ text: 'Новая', onClick: h }])`, без аргумента — убирает. */
  editButtons(inline?: Friendly['inline'], columns?: number): Promise<Message | boolean> {
    const extra = inline ? this.opts({ inline, columns }) : { reply_markup: { inline_keyboard: [] } };
    return this.api.call('editMessageReplyMarkup', { ...this.where(), ...extra } as never);
  }
  editReplyMarkup(
    reply_markup: EditMessageReplyMarkupParams['reply_markup'],
    extra?: Omit<EditMessageReplyMarkupParams, 'reply_markup' | 'chat_id' | 'message_id' | 'inline_message_id'>,
  ): Promise<Message | boolean> {
    return this.api.call('editMessageReplyMarkup', { ...this.where(), reply_markup, ...this.opts(extra) } as never);
  }
  /** Deletes the current message (or the given id in this chat). */
  deleteMessage(messageId?: number): Promise<boolean> {
    const m = this.msg;
    const chat_id = this.chatId;
    const message_id = messageId ?? m?.message_id;
    if (chat_id === undefined || message_id === undefined) throw new Error('No message to delete');
    return this.api.deleteMessage({ chat_id, message_id });
  }
  forward(toChatId: number | string, extra?: Omit<ForwardMessageParams, 'chat_id' | 'from_chat_id' | 'message_id'>): Promise<Message> {
    const m = this.msg!;
    return this.api.forwardMessage({ chat_id: toChatId, from_chat_id: m.chat.id, message_id: m.message_id, ...extra });
  }
  /** Copies the current message (without the "forwarded" header). */
  copy(toChatId: number | string, extra?: Omit<CopyMessageParams, 'chat_id' | 'from_chat_id' | 'message_id'>) {
    const m = this.msg!;
    return this.api.copyMessage({ chat_id: toChatId, from_chat_id: m.chat.id, message_id: m.message_id, ...extra });
  }
  pin(disableNotification = false): Promise<boolean> {
    const m = this.msg!;
    return this.api.pinChatMessage({ chat_id: m.chat.id, message_id: m.message_id, disable_notification: disableNotification });
  }
  /** Sets reactions on the current message: `ctx.react('👍')`. Pass nothing to remove. */
  react(reaction?: ReactionTypeEmoji['emoji'] | ReactionType | Array<ReactionTypeEmoji['emoji'] | ReactionType>, isBig = false): Promise<boolean> {
    const m = this.msg!;
    const list = reaction === undefined ? [] : Array.isArray(reaction) ? reaction : [reaction];
    return this.api.setMessageReaction({
      chat_id: m.chat.id,
      message_id: m.message_id,
      reaction: list.map((r) => (typeof r === 'string' ? { type: 'emoji', emoji: r } : r)),
      is_big: isBig,
    });
  }

  // ---------- answering queries ----------

  /** Answers the callback query (stops the loading spinner on the button). */
  answer(text?: string, extra?: Omit<AnswerCallbackQueryParams, 'callback_query_id' | 'text'>): Promise<boolean> {
    const q = this.update.callback_query;
    if (!q) throw new Error('answer() is only available for callback queries');
    this._answered = true;
    return this.api.answerCallbackQuery({ callback_query_id: q.id, text, ...extra });
  }
  /** Shows a popup alert in response to a button press. */
  alert(text: string): Promise<boolean> {
    return this.answer(text, { show_alert: true });
  }
  answerPreCheckout(ok: boolean, errorMessage?: string): Promise<boolean> {
    const q = this.update.pre_checkout_query!;
    this._answered = true;
    return this.api.answerPreCheckoutQuery({ pre_checkout_query_id: q.id, ok, error_message: errorMessage });
  }
  answerShipping(ok: boolean, options?: ShippingOption[], errorMessage?: string): Promise<boolean> {
    const q = this.update.shipping_query!;
    return this.api.answerShippingQuery({ shipping_query_id: q.id, ok, shipping_options: options, error_message: errorMessage });
  }
  approveJoin(): Promise<boolean> {
    const r = this.update.chat_join_request!;
    return this.api.approveChatJoinRequest({ chat_id: r.chat.id, user_id: r.from.id });
  }
  declineJoin(): Promise<boolean> {
    const r = this.update.chat_join_request!;
    return this.api.declineChatJoinRequest({ chat_id: r.chat.id, user_id: r.from.id });
  }

  // ---------- тип чата ----------

  /** Личный чат с ботом. */
  get isPrivate(): boolean {
    return this.chat?.type === 'private';
  }
  /** Группа или супергруппа. */
  get isGroup(): boolean {
    return this.chat?.type === 'group' || this.chat?.type === 'supergroup';
  }
  /** Канал. */
  get isChannel(): boolean {
    return this.chat?.type === 'channel';
  }

  // ---------- управление группой ----------

  /** Кого касается команда: указанный id, или автор сообщения, на которое ответили. */
  private targetUser(userId?: number): number {
    const id = userId ?? this.msg?.reply_to_message?.from?.id;
    if (!id) throw new Error('Укажите пользователя (id) или ответьте командой на его сообщение');
    return id;
  }
  private groupId(): number {
    const id = this.chatId;
    if (id === undefined) throw new Error('Это действие доступно только в чате');
    return id;
  }

  /**
   * Забанить. Без userId — автора сообщения, на которое ответили.
   * ```ts
   * bot.command('ban', ctx => ctx.ban());                    // навсегда (ответом на сообщение)
   * await ctx.ban(userId, { for: '1d', deleteMessages: true });
   * ```
   */
  async ban(userId?: number, options: { for?: number | string; deleteMessages?: boolean } = {}): Promise<boolean> {
    return this.api.banChatMember({
      chat_id: this.groupId(),
      user_id: this.targetUser(userId),
      until_date: options.for !== undefined ? untilDate(options.for) : undefined,
      revoke_messages: options.deleteMessages,
    });
  }
  /** Разбанить. */
  unban(userId?: number): Promise<boolean> {
    return this.api.unbanChatMember({ chat_id: this.groupId(), user_id: this.targetUser(userId), only_if_banned: true });
  }
  /** Выгнать из группы (сможет вернуться по ссылке). */
  async kick(userId?: number): Promise<boolean> {
    const user = this.targetUser(userId);
    await this.api.banChatMember({ chat_id: this.groupId(), user_id: user });
    return this.api.unbanChatMember({ chat_id: this.groupId(), user_id: user, only_if_banned: true });
  }
  /** Запретить писать: `ctx.mute(userId, '1h')`; без срока — навсегда. */
  mute(userId?: number, duration?: number | string): Promise<boolean> {
    return this.api.restrictChatMember({
      chat_id: this.groupId(),
      user_id: this.targetUser(userId),
      permissions: { can_send_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false, can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false, can_add_web_page_previews: false },
      until_date: duration !== undefined ? untilDate(duration) : undefined,
    });
  }
  /** Снять ограничения. */
  unmute(userId?: number): Promise<boolean> {
    return this.api.restrictChatMember({
      chat_id: this.groupId(),
      user_id: this.targetUser(userId),
      permissions: { can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true, can_send_videos: true, can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true, can_add_web_page_previews: true, can_invite_users: true },
    });
  }
  /** Участник чата (статус, права). */
  getMember(userId?: number, chatId?: number | string) {
    return this.api.getChatMember({ chat_id: chatId ?? this.groupId(), user_id: userId ?? this.from!.id });
  }
  /** Админ ли пользователь в этом чате (по умолчанию — тот, кто написал). Списки админов кэшируются на минуту. */
  async isAdmin(userId?: number): Promise<boolean> {
    const id = userId ?? this.from?.id;
    if (id === undefined || !this.chat) return false;
    if (this.chat.type === 'private') return false;
    if (this.senderChat?.id === this.chat.id) return true; // anonymous admin
    return (await this.host.admins(this.chat.id)).has(id);
  }
  /**
   * Подписан ли пользователь на канал/группу. Бот должен быть админом там.
   * ```ts
   * if (!(await ctx.isSubscribed('@my_channel'))) return ctx.reply('Подпишитесь на @my_channel');
   * ```
   */
  async isSubscribed(chat: number | string, userId?: number): Promise<boolean> {
    const id = userId ?? this.from?.id;
    if (id === undefined) return false;
    try {
      const m = await this.api.getChatMember({ chat_id: chat, user_id: id });
      return m.status === 'creator' || m.status === 'administrator' || m.status === 'member' || (m.status === 'restricted' && m.is_member);
    } catch (e) {
      if (e instanceof TelegramError && /member list is inaccessible|chat not found|not enough rights/i.test(e.description)) {
        throw new Error(`Не могу проверить подписку на ${chat}: добавьте бота администратором в этот канал/группу`);
      }
      if (e instanceof TelegramError && /user not found|PARTICIPANT_ID_INVALID/i.test(e.description)) return false;
      throw e;
    }
  }
  get senderChat(): Chat | undefined {
    return this.msg?.sender_chat;
  }

  // ---------- оплата звёздами ----------

  /**
   * Счёт на оплату звёздами Telegram (Stars).
   * ```ts
   * ctx.invoice({ title: 'Премиум на месяц', stars: 100, onPaid: (ctx) => { ctx.user.premium = true; return ctx.reply('Спасибо!'); } });
   * ```
   * Для постоянной обработки оплат используйте `bot.onPayment(...)` (onPaid живёт, пока бот запущен).
   */
  invoice(options: InvoiceOptions): Promise<Message> {
    const payload = options.payload ?? `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    if (options.onPaid) this.host.registerPayment(payload, options.onPaid);
    const prices = options.prices ?? [{ label: options.title, amount: options.stars ?? 0 }];
    return this.send('sendInvoice', {
      title: options.title,
      description: options.description ?? options.title,
      payload,
      currency: options.currency ?? 'XTR',
      prices,
      provider_token: options.providerToken,
      photo_url: options.photo,
      ...(options.extra ?? {}),
    });
  }
  /** Данные успешной оплаты (в обработчике оплаты). */
  get payment(): SuccessfulPayment | undefined {
    return this.msg?.successful_payment;
  }
  /** Вернуть звёзды: по умолчанию — за текущую оплату. */
  refund(chargeId?: string, userId?: number): Promise<boolean> {
    const charge = chargeId ?? this.payment?.telegram_payment_charge_id;
    if (!charge) throw new Error('Укажите telegram_payment_charge_id');
    return this.api.refundStarPayment({ user_id: userId ?? this.from!.id, telegram_payment_charge_id: charge });
  }

  // ---------- inline-режим ----------

  /**
   * Ответ на inline-запрос (@бот текст). Можно простыми объектами:
   * ```ts
   * ctx.answerInline([
   *   { title: 'Привет', text: 'Привет всем!' },
   *   { title: 'Котик', photo: 'https://.../cat.jpg' },
   * ], { cache: '1m' });
   * ```
   */
  answerInline(results: Array<InlineResult | InlineQueryResult>, extra?: Omit<AnswerInlineQueryParams, 'inline_query_id' | 'results'> & { cache?: number | string; personal?: boolean }): Promise<boolean> {
    const q = this.update.inline_query;
    if (!q) throw new Error('answerInline() доступен только для inline-запросов');
    const { cache, personal, ...rest } = extra ?? {};
    const reg = (fn: (ctx: Context) => unknown) => this.host.registerButton(fn);
    return this.api.answerInlineQuery({
      inline_query_id: q.id,
      results: results.map((r, i) => toInlineResult(r, i, reg)),
      cache_time: cache !== undefined ? parseDuration(cache) : undefined,
      is_personal: personal,
      ...rest,
    });
  }

  // ---------- списки со страницами ----------

  /**
   * Список с кнопками ◀️ ▶️.
   * ```ts
   * // кнопками: нажатие на элемент вызывает onSelect
   * ctx.paginate(products, { label: p => p.name, onSelect: (ctx, p) => ctx.reply(p.description) });
   * // текстом
   * ctx.paginate(orders, { perPage: 10, format: (o, i) => `${i + 1}. ${o.title}` });
   * ```
   */
  paginate<T>(items: T[], options: PaginateOptions<T> = {}): Promise<Message> {
    const perPage = options.perPage ?? (options.onSelect ? 6 : 10);
    const pages = Math.max(1, Math.ceil(items.length / perPage));
    const render = (page: number) => {
      const slice = items.slice(page * perPage, (page + 1) * perPage);
      const header = typeof options.title === 'function' ? options.title(page + 1, pages) : options.title ?? (pages > 1 ? `Страница ${page + 1} из ${pages}` : '');
      const fmt = options.format ?? ((x: T) => String(x));
      const text = options.onSelect
        ? header || ' '
        : [header, ...slice.map((x, i) => fmt(x, page * perPage + i))].filter(Boolean).join('\n') || options.empty || 'Пусто';
      const rows: InlineButton[][] = [];
      if (options.onSelect) {
        const label = options.label ?? ((x: T) => String(x));
        const btns = slice.map((x) => ({ text: label(x), onClick: (c: Context) => options.onSelect!(c, x) }));
        for (let i = 0; i < btns.length; i += options.columns ?? 1) rows.push(btns.slice(i, i + (options.columns ?? 1)));
      }
      if (pages > 1) {
        rows.push([
          { text: page > 0 ? '◀️' : '·', onClick: (c) => (page > 0 ? show(c, page - 1) : c.answer()) },
          { text: `${page + 1}/${pages}`, onClick: (c) => c.answer() },
          { text: page < pages - 1 ? '▶️' : '·', onClick: (c) => (page < pages - 1 ? show(c, page + 1) : c.answer()) },
        ]);
      }
      return { text, inline: rows };
    };
    const show = (c: Context, page: number) => {
      const r = render(page);
      return c.editText(r.text, { inline: r.inline });
    };
    const first = render(0);
    if (!items.length && options.empty) return this.reply(options.empty);
    return this.reply(first.text, { inline: first.inline });
  }

  // ---------- переводы ----------

  /** Язык пользователя: выбранный через setLang, иначе язык его Telegram. */
  get lang(): string {
    const i18n = this.host.i18n;
    const chosen = (this.from ? this.user?.locale : undefined) as string | undefined;
    const code = chosen ?? this.from?.language_code;
    return i18n ? i18n.resolve(code) : (code ?? 'en');
  }
  /** Сменить язык пользователя (сохраняется в базе). */
  setLang(code: string): void {
    if (this.user) this.user.locale = code;
  }
  /**
   * Перевод на язык пользователя: `ctx.t('hello', { name: ctx.from.first_name })`.
   * Переводы подключаются так: `new Bot({ i18n: { locales: './locales' } })`.
   */
  t(key: string, vars?: Record<string, unknown>): string {
    const i18n = this.host.i18n;
    if (!i18n) throw new Error("Подключите переводы: new Bot({ i18n: { locales: './locales' } })");
    return i18n.t(this.lang, key, vars);
  }

  // ---------- files ----------

  /** The file_id of the media in this message (largest photo size), if any. */
  get fileId(): string | undefined {
    const m = this.msg;
    if (!m) return undefined;
    if (m.photo?.length) return m.photo[m.photo.length - 1].file_id;
    const media = m.document ?? m.video ?? m.audio ?? m.voice ?? m.video_note ?? m.animation ?? m.sticker;
    return media?.file_id;
  }

  /** Downloads the media of this message. Returns a Buffer, or writes to `dest` and returns the path. */
  download(dest: string): Promise<string>;
  download(): Promise<Buffer>;
  download(dest?: string): Promise<Buffer | string> {
    const id = this.fileId;
    if (!id) throw new Error('This message has no file');
    return dest ? this.api.download(id, dest) : this.api.download(id);
  }

  // ---------- conversations ----------

  /**
   * Waits for the next update from the same user in the same chat.
   * ```ts
   * const answer = await ctx.ask('What is your name?');
   * await ctx.reply(`Hi, ${answer.text}`);
   * ```
   * Pending waits live in memory and are lost on restart.
   */
  waitForReply(options?: WaitOptions): Promise<Context> {
    return this.host.waitFor(conversationKey(this), options);
  }

  /** Sends a question and waits for the answer (see `waitForReply`). */
  async ask(question: Text, options?: WaitOptions & { extra?: Extra<SendMessageParams, 'text'> }): Promise<Context> {
    const wait = this.waitForReply(options);
    await this.reply(question, options?.extra);
    return wait;
  }
}

/** Session data. Extend it with declaration merging for typed sessions:
 * ```ts
 * declare module 'wyscra-tg' { interface SessionData { counter: number } }
 * ```
 */
export interface SessionData {
  [key: string]: any;
}

/** Key identifying "this user in this chat". */
export function conversationKey(ctx: Context): string {
  return `${ctx.chatId ?? ''}:${ctx.from?.id ?? ''}`;
}

/** @internal Lazily loaded DB record behind ctx.user / ctx.session. */
export interface RecordSlot {
  get(): any;
  set(v: any): void;
}

for (const prop of ['user', 'session'] as const) {
  const own = prop === 'user' ? '_user' : '_session';
  Object.defineProperty(Context.prototype, prop, {
    get(this: Context) {
      const slot = this._slots?.[prop];
      return slot ? slot.get() : this[own];
    },
    set(this: Context, v: any) {
      const slot = this._slots?.[prop];
      if (slot) slot.set(v);
      else (this as any)[own] = v;
    },
    configurable: true,
    enumerable: true,
  });
}

for (const type of UPDATE_TYPES) {
  Object.defineProperty(Context.prototype, camel(type), {
    get(this: Context) {
      return (this.update as any)[type];
    },
    configurable: true,
  });
}
