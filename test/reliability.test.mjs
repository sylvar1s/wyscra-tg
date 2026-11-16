import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { Bot } from '../dist/index.js';
import { FileSession, StringSession } from '../dist/mtproto/index.js';
import { startMock, textUpdate, until, wait } from './mock-server.mjs';

const dir = mkdtempSync(join(tmpdir(), 'wyscra-rel-'));
after(() => rmSync(dir, { recursive: true, force: true }));

describe('polling acknowledges only finished updates', () => {
  test('offset stays on an update whose handler is still running', async () => {
    const mock = await startMock();
    const bot = new Bot('1:x', { throttle: false, apiRoot: mock.root });
    let release;
    const gate = new Promise((r) => (release = r));
    bot.command('slow', async (ctx) => {
      await gate;
      await ctx.reply('slow done');
    });
    bot.on('text', (ctx) => ctx.reply(`echo ${ctx.text}`));
    await bot.start({ handleSignals: false, timeout: 1 });

    const slow = textUpdate('/slow', { chat: 1 });
    const fast = textUpdate('fast', { chat: 2 });
    mock.push(slow, fast);
    await until(() => mock.calls.some((c) => c.params.text === 'echo fast'));
    const fast2 = textUpdate('fast2', { chat: 3 });
    mock.push(fast2);
    await until(() => mock.calls.some((c) => c.params.text === 'echo fast2'));
    const polls = () => mock.calls.filter((c) => c.method === 'getUpdates').map((c) => c.params.offset);
    await until(() => polls().length >= 4);
    // While /slow runs, nothing at or after it may be acknowledged.
    for (const o of polls()) assert.ok(o <= slow.update_id, `offset ${o} would drop update ${slow.update_id}`);

    release();
    await until(() => mock.calls.some((c) => c.params.text === 'slow done'));
    const before = mock.calls.length;
    await until(() => mock.calls.slice(before).some((c) => c.method === 'getUpdates' && c.params.offset === fast2.update_id + 1));
    await bot.stop();
    await mock.close();
  });

  test('stop() acknowledges after handlers finish, not before', async () => {
    const mock = await startMock();
    const bot = new Bot('1:x', { throttle: false, apiRoot: mock.root });
    bot.on('text', async (ctx) => {
      await wait(150);
      await ctx.reply('handled');
    });
    await bot.start({ handleSignals: false, timeout: 1 });
    const u = textUpdate('hi');
    mock.push(u);
    await until(() => mock.calls.some((c) => c.method === 'getUpdates' && c.params.offset === u.update_id));
    await bot.stop();
    const i = mock.calls.findIndex((c) => c.params.text === 'handled');
    const ack = mock.calls.findLastIndex((c) => c.method === 'getUpdates');
    assert.ok(i >= 0 && ack > i, 'final acknowledgement comes after the handler replied');
    assert.equal(mock.calls[ack].params.offset, u.update_id + 1);
    await mock.close();
  });
});

describe('MTProto session encryption', () => {
  const data = { version: 1, dcId: 2, testServers: false, authKeys: { 2: 'ab'.repeat(256) }, authorizedDcs: [2], userId: '42', peers: {} };

  test('FileSession with password stores no plaintext and round-trips', () => {
    const path = join(dir, 'enc.session.json');
    new FileSession(path, { password: 'pw' }).save(data);
    const raw = readFileSync(path, 'utf8');
    assert.ok(!raw.includes('abab'), 'auth key must not be visible');
    assert.deepEqual(new FileSession(path, { password: 'pw' }).load(), data);
    assert.throws(() => new FileSession(path, { password: 'wrong' }).load(), /неверный пароль/);
    assert.throws(() => new FileSession(path).load(), /зашифрована/);
  });

  test('plaintext session is migrated to encrypted on save', () => {
    const path = join(dir, 'plain.session.json');
    new FileSession(path).save(data);
    const s = new FileSession(path, { password: 'pw' });
    s.save(s.load());
    assert.match(readFileSync(path, 'utf8'), /wyscra-aes256gcm-scrypt/);
    assert.deepEqual(new FileSession(path, { password: 'pw' }).load(), data);
  });

  test('broken session file is reported, not silently replaced', () => {
    const path = join(dir, 'broken.session.json');
    writeFileSync(path, '{"dcId": 2,');
    assert.throws(() => new FileSession(path).load(), /повреждён/);
    assert.equal(new FileSession(join(dir, 'missing')).load(), undefined);
  });

  test('StringSession encrypted round-trip', () => {
    const str = StringSession.encode(data, 'pw');
    assert.ok(str.startsWith('enc1.'));
    assert.equal(new StringSession(str, { password: 'pw' }).load().authKeys[2], data.authKeys[2]);
    assert.throws(() => new StringSession(str), /зашифрована/);
    assert.throws(() => new StringSession(str, { password: 'no' }), /расшифровать/);
    assert.equal(new StringSession(StringSession.encode(data)).load().userId, '42');
  });
});
