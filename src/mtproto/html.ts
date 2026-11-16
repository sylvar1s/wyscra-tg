import { Formatted } from '../bot/format.js';
import type { tl } from './generated/tl.js';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });

type Ent = tl.TypeMessageEntity | tl.InputMessageEntityMentionName;

/**
 * Parses Telegram-style HTML (the same subset as Bot API parse_mode=HTML) into text + entities.
 * Offsets are in UTF-16 code units, as MTProto expects.
 */
export function parseHtml(html: string): { text: string; entities: Ent[] } {
  let text = '';
  const entities: Ent[] = [];
  const stack: Array<{ tag: string; offset: number; attrs: Record<string, string> }> = [];
  const re = /<(\/?)([a-z-]+)((?:\s+[a-z-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)|(<)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[4] !== undefined || m[5] !== undefined) {
      text += decode(m[4] ?? m[5]);
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (tag === 'br') {
      text += '\n';
      continue;
    }
    if (!closing) {
      const attrs: Record<string, string> = {};
      for (const a of m[3].matchAll(/([a-z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gi)) {
        attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
      }
      stack.push({ tag, offset: text.length, attrs });
      continue;
    }
    const idx = stack.map((s) => s.tag).lastIndexOf(tag);
    if (idx < 0) continue;
    const [open] = stack.splice(idx, 1);
    const offset = open.offset;
    const length = text.length - offset;
    if (length <= 0) continue;
    const base = { offset, length };
    const a = open.attrs;
    switch (tag) {
      case 'b': case 'strong': entities.push({ _: 'messageEntityBold', ...base }); break;
      case 'i': case 'em': entities.push({ _: 'messageEntityItalic', ...base }); break;
      case 'u': case 'ins': entities.push({ _: 'messageEntityUnderline', ...base }); break;
      case 's': case 'strike': case 'del': entities.push({ _: 'messageEntityStrike', ...base }); break;
      case 'tg-spoiler': entities.push({ _: 'messageEntitySpoiler', ...base }); break;
      case 'span':
        if (a.class === 'tg-spoiler') entities.push({ _: 'messageEntitySpoiler', ...base });
        break;
      case 'blockquote': entities.push({ _: 'messageEntityBlockquote', ...base, collapsed: 'expandable' in a }); break;
      case 'code': {
        const parent = stack[stack.length - 1];
        if (parent?.tag === 'pre') parent.attrs.language = (a.class ?? '').replace(/^language-/, '');
        else entities.push({ _: 'messageEntityCode', ...base });
        break;
      }
      case 'pre': entities.push({ _: 'messageEntityPre', ...base, language: a.language ?? '' }); break;
      case 'tg-emoji': if (a['emoji-id']) entities.push({ _: 'messageEntityCustomEmoji', ...base, document_id: BigInt(a['emoji-id']) }); break;
      case 'a': {
        const href = a.href ?? '';
        const mention = /^tg:\/\/user\?id=(\d+)$/.exec(href);
        if (mention) entities.push({ _: 'inputMessageEntityMentionName', ...base, user_id: { _: 'inputUser', user_id: BigInt(mention[1]), access_hash: 0n } });
        else entities.push({ _: 'messageEntityTextUrl', ...base, url: href });
        break;
      }
    }
  }
  entities.sort((x, y) => x.offset - y.offset);
  return { text, entities };
}

/** Text for sending: plain string, or Formatted (html``) converted to entities. */
export function toMessage(text: string | Formatted, parseMode?: 'html'): { message: string; entities?: Ent[] } {
  if (text instanceof Formatted) {
    if (text.parseMode !== 'HTML') throw new Error('MTProto client supports html`` formatting (MarkdownV2 is Bot API only)');
    const r = parseHtml(text.text);
    return { message: r.text, entities: r.entities };
  }
  if (parseMode === 'html') {
    const r = parseHtml(text);
    return { message: r.text, entities: r.entities };
  }
  return { message: text };
}
