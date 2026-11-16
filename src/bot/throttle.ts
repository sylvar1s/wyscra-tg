import type { Transformer } from './api.js';

export interface ThrottleOptions {
  /** Messages per second across all chats (Telegram: ~30). Default: 30. */
  global?: number;
  /** Messages per second in one private chat (Telegram: ~1). Default: 1. */
  perChat?: number;
  /** Short burst allowed in a private chat before spacing kicks in. Default: 3. */
  perChatBurst?: number;
  /** Messages per minute in one group/channel (Telegram: 20). Default: 20. */
  perGroupPerMinute?: number;
}

/** Reservation-based token bucket: callers are served in order and told how long to wait. */
class Bucket {
  private tokens: number;
  private last = Date.now();
  constructor(
    readonly capacity: number,
    readonly perSec: number,
  ) {
    this.tokens = capacity;
  }
  reserve(n: number): number {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSec);
    this.last = now;
    this.tokens -= n;
    return this.tokens >= 0 ? 0 : (-this.tokens / this.perSec) * 1000;
  }
  idle(now: number): boolean {
    return this.tokens + ((now - this.last) / 1000) * this.perSec >= this.capacity;
  }
}

const MESSAGE_METHODS = /^(send(?!ChatAction)|copyMessages?$|forwardMessages?$)/;

/**
 * Spaces outgoing messages to stay inside Telegram's limits, so the bot doesn't get 429 penalties.
 * Enabled by default in `Bot`; pass `throttle: false` to disable or an object to tune.
 */
export function throttle(options: ThrottleOptions = {}): Transformer {
  const global = new Bucket(options.global ?? 30, options.global ?? 30);
  const perChat = options.perChat ?? 1;
  const burst = options.perChatBurst ?? 3;
  const groupPerMin = options.perGroupPerMinute ?? 20;
  const chats = new Map<string, Bucket>();

  const chatBucket = (chatId: unknown): Bucket | undefined => {
    if (chatId === undefined || chatId === null) return undefined;
    const key = String(chatId);
    let b = chats.get(key);
    if (!b) {
      if (chats.size > 50_000) {
        const now = Date.now();
        for (const [k, v] of chats) if (v.idle(now)) chats.delete(k);
      }
      const isGroup = key.startsWith('-') || key.startsWith('@');
      b = isGroup ? new Bucket(groupPerMin, groupPerMin / 60) : new Bucket(burst, perChat);
      chats.set(key, b);
    }
    return b;
  };

  return async (method, params, next) => {
    if (MESSAGE_METHODS.test(method)) {
      const count = method === 'sendMediaGroup' && Array.isArray(params.media) ? params.media.length : 1;
      const waits = [chatBucket(params.chat_id)?.reserve(count) ?? 0];
      if (!params.allow_paid_broadcast) waits.push(global.reserve(count));
      const wait = Math.max(...waits);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    return next(method, params);
  };
}
