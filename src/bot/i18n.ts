import { readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

/** Перевод: строка с {переменными} или формы множественного числа. */
export type Translation = string | { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string };
export type Locale = { [key: string]: Translation | Locale };

export interface I18nOptions {
  /** Переводы: `{ ru: { hello: 'Привет, {name}!' }, en: {...} }` или путь к папке с файлами ru.json, en.json. */
  locales: Record<string, Locale> | string;
  /** Язык по умолчанию (если у пользователя другой и перевода нет). Default: первый из списка. */
  defaultLocale?: string;
}

/**
 * Переводы.
 * ```json
 * // locales/ru.json
 * { "hello": "Привет, {name}!", "apples": { "one": "{count} яблоко", "few": "{count} яблока", "many": "{count} яблок" } }
 * ```
 */
export class I18n {
  readonly locales: Record<string, Locale>;
  readonly defaultLocale: string;
  private readonly plurals = new Map<string, Intl.PluralRules>();

  constructor(options: I18nOptions) {
    if (typeof options.locales === 'string') {
      const dir = options.locales;
      this.locales = {};
      for (const f of readdirSync(dir)) {
        if (extname(f) !== '.json') continue;
        this.locales[basename(f, '.json')] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      }
    } else {
      this.locales = options.locales;
    }
    const names = Object.keys(this.locales);
    if (!names.length) throw new Error('i18n: нет ни одного языка');
    this.defaultLocale = options.defaultLocale ?? names[0];
  }

  /** Подходящий язык: 'ru-RU' → 'ru', иначе язык по умолчанию. */
  resolve(lang?: string): string {
    if (lang && this.locales[lang]) return lang;
    const short = lang?.split(/[-_]/)[0];
    if (short && this.locales[short]) return short;
    return this.defaultLocale;
  }

  private lookup(locale: string, key: string): Translation | undefined {
    let node: any = this.locales[locale];
    for (const part of key.split('.')) {
      node = node?.[part];
      if (node === undefined) return undefined;
    }
    return typeof node === 'string' || (node && typeof node.other === 'string') ? node : undefined;
  }

  /** Перевод по ключу ('menu.title'), с подстановкой {переменных}. Число в `count` выбирает форму множественного числа. */
  t(locale: string, key: string, vars: Record<string, unknown> = {}): string {
    const loc = this.resolve(locale);
    const tr = this.lookup(loc, key) ?? this.lookup(this.defaultLocale, key);
    if (tr === undefined) return key;
    let text: string;
    if (typeof tr === 'string') text = tr;
    else {
      const count = Number(vars.count ?? 0);
      let rules = this.plurals.get(loc);
      if (!rules) this.plurals.set(loc, (rules = new Intl.PluralRules(loc)));
      const form = count === 0 && tr.zero !== undefined ? 'zero' : rules.select(count);
      text = (tr as any)[form] ?? tr.other;
    }
    return text.replace(/\{(\w+)\}/g, (m, name: string) => (vars[name] === undefined ? m : String(vars[name])));
  }

  /** Список языков. */
  get languages(): string[] {
    return Object.keys(this.locales);
  }
}
