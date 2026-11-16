import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import type { Chat, User } from './generated/types.js';

/** Данные, которые мини-приложение получает при открытии (Telegram.WebApp.initData), после проверки. */
export interface WebAppData {
  user?: User & { allows_write_to_pm?: boolean; photo_url?: string };
  receiver?: User;
  chat?: Chat;
  chat_type?: string;
  chat_instance?: string;
  start_param?: string;
  query_id?: string;
  can_send_after?: number;
  auth_date: number;
  hash: string;
  signature?: string;
  /** Все поля как пришли (строки). */
  raw: Record<string, string>;
}

export interface ValidateOptions {
  /** Максимальный возраст данных в секундах. Default: 86400 (сутки). 0 — не проверять. */
  maxAge?: number;
}

function parse(initData: string): Record<string, string> {
  const params = new URLSearchParams(initData.startsWith('?') ? initData.slice(1) : initData);
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

const safeEqualHex = (a: string, b: string) => {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

function finish(raw: Record<string, string>, maxAge: number): WebAppData {
  const authDate = Number(raw.auth_date);
  if (!authDate) throw new Error('initData: нет auth_date');
  if (maxAge && Date.now() / 1000 - authDate > maxAge) throw new Error('initData: данные устарели');
  const data: any = { raw };
  for (const [k, v] of Object.entries(raw)) {
    data[k] = ['user', 'receiver', 'chat'].includes(k) ? JSON.parse(v) : k === 'auth_date' || k === 'can_send_after' ? Number(v) : v;
  }
  return data as WebAppData;
}

/**
 * Проверяет данные мини-приложения (Telegram.WebApp.initData) на сервере.
 * Возвращает данные с пользователем или выбрасывает ошибку, если они поддельные или устарели.
 * ```ts
 * app.post('/api/me', (req, res) => {
 *   const { user } = validateWebAppData(req.headers.authorization, process.env.BOT_TOKEN);
 *   res.json({ hello: user.first_name });
 * });
 * ```
 */
export function validateWebAppData(initData: string, botToken: string, options: ValidateOptions = {}): WebAppData {
  if (!initData) throw new Error('initData: пусто');
  const raw = parse(initData);
  const hash = raw.hash;
  if (!hash) throw new Error('initData: нет hash');
  const checkString = Object.keys(raw)
    .filter((k) => k !== 'hash')
    .sort()
    .map((k) => `${k}=${raw[k]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(checkString).digest('hex');
  if (!safeEqualHex(expected, hash)) throw new Error('initData: неверная подпись (данные поддельные)');
  return finish(raw, options.maxAge ?? 86400);
}

/** Публичные ключи Telegram для проверки поля signature (из документации Mini Apps). */
const TELEGRAM_ED25519 = {
  production: 'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d',
  test: '40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec',
};

/**
 * Проверка initData без токена бота (для сторонних сервисов): по полю signature и id бота.
 */
export function validateWebAppSignature(initData: string, botId: number, options: ValidateOptions & { testEnv?: boolean; publicKey?: string } = {}): WebAppData {
  const raw = parse(initData);
  if (!raw.signature) throw new Error('initData: нет signature');
  const checkString =
    `${botId}:WebAppData\n` +
    Object.keys(raw)
      .filter((k) => k !== 'hash' && k !== 'signature')
      .sort()
      .map((k) => `${k}=${raw[k]}`)
      .join('\n');
  const keyHex = options.publicKey ?? (options.testEnv ? TELEGRAM_ED25519.test : TELEGRAM_ED25519.production);
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(keyHex, 'hex').toString('base64url') }, format: 'jwk' });
  const ok = verify(null, Buffer.from(checkString), key, Buffer.from(raw.signature, 'base64url'));
  if (!ok) throw new Error('initData: неверная подпись signature');
  return finish(raw, options.maxAge ?? 86400);
}

/** Данные виджета «Войти через Telegram» после проверки. */
export interface LoginWidgetData {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

/**
 * Проверяет данные Telegram Login Widget (вход на сайт через Telegram).
 * Принимает объект из колбэка виджета или query-строку редиректа.
 */
export function checkLoginWidget(data: Record<string, unknown> | string, botToken: string, options: ValidateOptions = {}): LoginWidgetData {
  const raw: Record<string, string> = typeof data === 'string' ? parse(data) : Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
  if (!raw.hash) throw new Error('Login Widget: нет hash');
  const checkString = Object.keys(raw)
    .filter((k) => k !== 'hash')
    .sort()
    .map((k) => `${k}=${raw[k]}`)
    .join('\n');
  const secret = createHash('sha256').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(checkString).digest('hex');
  if (!safeEqualHex(expected, raw.hash)) throw new Error('Login Widget: неверная подпись (данные поддельные)');
  const authDate = Number(raw.auth_date);
  const maxAge = options.maxAge ?? 86400;
  if (maxAge && Date.now() / 1000 - authDate > maxAge) throw new Error('Login Widget: данные устарели');
  return { ...raw, id: Number(raw.id), auth_date: authDate } as unknown as LoginWidgetData;
}
