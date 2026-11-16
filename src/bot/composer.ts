import { Context, MESSAGE_UPDATES, type CamelCase } from './context.js';
import { UPDATE_TYPES, type Chat, type Message, type Update, type UpdateType } from './generated/types.js';

export type NextFn = () => Promise<void>;
export type Middleware<C extends Context = Context> = (ctx: C, next: NextFn) => unknown;
export type Handler<C extends Context = Context> = (ctx: C, next: NextFn) => unknown;

type MessageField = Exclude<keyof Message, 'message_id' | 'date' | 'chat'>;
type MessageUpdate = (typeof MESSAGE_UPDATES)[number];

/**
 * Filter query for `bot.on`:
 * - `'message'`, `'callback_query'`, `'chat_member'`… — an update type
 * - `'message:photo'`, `'callback_query:data'` — update type + field that must be present
 * - `'photo'`, `'text'`, `'voice'`… — shorthand: a new message (private, group, channel or business) with that field
 * - `'message:entities:url'` — message with an entity of this type
 */
export type FilterQuery = UpdateType | `${UpdateType}:${string}` | MessageField | `:${MessageField}`;

type WithMsg<M> = { readonly msg: M; readonly chat: Chat; readonly chatId: number };
type Has<T, F extends PropertyKey> = T & { [K in F & keyof T]-?: NonNullable<T[K]> };

/** Context type narrowed by a filter query, so `ctx.message.text` etc. are known to exist. */
export type Filtered<C extends Context, Q extends string> = Q extends UpdateType
  ? C & { readonly [K in CamelCase<Q>]: NonNullable<Update[Q]> } & (Q extends MessageUpdate ? WithMsg<Message> : {})
  : Q extends `${infer U extends UpdateType}:${infer F}`
    ? U extends MessageUpdate
      ? F extends `${infer F1}:${string}`
        ? C & { readonly [K in CamelCase<U>]: Has<Message, F1> } & WithMsg<Has<Message, F1>>
        : C & { readonly [K in CamelCase<U>]: Has<Message, F> } & WithMsg<Has<Message, F>> & (F extends 'text' | 'caption' ? { readonly text: string } : {})
      : C & { readonly [K in CamelCase<U>]: Has<NonNullable<Update[U]>, F> }
    : Q extends `${'' | ':'}${infer F extends MessageField}`
      ? C & WithMsg<Has<Message, F>> & (F extends 'text' | 'caption' ? { readonly text: string } : {})
      : C;

const SHORTHAND_UPDATES: readonly UpdateType[] = ['message', 'channel_post', 'business_message'];
const UPDATE_SET = new Set<string>(UPDATE_TYPES);

/** Compiles a filter query into a fast predicate (done once per handler, not per update). */
export function compileFilter(query: string): (ctx: Context) => boolean {
  const parts = query.split(':');
  let types: readonly string[];
  let field: string | undefined;
  let sub: string | undefined;
  if (UPDATE_SET.has(parts[0])) {
    types = [parts[0]];
    [, field, sub] = parts;
  } else {
    types = parts[0] === '' ? MESSAGE_UPDATES : SHORTHAND_UPDATES;
    [field, sub] = parts[0] === '' ? parts.slice(1) : parts;
  }
  if (!field) return (ctx) => types.includes(ctx.updateType);
  return (ctx) => {
    if (!types.includes(ctx.updateType)) return false;
    const value = ctx.payload?.[field!];
    if (value === undefined || value === null) return false;
    if (!sub) return true;
    if (field === 'entities' || field === 'caption_entities') {
      return (value as Array<{ type: string }>).some((e) => e.type === sub);
    }
    return Array.isArray(value) ? value.some((x) => x?.type === sub) : value?.[sub] !== undefined;
  };
}

export type Trigger = string | RegExp | Array<string | RegExp> | ((value: string, ctx: Context) => boolean);

function matchTrigger(trigger: Trigger, value: string | undefined, ctx: Context): boolean {
  if (value === undefined) return false;
  const list = Array.isArray(trigger) ? trigger : [trigger];
  for (const t of list) {
    if (typeof t === 'function') {
      if (t(value, ctx)) return true;
    } else if (typeof t === 'string') {
      if (t === value) {
        ctx.match = Object.assign([value], { index: 0, input: value, groups: undefined }) as RegExpExecArray;
        return true;
      }
    } else {
      t.lastIndex = 0;
      const m = t.exec(value);
      if (m) {
        ctx.match = m;
        return true;
      }
    }
  }
  return false;
}

/** Runs a middleware chain. */
export function compose<C extends Context>(mws: Middleware<C>[]): Middleware<C> {
  if (mws.length === 0) return (_ctx, next) => next();
  if (mws.length === 1) return mws[0];
  return (ctx, last) => {
    let idx = -1;
    const run = async (i: number): Promise<void> => {
      if (i <= idx) throw new Error('next() called multiple times');
      idx = i;
      if (i === mws.length) return last();
      await mws[i](ctx, () => run(i + 1));
    };
    return run(0);
  };
}

/** Router. `Bot` extends it; you can also create standalone composers and `bot.use(composer)` them. */
export class Composer<C extends Context = Context> {
  protected readonly stack: Middleware<C>[] = [];
  private composed?: Middleware<C>;
  /** Commands registered with a description (for `setMyCommands`). */
  readonly commandList: Array<{ command: string; description: string }> = [];

  /** Adds middleware that runs for every update. */
  use(...mws: Array<Middleware<C> | Composer<C>>): this {
    this.composed = undefined;
    for (const mw of mws) {
      if (mw instanceof Composer) {
        this.commandList.push(...mw.commandList);
        this.stack.push(mw.middleware());
      } else {
        this.stack.push(mw);
      }
    }
    return this;
  }

  /** The combined middleware of this composer. */
  middleware(): Middleware<C> {
    return (ctx, next) => (this.composed ??= compose(this.stack))(ctx, next);
  }

  /** Runs handlers only when `predicate` is true. */
  filter<D extends C = C>(predicate: ((ctx: C) => ctx is D) | ((ctx: C) => unknown), ...handlers: Handler<D>[]): this {
    const h = compose(handlers as Middleware<C>[]);
    return this.use(async (ctx, next) => ((await predicate(ctx)) ? h(ctx, next) : next()));
  }

  /** Runs `yes` or `no` depending on the predicate. */
  branch(predicate: (ctx: C) => unknown, yes: Handler<C>, no: Handler<C>): this {
    return this.use(async (ctx, next) => ((await predicate(ctx)) ? yes(ctx, next) : no(ctx, next)));
  }

  /**
   * Handles updates matching a filter query (see {@link FilterQuery}).
   * ```ts
   * bot.on('photo', ctx => ctx.reply('Nice photo'));
   * bot.on('callback_query:data', ctx => ctx.answer(ctx.callbackData));
   * bot.on(['voice', 'video_note'], ctx => ...);
   * ```
   */
  on<Q extends FilterQuery>(query: Q | Q[], ...handlers: Handler<Filtered<C, Q>>[]): this {
    const preds = (Array.isArray(query) ? query : [query]).map(compileFilter);
    const pred = preds.length === 1 ? preds[0] : (ctx: Context) => preds.some((p) => p(ctx));
    return this.filter(pred, ...(handlers as Handler<C>[]));
  }

  /**
   * Handles a command. Matches `/name`, `/name@your_bot` and `/name args`.
   * Pass a description to have it shown in Telegram's command menu (synced on `bot.start()`).
   * ```ts
   * bot.command('start', 'Start the bot', ctx => ctx.reply(`Payload: ${ctx.args}`));
   * ```
   */
  command(command: string | string[], ...handlers: Handler<Filtered<C, 'message:text'>>[]): this;
  command(command: string | string[], description: string, ...handlers: Handler<Filtered<C, 'message:text'>>[]): this;
  command(command: string | string[], ...rest: unknown[]): this {
    const names = (Array.isArray(command) ? command : [command]).map((c) => c.replace(/^\//, '').toLowerCase());
    if (typeof rest[0] === 'string') {
      const description = rest.shift() as string;
      for (const name of names) this.commandList.push({ command: name, description });
    }
    const handlers = rest as Handler<C>[];
    return this.filter((ctx) => {
      if (!(MESSAGE_UPDATES as readonly string[]).includes(ctx.updateType) || ctx.updateType.startsWith('edited')) return false;
      const e = ctx.entities[0];
      if (!e || e.type !== 'bot_command' || e.offset !== 0) return false;
      const [name, target] = (ctx.text ?? '').slice(1, e.length).toLowerCase().split('@');
      if (target && ctx.me && target !== ctx.me.username?.toLowerCase()) return false;
      if (!names.includes(name)) return false;
      const args = ctx.args;
      ctx.match = Object.assign([args, ...args.split(/\s+/).filter(Boolean)], { index: 0, input: args, groups: undefined }) as RegExpExecArray;
      return true;
    }, ...handlers);
  }

  /** `/start <payload>` handler (deep links). */
  start(...handlers: Handler<Filtered<C, 'message:text'>>[]): this {
    return this.command('start', ...handlers);
  }

  /** Handles messages whose text/caption matches a string, regex or list (`ctx.match` holds the groups). */
  hears(trigger: Trigger, ...handlers: Handler<Filtered<C, ':text'>>[]): this {
    return this.filter(
      (ctx) => (MESSAGE_UPDATES as readonly string[]).includes(ctx.updateType) && matchTrigger(trigger, ctx.text, ctx),
      ...(handlers as Handler<C>[]),
    );
  }

  /**
   * Handles inline button presses by callback data. The spinner is auto-answered if you don't call `ctx.answer()`.
   * ```ts
   * bot.action(/^buy:(\d+)$/, ctx => ctx.answer(`Item ${ctx.match![1]}`));
   * ```
   */
  action(trigger: Trigger, ...handlers: Handler<Filtered<C, 'callback_query:data'>>[]): this {
    return this.filter((ctx) => matchTrigger(trigger, ctx.update.callback_query?.data, ctx), ...(handlers as Handler<C>[]));
  }

  /** Handles inline queries (`@your_bot query`) matching the trigger. */
  inlineQuery(trigger: Trigger, ...handlers: Handler<Filtered<C, 'inline_query'>>[]): this {
    return this.filter((ctx) => matchTrigger(trigger, ctx.update.inline_query?.query, ctx), ...(handlers as Handler<C>[]));
  }

  /** Handles game button presses by game short name. */
  gameQuery(trigger: Trigger, ...handlers: Handler<Filtered<C, 'callback_query:game_short_name'>>[]): this {
    return this.filter((ctx) => matchTrigger(trigger, ctx.update.callback_query?.game_short_name, ctx), ...(handlers as Handler<C>[]));
  }

  /** Handles messages that received a given reaction emoji. */
  reaction(emoji: string | string[], ...handlers: Handler<Filtered<C, 'message_reaction'>>[]): this {
    const list = Array.isArray(emoji) ? emoji : [emoji];
    return this.filter(
      (ctx) => !!ctx.update.message_reaction?.new_reaction.some((r) => r.type === 'emoji' && list.includes(r.emoji)),
      ...(handlers as Handler<C>[]),
    );
  }

  /** Limits handlers to chat types: `bot.chatType('private', ...)`. */
  chatType(type: Chat['type'] | Array<Chat['type']>, ...handlers: Handler<C>[]): this {
    const list = Array.isArray(type) ? type : [type];
    return this.filter((ctx) => !!ctx.chat && list.includes(ctx.chat.type), ...handlers);
  }

  /** Stops processing for updates matching the predicate. */
  drop(predicate: (ctx: C) => unknown): this {
    return this.use(async (ctx, next) => ((await predicate(ctx)) ? undefined : next()));
  }
}
