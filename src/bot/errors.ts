import type { ResponseParameters } from './generated/types.js';

/** Error returned by the Telegram Bot API (`ok: false`). */
export class TelegramError extends Error {
  override readonly name = 'TelegramError';

  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly parameters: ResponseParameters = {},
  ) {
    super(`${method}: ${code} ${description}`);
  }

  /** Seconds to wait before retrying (flood control), if any. */
  get retryAfter(): number | undefined {
    return this.parameters.retry_after;
  }

  /** New chat id when a group was migrated to a supergroup. */
  get migrateToChatId(): number | undefined {
    return this.parameters.migrate_to_chat_id;
  }

  /** True when the bot was blocked by the user / kicked from the chat. */
  get isForbidden(): boolean {
    return this.code === 403;
  }
}

/** Network-level failure (DNS, connection reset, timeout) while calling the Bot API. */
export class HttpError extends Error {
  override readonly name = 'HttpError';

  constructor(
    readonly method: string,
    override readonly cause: unknown,
  ) {
    super(`${method}: network error: ${(cause as Error)?.message ?? cause}`);
  }
}
