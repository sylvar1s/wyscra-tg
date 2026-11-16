import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Readable } from 'node:stream';

export type InputFileSource =
  | string // local path
  | URL // file:// path or http(s) URL to download and re-upload
  | Buffer
  | Uint8Array
  | ArrayBuffer
  | Blob
  | Readable
  | AsyncIterable<Uint8Array>
  | ReadableStream<Uint8Array>;

/**
 * A file to upload.
 *
 * ```ts
 * new InputFile('./cat.jpg')
 * new InputFile(buffer, 'report.pdf')
 * new InputFile(fs.createReadStream('video.mp4'))
 * new InputFile(new URL('https://example.com/img.png'))
 * ```
 *
 * To send a file that already exists on Telegram servers, pass its file_id string instead.
 */
export class InputFile {
  readonly filename: string;

  constructor(
    readonly source: InputFileSource,
    filename?: string,
  ) {
    this.filename = filename ?? guessName(source);
  }

  /** Shorthand for `new InputFile(...)`. */
  static from(source: InputFileSource, filename?: string): InputFile {
    return new InputFile(source, filename);
  }

  /** Converts the source to a Blob for multipart upload. Local files are streamed from disk, not buffered. */
  async toBlob(): Promise<Blob> {
    const s = this.source;
    if (typeof s === 'string') return openAsBlob(s);
    if (s instanceof URL) {
      if (s.protocol === 'file:') return openAsBlob(s);
      const res = await fetch(s);
      if (!res.ok) throw new Error(`InputFile: download of ${s} failed with ${res.status}`);
      return res.blob();
    }
    if (s instanceof Blob) return s;
    if (s instanceof Uint8Array) return new Blob([s]);
    if (s instanceof ArrayBuffer) return new Blob([s]);
    // Streams: Telegram needs a Content-Length per part, so collect chunks.
    const chunks: Uint8Array[] = [];
    const iterable: AsyncIterable<Uint8Array> =
      s instanceof ReadableStream ? (Readable.fromWeb(s as never) as AsyncIterable<Uint8Array>) : s;
    for await (const chunk of iterable) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    return new Blob(chunks);
  }
}

function guessName(source: InputFileSource): string {
  if (typeof source === 'string') return basename(source);
  if (source instanceof URL) return basename(source.pathname) || 'file';
  const s = source as { path?: unknown; name?: unknown };
  if (typeof s.path === 'string') return basename(s.path);
  if (typeof s.name === 'string' && s.name) return s.name;
  return 'file';
}
