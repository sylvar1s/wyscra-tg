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

// The mock behaves like Telegram: an update stays until a later offset confirms it, and comes back otherwise.
// A "crash" is simulated by aborting the bot's polling without stop(): its handlers never finish and nothing more is acknowledged.
const crash = (bot) => bot['polling'].abort();
const replies = (mock, text) => mock.calls.filter((c) => c.method === 'sendMessage' && c.params.text === text).length;

describe('polling acknowledges only finished updates', () => {
  test('crash during a handler: Telegram redelivers the unconfirmed update', async () => {
    const mock = await startMock();
    const db = join(dir, 'redeliver.db');
    const bot1 = new Bot({ token: '1:x', throttle: false, apiRoot: mock.root, db });
    bot1.command('slow', () => {
      crash(bot1); // the process "dies" while this handler is running
      return new Promise(() => {});
    });
    await bot1.start({ handleSignals: false, timeout: 1 });
    const slow = textUpdate('/slow', { chat: 1 });
    mock.push(slow);
    await until(() => bot1['polling']?.signal.aborted);
    await bot1['pollLoop'];
    assert.ok(mock.unconfirmed.includes(slow.update_id), 'update must not be confirmed while its handler runs');

    const bot2 = new Bot({ token: '1:x', throttle: false, apiRoot: mock.root, db });
    bot2.command('slow', (ctx) => ctx.reply('slow done'));
    await bot2.start({ handleSignals: false, timeout: 1 });
    await until(() => replies(mock, 'slow done') === 1);
    await bot2.stop();
    await bot1.db.close(); // release the "dead" process's file handle (Windows can't delete open files)
    assert.ok(mock.acked.includes(slow.update_id));
    await mock.close();
  });

  test('slow first handler, fast ones after it, crash: nothing is lost, nothing runs twice', async () => {
    const mock = await startMock();
    const db = join(dir, 'parked.db');
    const bot1 = new Bot({ token: '1:x', throttle: false, apiRoot: mock.root, db });
    bot1.command('slow', () => new Promise(() => {})); // never finishes
    bot1.on('text', (ctx) => ctx.reply(`echo ${ctx.text}`));
    // limit 2: the slow update plus one more fills Telegram's window, so the bot must park it to make progress.
    await bot1.start({ handleSignals: false, timeout: 1, limit: 2 });

    const slow = textUpdate('/slow', { chat: 1 });
    const fast = [1, 2, 3, 4, 5].map((i) => textUpdate(`fast${i}`, { chat: 10 + i }));
    mock.push(slow, ...fast);
    await until(() => fast.every((u) => replies(mock, `echo ${u.message.text}`) === 1));
    // The bot did not stall behind the slow handler, and moved the offset past it only after saving it.
    await until(() => mock.acked.includes(slow.update_id));
    assert.ok(await bot1.db.collection('wyscra_updates_1').has(slow.update_id), 'slow update is parked in the database');
    crash(bot1);
    await bot1['pollLoop'];

    const bot2 = new Bot({ token: '1:x', throttle: false, apiRoot: mock.root, db });
    bot2.command('slow', (ctx) => ctx.reply('slow done'));
    bot2.on('text', (ctx) => ctx.reply(`echo ${ctx.text}`));
    await bot2.start({ handleSignals: false, timeout: 1, limit: 2 });
    await until(() => replies(mock, 'slow done') === 1);
    await until(async () => !(await bot2.db.collection('wyscra_updates_1').has(slow.update_id)));
    await bot2.stop();
    await bot1.db.close();
    for (const u of fast) assert.equal(replies(mock, `echo ${u.message.text}`), 1, `${u.message.text} handled exactly once`);
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
