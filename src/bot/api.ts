import { createWriteStream, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError, TelegramError } from './errors.js';
import { applyFormatted } from './format.js';
import { ApiMethodsBase, type CallOptions } from './generated/methods.js';
import { PARSE_MODE_METHODS, type ApiMethods, type File } from './generated/types.js';
import { InputFile } from './input-file.js';
import { throttle, type ThrottleOptions } from './throttle.js';

export type ParseMode = 'HTML' | 'MarkdownV2' | 'Markdown';

/**
 * Hook around every API call. Call `next()` to continue; you may change method/params or the result.
 *
 * ```ts
 * bot.api.use(async (method, params, next) => {
 *   const t = Date.now();
 *   try { return await next(method, params); } finally { console.log(method, Date.now() - t, 'ms'); }
 * });
 * ```
 */
export type Transformer = (
  method: string,
  params: Record<string, unknown>,
  next: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  options: CallOptions,
) => Promise<unknown>;

export interface ApiOptions {
  /** Bot API server root. Use your own local server URL to lift the 50 MB upload limit. Default: https://api.telegram.org */
  apiRoot?: string;
  /** Use the Telegram test environment. */
  testEnv?: boolean;
  /** Default parse_mode for every method that supports it (sendMessage, sendPhoto captions, editMessageText...). */
  parseMode?: ParseMode;
  /** Retries on flood-wait (429) and server errors (5xx). Default: 3. Set 0 to disable. */
  maxRetries?: number;
  /** Do not auto-wait for flood control longer than this many seconds. Default: 60. */
  maxRetryAfter?: number;
  /** Per-request timeout in ms (getUpdates adds its long-poll timeout on top). Default: 60000. */
  timeout?: number;
  /** Space outgoing messages within Telegram limits to avoid 429 penalties. Default: true. */
  throttle?: boolean | ThrottleOptions;
  /** Не загружать повторно один и тот же файл с диска (использовать file_id). Default: true. */
  cacheFiles?: boolean;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

/** Low-level Bot API client: every method is available as `api.methodName({...})`. */
export class Api extends ApiMethodsBase {
  readonly options: Required<Omit<ApiOptions, 'parseMode' | 'throttle' | 'cacheFiles'>> & Pick<ApiOptions, 'parseMode'>;
  private readonly cacheFiles: boolean;
  private readonly base: string;
  private readonly transformers: Transformer[] = [];

  constructor(
    readonly token: string,
    options: ApiOptions = {},
  ) {
    super();
    if (!token) throw new Error('Bot token is required. Get one from @BotFather.');
    this.options = {
      apiRoot: (options.apiRoot ?? 'https://api.telegram.org').replace(/\/+$/, ''),
      testEnv: options.testEnv ?? false,
      parseMode: options.parseMode,
      maxRetries: options.maxRetries ?? 3,
      maxRetryAfter: options.maxRetryAfter ?? 60,
      timeout: options.timeout ?? 60_000,
    };
    this.base = `${this.options.apiRoot}/bot${token}${this.options.testEnv ? '/test' : ''}/`;
    if (options.throttle !== false) this.use(throttle(options.throttle === true ? {} : options.throttle));
    this.cacheFiles = options.cacheFiles ?? true;
  }

  /** Adds a transformer (middleware around API calls). */
  use(...transformers: Transformer[]): this {
    this.transformers.push(...transformers);
    return this;
  }

  override call<M extends keyof ApiMethods>(
    method: M,
    params?: Parameters<ApiMethods[M]>[0],
    options: CallOptions = {},
  ): Promise<ReturnType<ApiMethods[M]>> {
    let p = applyFormatted(params ?? {}) as Record<string, unknown>;
    if (this.options.parseMode && p.parse_mode === undefined && PARSE_MODE_METHODS.has(method)) {
      p = { ...p, parse_mode: this.options.parseMode };
    }
    const fileField = FILE_FIELDS[method];
    let cacheKey: string | undefined;
    if (fileField && this.fileCacheEnabled) {
      cacheKey = fileKey(method, p[fileField]);
      const cached = cacheKey && this.fileCache.get(cacheKey);
      if (cached) {
        p = { ...p, [fileField]: cached };
        cacheKey = undefined;
      }
    }
    const run = (i: number) => (m: string, prm: Record<string, unknown>): Promise<unknown> =>
      i < this.transformers.length ? this.transformers[i](m, prm, run(i + 1), options) : this.request(m, prm, options);
    const result = run(0)(method, p);
    if (cacheKey) {
      const key = cacheKey;
      void result.then((r: any) => {
        const media = r?.[fileField!];
        const id = Array.isArray(media) ? media[media.length - 1]?.file_id : media?.file_id;
        if (typeof id === 'string') {
          this.fileCache.set(key, id);
          if (this.fileCache.size > 10_000) this.fileCache.delete(this.fileCache.keys().next().value!);
        }
      }, () => {});
    }
    return result as Promise<ReturnType<ApiMethods[M]>>;
  }

  /** Повторная отправка того же файла с диска использует file_id вместо новой загрузки. */
  private readonly fileCache = new Map<string, string>();
  private get fileCacheEnabled(): boolean {
    return this.cacheFiles;
  }

  /** Raw request with retries. Prefer `call` or the typed methods. */
  async request(method: string, params: Record<string, unknown>, options: CallOptions = {}): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce(method, params, options);
      } catch (err) {
        if (attempt >= this.options.maxRetries || options.signal?.aborted) throw err;
        if (err instanceof TelegramError) {
          if (err.code === 429 && err.retryAfter !== undefined && err.retryAfter <= this.options.maxRetryAfter) {
            await sleep(err.retryAfter * 1000, options.signal);
            continue;
          }
          if (err.code >= 500) {
            await sleep(500 * 2 ** attempt, options.signal);
            continue;
          }
        }
        throw err;
      }
    }
  }

  private async requestOnce(method: string, params: Record<string, unknown>, options: CallOptions): Promise<unknown> {
    const longPoll = method === 'getUpdates' ? Number(params.timeout ?? 0) * 1000 : 0;
    const timeout = AbortSignal.timeout(this.options.timeout + longPoll);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetch(this.base + method, { method: 'POST', signal, ...(await encode(params)) });
    } catch (err) {
      if (options.signal?.aborted) throw options.signal.reason;
      throw new HttpError(method, err);
    }

    let data: { ok: boolean; result?: unknown; error_code?: number; description?: string; parameters?: object };
    try {
      data = (await res.json()) as typeof data;
    } catch (err) {
      throw new TelegramError(method, res.status, `Invalid response (${res.statusText})`);
    }
    if (!data.ok) throw new TelegramError(method, data.error_code ?? res.status, data.description ?? 'Unknown error', data.parameters);
    return data.result;
  }

  /** Direct download URL for a file (from getFile). Never share it: it contains the bot token. */
  fileUrl(filePath: string): string {
    return `${this.options.apiRoot}/file/bot${this.token}${this.options.testEnv ? '/test' : ''}/${filePath}`;
  }

  /**
   * Downloads a file by file_id (or File object).
   * With `dest` the file is streamed to disk and the path is returned; otherwise a Buffer is returned.
   */
  async download(file: string | File, dest: string): Promise<string>;
  async download(file: string | File): Promise<Buffer>;
  async download(file: string | File, dest?: string): Promise<Buffer | string> {
    const info = typeof file === 'string' || !file.file_path ? await this.getFile({ file_id: typeof file === 'string' ? file : file.file_id }) : file;
    if (!info.file_path) throw new Error('File is not available for download');
    // Local Bot API servers (--local) return absolute paths on their own disk.
    if (info.file_path.startsWith('/')) {
      const { readFile, copyFile } = await import('node:fs/promises');
      return dest ? (await copyFile(info.file_path, dest), dest) : readFile(info.file_path);
    }
    const res = await fetch(this.fileUrl(info.file_path));
    if (!res.ok || !res.body) throw new HttpError('download', new Error(`HTTP ${res.status}`));
    if (!dest) return Buffer.from(await res.arrayBuffer());
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
    return dest;
  }
}

const FILE_FIELDS: Record<string, string> = {
  sendPhoto: 'photo',
  sendVideo: 'video',
  sendDocument: 'document',
  sendAudio: 'audio',
  sendVoice: 'voice',
  sendAnimation: 'animation',
  sendSticker: 'sticker',
  sendVideoNote: 'video_note',
};

/** Cache key for a local file (path + size + mtime), or undefined for other sources. */
function fileKey(method: string, value: unknown): string | undefined {
  if (!(value instanceof InputFile)) return undefined;
  const s = value.source;
  const path = typeof s === 'string' ? s : s instanceof URL && s.protocol === 'file:' ? fileURLToPath(s) : undefined;
  if (!path) return undefined;
  try {
    const st = statSync(path);
    return `${method}\u0000${resolvePath(path)}\u0000${st.size}\u0000${st.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/** Encodes params as JSON, or multipart/form-data when any InputFile is present (anywhere, nested included). */
async function encode(params: Record<string, unknown>): Promise<{ body: string | FormData; headers?: Record<string, string> }> {
  if (!hasFile(params)) {
    return { body: JSON.stringify(params), headers: { 'content-type': 'application/json' } };
  }
  const form = new FormData();
  const files: Array<[string, InputFile]> = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (value instanceof InputFile) {
      files.push([key, value]);
    } else if (typeof value === 'object') {
      form.append(key, JSON.stringify(value, (_k, v) => {
        if (v instanceof InputFile) {
          const name = `file${files.length}`;
          files.push([name, v]);
          return `attach://${name}`;
        }
        return v;
      }));
    } else {
      form.append(key, String(value));
    }
  }
  const blobs = await Promise.all(files.map(([, f]) => f.toBlob()));
  files.forEach(([name, f], i) => form.append(name, blobs[i], f.filename));
  return { body: form };
}

function hasFile(v: unknown): boolean {
  if (v instanceof InputFile) return true;
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some(hasFile);
  for (const k in v) if (hasFile((v as Record<string, unknown>)[k])) return true;
  return false;
}
