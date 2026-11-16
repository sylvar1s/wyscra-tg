import type { ParseMode } from './api.js';

/**
 * Text with a parse mode attached. Pass it anywhere a text/caption is expected and
 * the right `parse_mode` is set automatically — no need to remember it.
 */
export class Formatted {
  constructor(
    readonly text: string,
    readonly parseMode: ParseMode,
  ) {}
  toString(): string {
    return this.text;
  }
  toJSON(): string {
    return this.text;
  }
}

const HTML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
/** Escapes text for parse_mode HTML. */
export const escapeHtml = (s: unknown): string => String(s).replace(/[&<>"]/g, (c) => HTML_ESC[c]);
/** Escapes text for parse_mode MarkdownV2. */
export const escapeMarkdown = (s: unknown): string => String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');

const piece = (v: unknown, mode: ParseMode): string => {
  if (v instanceof Formatted) return v.text;
  if (Array.isArray(v)) return v.map((x) => piece(x, mode)).join('');
  if (v === undefined || v === null || v === false) return '';
  return mode === 'HTML' ? escapeHtml(v) : escapeMarkdown(v);
};

/**
 * HTML template: interpolated values are escaped automatically.
 * ```ts
 * ctx.reply(html`Hello, <b>${user.first_name}</b>!`)
 * ```
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Formatted {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += piece(values[i], 'HTML') + strings[i + 1];
  return new Formatted(out, 'HTML');
}

/** MarkdownV2 template: interpolated values are escaped automatically. */
export function md(strings: TemplateStringsArray, ...values: unknown[]): Formatted {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += piece(values[i], 'MarkdownV2') + strings[i + 1];
  return new Formatted(out, 'MarkdownV2');
}

const tag = (open: string, close: string) => (text: unknown) => new Formatted(open + piece(text, 'HTML') + close, 'HTML');

/** HTML formatting helpers. Combine with the `html` template or use on their own. */
export const fmt = {
  bold: tag('<b>', '</b>'),
  italic: tag('<i>', '</i>'),
  underline: tag('<u>', '</u>'),
  strike: tag('<s>', '</s>'),
  spoiler: tag('<tg-spoiler>', '</tg-spoiler>'),
  code: tag('<code>', '</code>'),
  quote: tag('<blockquote>', '</blockquote>'),
  expandableQuote: tag('<blockquote expandable>', '</blockquote>'),
  pre: (text: unknown, language?: string) =>
    new Formatted(
      language ? `<pre><code class="language-${escapeHtml(language)}">${piece(text, 'HTML')}</code></pre>` : `<pre>${piece(text, 'HTML')}</pre>`,
      'HTML',
    ),
  link: (text: unknown, url: string) => new Formatted(`<a href="${escapeHtml(url)}">${piece(text, 'HTML')}</a>`, 'HTML'),
  mention: (text: unknown, userId: number) => new Formatted(`<a href="tg://user?id=${userId}">${piece(text, 'HTML')}</a>`, 'HTML'),
  customEmoji: (emoji: string, id: string) => new Formatted(`<tg-emoji emoji-id="${escapeHtml(id)}">${escapeHtml(emoji)}</tg-emoji>`, 'HTML'),
  /** Joins pieces (escaping plain strings) into one HTML text. */
  join: (parts: unknown[], separator: unknown = '') =>
    new Formatted(parts.map((p) => piece(p, 'HTML')).join(piece(separator, 'HTML')), 'HTML'),
};

/** Replaces Formatted values in params with strings and sets the matching *parse_mode fields. */
export function applyFormatted(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = applyFormatted(v);
      if (r !== v) changed = true;
      return r;
    });
    return changed ? out : value;
  }
  if (value === null || typeof value !== 'object' || value.constructor !== Object) return value;
  let out: Record<string, unknown> | undefined;
  for (const [k, v] of Object.entries(value)) {
    let next: unknown = v;
    if (v instanceof Formatted) {
      next = v.text;
      const pm = k === 'text' || k === 'caption' ? 'parse_mode' : `${k}_parse_mode`;
      out ??= { ...value };
      if (out[pm] === undefined) out[pm] = v.parseMode;
    } else if (v !== null && typeof v === 'object') {
      next = applyFormatted(v);
    }
    if (next !== v) {
      out ??= { ...value };
      out[k] = next;
    }
  }
  return out ?? value;
}
