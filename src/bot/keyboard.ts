import type {
  CopyTextButton,
  ForceReply,
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  KeyboardButton,
  KeyboardButtonPollType,
  KeyboardButtonRequestChat,
  KeyboardButtonRequestUsers,
  LoginUrl,
  ReplyKeyboardMarkup,
  ReplyKeyboardRemove,
  SwitchInlineQueryChosenChat,
} from './generated/types.js';

type InlineExtra = Omit<InlineKeyboardButton, 'text'>;
type ReplyExtra = Omit<KeyboardButton, 'text'>;

/**
 * Inline keyboard builder. Pass it straight to `reply_markup`.
 * ```ts
 * const kb = new InlineKeyboard().text('Yes', 'yes').text('No', 'no').row().url('Site', 'https://t.me');
 * ctx.reply('Sure?', { reply_markup: kb });
 * ```
 */
export class InlineKeyboard implements InlineKeyboardMarkup {
  readonly inline_keyboard: InlineKeyboardButton[][] = [[]];

  /** Creates a keyboard from rows of buttons (see `InlineKeyboard.button`). */
  static from(rows: InlineKeyboardButton[][] | InlineKeyboardButton[]): InlineKeyboard {
    const kb = new InlineKeyboard();
    kb.inline_keyboard.length = 0;
    for (const row of rows) kb.inline_keyboard.push(Array.isArray(row) ? row : [row]);
    return kb;
  }

  /** Button factories for use with `InlineKeyboard.from`. */
  static button = {
    text: (text: string, data: string = text, extra?: InlineExtra): InlineKeyboardButton => ({ text, callback_data: data, ...extra }),
    url: (text: string, url: string, extra?: InlineExtra): InlineKeyboardButton => ({ text, url, ...extra }),
    webApp: (text: string, url: string): InlineKeyboardButton => ({ text, web_app: { url } }),
    login: (text: string, loginUrl: string | LoginUrl): InlineKeyboardButton => ({
      text,
      login_url: typeof loginUrl === 'string' ? { url: loginUrl } : loginUrl,
    }),
    switchInline: (text: string, query = ''): InlineKeyboardButton => ({ text, switch_inline_query: query }),
    switchInlineCurrent: (text: string, query = ''): InlineKeyboardButton => ({ text, switch_inline_query_current_chat: query }),
    switchInlineChosen: (text: string, options: SwitchInlineQueryChosenChat = {}): InlineKeyboardButton => ({
      text,
      switch_inline_query_chosen_chat: options,
    }),
    copy: (text: string, copy: string | CopyTextButton): InlineKeyboardButton => ({
      text,
      copy_text: typeof copy === 'string' ? { text: copy } : copy,
    }),
    game: (text: string): InlineKeyboardButton => ({ text, callback_game: {} }),
    pay: (text: string): InlineKeyboardButton => ({ text, pay: true }),
  };

  private add(button: InlineKeyboardButton): this {
    this.inline_keyboard[this.inline_keyboard.length - 1].push(button);
    return this;
  }
  /** Callback button: pressing it sends `data` to the bot (handle with `bot.action`). */
  text(text: string, data?: string, extra?: InlineExtra): this {
    return this.add(InlineKeyboard.button.text(text, data, extra));
  }
  url(text: string, url: string, extra?: InlineExtra): this {
    return this.add(InlineKeyboard.button.url(text, url, extra));
  }
  webApp(text: string, url: string): this {
    return this.add(InlineKeyboard.button.webApp(text, url));
  }
  login(text: string, loginUrl: string | LoginUrl): this {
    return this.add(InlineKeyboard.button.login(text, loginUrl));
  }
  switchInline(text: string, query?: string): this {
    return this.add(InlineKeyboard.button.switchInline(text, query));
  }
  switchInlineCurrent(text: string, query?: string): this {
    return this.add(InlineKeyboard.button.switchInlineCurrent(text, query));
  }
  switchInlineChosen(text: string, options?: SwitchInlineQueryChosenChat): this {
    return this.add(InlineKeyboard.button.switchInlineChosen(text, options));
  }
  copy(text: string, copy: string | CopyTextButton): this {
    return this.add(InlineKeyboard.button.copy(text, copy));
  }
  game(text: string): this {
    return this.add(InlineKeyboard.button.game(text));
  }
  pay(text: string): this {
    return this.add(InlineKeyboard.button.pay(text));
  }
  /** Any custom button object. */
  button(button: InlineKeyboardButton): this {
    return this.add(button);
  }
  /** Starts a new row. */
  row(): this {
    if (this.inline_keyboard[this.inline_keyboard.length - 1].length) this.inline_keyboard.push([]);
    return this;
  }
  /** Re-flows all buttons into rows of `columns` buttons. */
  columns(columns: number): this {
    const all = this.inline_keyboard.flat();
    this.inline_keyboard.length = 0;
    for (let i = 0; i < all.length; i += columns) this.inline_keyboard.push(all.slice(i, i + columns));
    return this;
  }
  toJSON(): InlineKeyboardMarkup {
    return { inline_keyboard: this.inline_keyboard.filter((r) => r.length) };
  }
}

/**
 * Reply (custom) keyboard builder.
 * ```ts
 * ctx.reply('Choose', { reply_markup: new Keyboard().text('A').text('B').row().requestContact('Share phone').resized() });
 * ```
 */
export class Keyboard implements ReplyKeyboardMarkup {
  readonly keyboard: KeyboardButton[][] = [[]];
  is_persistent?: boolean;
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  input_field_placeholder?: string;
  selective?: boolean;

  static from(rows: Array<Array<string | KeyboardButton>> | Array<string | KeyboardButton>): Keyboard {
    const kb = new Keyboard();
    kb.keyboard.length = 0;
    for (const row of rows) {
      const r = Array.isArray(row) ? row : [row];
      kb.keyboard.push(r.map((b) => (typeof b === 'string' ? { text: b } : b)));
    }
    return kb;
  }

  /** `reply_markup` that hides the custom keyboard. */
  static remove(selective?: boolean): ReplyKeyboardRemove {
    return { remove_keyboard: true, selective };
  }

  /** `reply_markup` that forces the user to reply to the message. */
  static forceReply(placeholder?: string, selective?: boolean): ForceReply {
    return { force_reply: true, input_field_placeholder: placeholder, selective };
  }

  private add(button: KeyboardButton): this {
    this.keyboard[this.keyboard.length - 1].push(button);
    return this;
  }
  text(text: string, extra?: ReplyExtra): this {
    return this.add({ text, ...extra });
  }
  requestContact(text: string): this {
    return this.add({ text, request_contact: true });
  }
  requestLocation(text: string): this {
    return this.add({ text, request_location: true });
  }
  requestPoll(text: string, type?: KeyboardButtonPollType['type']): this {
    return this.add({ text, request_poll: { type } });
  }
  requestUsers(text: string, request: KeyboardButtonRequestUsers): this {
    return this.add({ text, request_users: request });
  }
  requestChat(text: string, request: KeyboardButtonRequestChat): this {
    return this.add({ text, request_chat: request });
  }
  webApp(text: string, url: string): this {
    return this.add({ text, web_app: { url } });
  }
  button(button: KeyboardButton): this {
    return this.add(button);
  }
  row(): this {
    if (this.keyboard[this.keyboard.length - 1].length) this.keyboard.push([]);
    return this;
  }
  columns(columns: number): this {
    const all = this.keyboard.flat();
    this.keyboard.length = 0;
    for (let i = 0; i < all.length; i += columns) this.keyboard.push(all.slice(i, i + columns));
    return this;
  }
  /** Fit the keyboard height to the buttons (recommended). */
  resized(value = true): this {
    this.resize_keyboard = value;
    return this;
  }
  oneTime(value = true): this {
    this.one_time_keyboard = value;
    return this;
  }
  persistent(value = true): this {
    this.is_persistent = value;
    return this;
  }
  placeholder(text: string): this {
    this.input_field_placeholder = text;
    return this;
  }
  selected(value = true): this {
    this.selective = value;
    return this;
  }
  toJSON(): ReplyKeyboardMarkup {
    const { keyboard, ...rest } = this;
    return { keyboard: keyboard.filter((r) => r.length), ...rest };
  }
}
