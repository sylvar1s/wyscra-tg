// Conformance suite: every driver must behave identically through the Database API.
// memory / json / sqlite always run; external databases run when their URL is set:
//   TEST_POSTGRES_URL=postgres://...  TEST_MYSQL_URL=mysql://...  TEST_MONGO_URL=mongodb://...  TEST_REDIS_URL=redis://...
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { Database, FileStore, JsonDriver } from '../dist/index.js';

const dir = mkdtempSync(join(tmpdir(), 'wyscra-drivers-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const targets = [
  ['memory', () => undefined],
  ['json', () => join(dir, `c${Math.random()}.json`)],
  ['sqlite', () => join(dir, `c${Math.random()}.db`)],
  ['postgres', () => process.env.TEST_POSTGRES_URL],
  ['mysql', () => process.env.TEST_MYSQL_URL],
  ['mongodb', () => process.env.TEST_MONGO_URL],
  ['redis', () => process.env.TEST_REDIS_URL],
];

for (const [kind, makeUrl] of targets) {
  const external = !['memory', 'json', 'sqlite'].includes(kind);
  const skip = external && !makeUrl() ? `set TEST_${kind === 'mongodb' ? 'MONGO' : kind.toUpperCase()}_URL` : false;

  describe(`driver: ${kind}`, { skip }, () => {
    let db;
    let n = 0;
    // Fresh collection per test so external databases need no cleanup between runs.
    const coll = () => db.collection(`t_${process.pid}_${Date.now()}_${n++}`);
    const ids = (docs) => docs.map((d) => d.id).sort((a, b) => String(a).localeCompare(String(b)));

    test('connect', async () => {
      db = new Database(makeUrl());
      assert.equal(await db.kind(), kind);
    });
    after(() => db?.close());

    test('get / set / update / delete', async () => {
      const c = coll();
      assert.equal(await c.get(1), undefined);
      await c.set(1, { a: 1 });
      assert.deepEqual(await c.get(1), { a: 1, id: 1 });
      assert.deepEqual(await c.update(1, { b: 2 }), { a: 1, b: 2, id: 1 });
      assert.deepEqual(await c.update('new', (cur) => ({ x: cur === undefined })), { x: true, id: 'new' });
      assert.equal(await c.delete(1), true);
      assert.equal(await c.delete(1), false);
      assert.equal(await c.count(), 1);
    });

    test('concurrent increments are not lost', async () => {
      const c = coll();
      await Promise.all(Array.from({ length: 50 }, () => c.increment('k', 'n')));
      assert.equal((await c.get('k')).n, 50);
      // also when the record does not exist yet
      await Promise.all(Array.from({ length: 20 }, () => c.increment('fresh', 'n', 2)));
      assert.equal((await c.get('fresh')).n, 40);
    });

    test('concurrent update() functions see each other', async () => {
      const c = coll();
      await Promise.all(Array.from({ length: 30 }, (_, i) => c.update('list', (cur) => ({ items: [...(cur?.items ?? []), i] }))));
      assert.equal((await c.get('list')).items.length, 30);
    });

    test('filter semantics are identical', async () => {
      const c = coll();
      await c.set('num', { v: 5, flag: true, tags: ['a', 'b'], obj: { x: 1, y: 2 } });
      await c.set('str', { v: '5', flag: 1, tags: ['a'], obj: { y: 2, x: 1 } });
      await c.set('nul', { v: null, flag: false, tags: 'a' });
      await c.set('none', { other: 1 });

      assert.deepEqual(ids(await c.find({ v: 5 })), ['num'], 'number is not equal to string');
      assert.deepEqual(ids(await c.find({ v: '5' })), ['str']);
      assert.deepEqual(ids(await c.find({ flag: true })), ['num'], 'true is not equal to 1');
      assert.deepEqual(ids(await c.find({ flag: 1 })), ['str']);
      assert.deepEqual(ids(await c.find({ flag: false })), ['nul']);
      assert.deepEqual(ids(await c.find({ v: null })), ['none', 'nul'], 'null matches null or missing');
      assert.deepEqual(ids(await c.find({ tags: 'a' })), ['nul'], 'scalar does not match an array containing it');
      assert.deepEqual(ids(await c.find({ tags: ['a'] })), ['str'], 'arrays compare whole');
      assert.deepEqual(ids(await c.find({ obj: { x: 1, y: 2 } })), ['num', 'str'], 'objects compare deeply, key order ignored');
      assert.deepEqual(ids(await c.find({ obj: { x: 1 } })), [], 'no partial object match');
      assert.deepEqual(ids(await c.find({ v: 5, flag: true })), ['num']);
      assert.deepEqual(ids(await c.find({ v: undefined, flag: false })), ['nul'], 'undefined conditions are ignored');
      assert.equal(await c.count({ v: null }), 2);
      assert.equal(await c.count({ obj: { y: 2, x: 1 } }), 2);
      assert.equal((await c.find({ v: null }, 1)).length, 1);
      assert.equal((await c.find({ obj: { x: 1, y: 2 } }, 1)).length, 1);
    });

    test('odd field names are rejected or matched safely, never injected', async () => {
      const c = coll();
      await c.set(1, { "a'b": 1 });
      assert.deepEqual(ids(await c.find({ "a'b": 1 })), [1]);
    });
  });
}

describe('corrupted JSON files', () => {
  test('JsonDriver refuses a broken file instead of wiping it', () => {
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{"users": {"1": {"id": 1}');
    assert.throws(() => new JsonDriver(path), /повреждён/);
    assert.equal(readFileSync(path, 'utf8'), '{"users": {"1": {"id": 1}', 'file left untouched');
  });

  test('missing or empty file starts empty', async () => {
    const empty = join(dir, 'empty.json');
    writeFileSync(empty, '');
    assert.equal(await new JsonDriver(empty).count('users'), 0);
    assert.equal(await new JsonDriver(join(dir, 'nope.json')).count('users'), 0);
  });

  test('FileStore refuses a broken file', () => {
    const path = join(dir, 'sessions.json');
    writeFileSync(path, '{oops');
    assert.throws(() => new FileStore(path), /повреждён/);
  });

  test('one broken row in sqlite does not break list()', async () => {
    const db = new Database(join(dir, 'rows.db'));
    const c = db.collection('x');
    await c.set(1, { ok: true });
    await c.set(2, { ok: true });
    (await db.raw()).prepare("UPDATE wyscra_kv SET value = '{bad' WHERE key = '2'").run();
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.deepEqual((await c.all()).map((d) => d.id), [1]);
    } finally {
      console.warn = warn;
    }
    await assert.rejects(c.get(2), /Повреждённая запись x\/2/);
    await db.close();
  });
});
