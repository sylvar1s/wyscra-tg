import { gunzipSync, gzipSync } from 'node:zlib';
import { SCHEMA } from '../generated/schema.js';
import { Reader, Writer } from './binary.js';

export const ID = {
  vector: 0x1cb5c415,
  boolTrue: 0x997275b5,
  boolFalse: 0xbc799737,
  gzipPacked: 0x3072cfa1,
  rpcResult: 0xf35c6d01,
  msgContainer: 0x73f1f8dc,
} as const;

type TypeDesc =
  | { k: 'int' | 'long' | 'double' | 'int128' | 'int256' | 'string' | 'bytes' | 'bool' | 'true' | 'object' | 'flags' }
  | { k: 'vector'; bare: boolean; of: TypeDesc }
  | { k: 'bare'; entry: Entry };

interface Param {
  name: string;
  t: TypeDesc;
  flag?: { field: string; bit: number };
}

export interface Entry {
  id: number;
  name: string;
  method: boolean;
  type: string;
  raw: string;
  _params?: Param[];
  _result?: TypeDesc;
}

const byId = new Map<number, Entry>();
const byName = new Map<string, Entry>();
const ctorsByType = new Map<string, Entry[]>();
for (const [id, name, method, type, raw] of SCHEMA) {
  const e: Entry = { id, name, method: method === 1, type, raw };
  if (!e.method) {
    byId.set(id, e);
    const list = ctorsByType.get(type);
    if (list) list.push(e);
    else ctorsByType.set(type, [e]);
  }
  byName.set(name, e);
}

export const getEntry = (name: string): Entry | undefined => byName.get(name);
export const getEntryById = (id: number): Entry | undefined => byId.get(id);

function parseType(t: string): TypeDesc {
  const vec = /^([Vv])ector<(.+)>$/.exec(t);
  if (vec) return { k: 'vector', bare: vec[1] === 'v', of: parseType(vec[2]) };
  switch (t) {
    case 'int': case 'long': case 'double': case 'int128': case 'int256': case 'string': case 'bytes': case 'true':
      return { k: t };
    case 'Bool':
      return { k: 'bool' };
    case '#':
      return { k: 'flags' };
  }
  if (t.startsWith('%')) {
    const e = ctorsByType.get(t.slice(1))?.[0];
    if (e) return { k: 'bare', entry: e };
  }
  const bare = byName.get(t);
  if (bare && !bare.method && /^[a-z]/.test(t.split('.').pop()!)) return { k: 'bare', entry: bare };
  return { k: 'object' }; // boxed type, Object, !X, X
}

function params(e: Entry): Param[] {
  if (e._params) return e._params;
  const out: Param[] = [];
  for (const tok of e.raw ? e.raw.split(' ') : []) {
    const i = tok.indexOf(':');
    const name = tok.slice(0, i);
    let type = tok.slice(i + 1);
    let flag: Param['flag'];
    const cond = /^(\w+)\.(\d+)\?(.+)$/.exec(type);
    if (cond) {
      flag = { field: cond[1], bit: Number(cond[2]) };
      type = cond[3];
    }
    out.push({ name, t: type.startsWith('!') ? { k: 'object' } : parseType(type), flag });
  }
  return (e._params = out);
}

/** Result type of a method (used to decode rpc_result of e.g. Vector<long>). */
export function resultType(method: string): TypeDesc {
  const e = byName.get(method);
  if (!e) return { k: 'object' };
  return (e._result ??= parseType(e.type));
}

// ---------------- serialization ----------------

export type TlObject = { _: string; [key: string]: any };

export function serialize(obj: TlObject, w = new Writer()): Writer {
  writeObject(w, obj, true);
  return w;
}

function writeObject(w: Writer, obj: TlObject | Uint8Array, boxed: boolean, entry?: Entry): void {
  if (obj instanceof Uint8Array) return w.raw(obj); // pre-serialized
  if (obj === null || typeof obj !== 'object' || typeof obj._ !== 'string') {
    throw new TypeError(`TL: expected an object with "_" (constructor name), got ${JSON.stringify(obj)}`);
  }
  const e = entry ?? byName.get(obj._);
  if (!e) throw new TypeError(`TL: unknown constructor/method "${obj._}"`);
  if (boxed) w.uint(e.id);
  const ps = params(e);
  for (const p of ps) {
    if (p.t.k === 'flags') {
      let flags = 0;
      for (const q of ps) {
        if (q.flag?.field !== p.name) continue;
        const v = obj[q.name];
        if (v === undefined || v === null || (q.t.k === 'true' && v === false)) continue;
        flags |= 1 << q.flag.bit;
      }
      w.uint(flags >>> 0);
      continue;
    }
    const v = obj[p.name];
    if (p.flag) {
      if (v === undefined || v === null || p.t.k === 'true') continue;
    } else if (v === undefined || v === null) {
      throw new TypeError(`TL: ${e.name}.${p.name} is required`);
    }
    writeValue(w, p.t, v, `${e.name}.${p.name}`);
  }
}

function writeValue(w: Writer, t: TypeDesc, v: any, path: string): void {
  switch (t.k) {
    case 'int': return w.int(Number(v));
    case 'long': return w.long(v);
    case 'double': return w.double(v);
    case 'int128': return w.fixed(v, 16);
    case 'int256': return w.fixed(v, 32);
    case 'string': return w.string(v);
    case 'bytes': return w.bytes(typeof v === 'string' ? Buffer.from(v) : v);
    case 'bool': return w.uint(v ? ID.boolTrue : ID.boolFalse);
    case 'true': return;
    case 'object': return writeObject(w, v, true);
    case 'bare': return writeObject(w, v, false, t.entry);
    case 'vector':
      if (!Array.isArray(v)) throw new TypeError(`TL: ${path} must be an array`);
      if (!t.bare) w.uint(ID.vector);
      w.int(v.length);
      for (const item of v) writeValue(w, t.of, item, path);
      return;
    case 'flags':
      return;
  }
}

// ---------------- deserialization ----------------

export function deserialize(buf: Buffer): any {
  return readObject(new Reader(buf));
}

export function readObject(r: Reader): any {
  const id = r.uint();
  switch (id) {
    case ID.boolTrue: return true;
    case ID.boolFalse: return false;
    case ID.gzipPacked: return readObject(new Reader(gunzipSync(r.bytes())));
    case ID.vector: {
      // Untyped vector: elements must be boxed objects.
      const n = r.int();
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = readObject(r);
      return out;
    }
  }
  const e = byId.get(id);
  if (!e) throw new TypeError(`TL: unknown constructor id 0x${id.toString(16).padStart(8, '0')} (schema may be outdated)`);
  return readBody(r, e);
}

function readBody(r: Reader, e: Entry): any {
  const obj: Record<string, any> = { _: e.name };
  const flags: Record<string, number> = {};
  for (const p of params(e)) {
    if (p.t.k === 'flags') {
      flags[p.name] = r.uint();
      continue;
    }
    if (p.flag) {
      const set = (flags[p.flag.field] & (1 << p.flag.bit)) !== 0;
      if (p.t.k === 'true') {
        obj[p.name] = set;
        continue;
      }
      if (!set) continue;
    }
    obj[p.name] = readValue(r, p.t);
  }
  return obj;
}

export function readValue(r: Reader, t: TypeDesc): any {
  switch (t.k) {
    case 'int': return r.int();
    case 'long': return r.long();
    case 'double': return r.double();
    case 'int128': return Buffer.from(r.raw(16));
    case 'int256': return Buffer.from(r.raw(32));
    case 'string': return r.string();
    case 'bytes': return r.bytes();
    case 'bool': return readObject(r);
    case 'true': return true;
    case 'object': return readObject(r);
    case 'bare': return readBody(r, t.entry);
    case 'vector': {
      if (!t.bare) {
        const id = r.uint();
        if (id === ID.gzipPacked) return readValue(new Reader(gunzipSync(r.bytes())), { ...t, bare: false });
        if (id !== ID.vector) throw new TypeError(`TL: expected vector, got 0x${id.toString(16)}`);
      }
      const n = r.int();
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = readValue(r, t.of);
      return out;
    }
    case 'flags': return r.uint();
  }
}

/** Packs data with gzip_packed when it makes the message smaller. */
export function maybeGzip(body: Buffer): Buffer {
  if (body.length < 512) return body;
  const packed = gzipSync(body);
  if (packed.length + 8 >= body.length) return body;
  const w = new Writer(packed.length + 16);
  w.uint(ID.gzipPacked);
  w.bytes(packed);
  return w.result();
}
