import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Bot, Database } from '../dist/index.js';
import { callbackUpdate, startMock, textUpdate } from './mock-server.mjs';

const botInfo = { id: 1, is_bot: true, first_name: 'b', username: 'test_bot' };
const dir = mkdtempSync(join(tmpdir(), 'wyscra-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let mock;
before(async () => {
  mock = await startMock({
    sendMessage: (p) => (Number(p.chat_id) === 403 ? { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } : { message_id: 1, date: 1, chat: { id: Number(p.chat_id), type: 'private' }, text: p.text }),
  });
});
after(() => mock.close());

const newBot = (opts = {}) => new Bot('1:x', { apiRoot: mock.root, botInfo, throttle: false, ...opts });
const last = (method = 'sendMessage') => mock.calls.filter((c) => c.method === method).at(-1).params;

describe('keyboards from plain arrays', () => {
  test('inline: one row, rows, columns, url/copy/webApp buttons', async () => {
    const bot = newBot();
    bot.command('a', (ctx) => ctx.reply('x', { inline: ['Да', 'Нет'] }));
    bot.command('b', (ctx) => ctx.reply('x', { inline: [['1', '2'], [{ text: 'Сайт', url: 'https://t.me' }, { text: 'Код', copy: 'PROMO' }]] }));
    bot.command('c', (ctx) => ctx.reply('x', { inline: ['1', '2', '3', '4', '5'], columns: 2 }));
    await bot.handleUpdate(textUpdate('/a'));
    assert.deepEqual(last().reply_markup, { inline_keyboard: [[{ text: 'Да', callback_data: 'Да' }, { text: 'Нет', callback_data: 'Нет' }]] });
    await bot.handleUpdate(textUpdate('/b'));
    assert.deepEqual(last().reply_markup.inline_keyboard[1], [{ text: 'Сайт', url: 'https://t.me' }, { text: 'Код', copy_text: { text: 'PROMO' } }]);
    await bot.handleUpdate(textUpdate('/c'));
    assert.deepEqual(last().reply_markup.inline_keyboard.map((r) => r.length), [2, 2, 1]);
  });

  test('reply keyboard: resized by default, contact/location buttons, removeKeyboard', async () => {
    const bot = newBot();
    bot.command('k', (ctx) => ctx.reply('x', { keyboard: [['Каталог', 'Корзина'], [{ text: 'Телефон', contact: true }]], oneTime: true }));
    bot.command('r', (ctx) => ctx.reply('x', { removeKeyboard: true }));
    await bot.handleUpdate(textUpdate('/k'));
    assert.deepEqual(last().reply_markup, {
      keyboard: [[{ text: 'Каталог' }, { text: 'Корзина' }], [{ text: 'Телефон', request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    });
    await bot.handleUpdate(textUpdate('/r'));
    assert.equal(last().reply_markup.remove_keyboard, true);
  });

  test('onClick runs the handler on press; old buttons answer "expired"', async () => {
    const bot = newBot();
    const clicks = [];
    bot.command('menu', (ctx) =>
      ctx.reply('Удалить?', {
        inline: [{ text: 'Да', onClick: (c) => (clicks.push(c.from.id), (c.user.clicked = true), (c.session.x = 1), c.editText('Удалено')) }],
      }),
    );
    await bot.handleUpdate(textUpdate('/menu'));
    const data = last().reply_markup.inline_keyboard[0][0].callback_data;
    await bot.handleUpdate(callbackUpdate(data, { user: 77 }));
    assert.deepEqual(clicks, [77]);
    assert.equal(last('editMessageText').text, 'Удалено');
    assert.equal((await bot.db.users.get(77)).clicked, true, 'ctx.user works inside onClick');

    const restarted = newBot();
    await restarted.handleUpdate(callbackUpdate(data));
    assert.match(last('answerCallbackQuery').text, /устарела/);
  });

  test('friendly options: html, silent, replyTo, noPreview; raw Bot API params still work', async () => {
    const bot = newBot();
    bot.command('h', (ctx) => ctx.reply('<b>x</b>', { html: true, silent: true, replyTo: 5, noPreview: true }));
    bot.command('raw', (ctx) => ctx.reply('x', { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'a', callback_data: 'b' }]] } }));
    await bot.handleUpdate(textUpdate('/h'));
    const p = last();
    assert.equal(p.parse_mode, 'HTML');
    assert.equal(p.disable_notification, true);
    assert.equal(p.reply_parameters.message_id, 5);
    assert.deepEqual(p.link_preview_options, { is_disabled: true });
    await bot.handleUpdate(textUpdate('/raw'));
    assert.equal(last().reply_markup.inline_keyboard[0][0].callback_data, 'b');
  });

  test('bot.send works outside handlers', async () => {
    const bot = newBot();
    await bot.send(555, 'Привет', { inline: [{ text: 'Ок', data: 'ok' }] });
    assert.equal(last().chat_id, 555);
    assert.equal(last().reply_markup.inline_keyboard[0][0].callback_data, 'ok');
  });
});

describe('database', () => {
  for (const kind of ['memory', 'json', 'sqlite']) {
    test(`collection API (${kind})`, async () => {
      const url = kind === 'memory' ? undefined : join(dir, kind === 'json' ? 'c.json' : 'c.db');
      const db = new Database(url);
      const orders = db.collection('orders');
      await orders.set(1, { item: 'Пицца', price: 500, paid: false });
      await orders.set('a', { item: 'Суши', price: 900, paid: true });
      assert.deepEqual(await orders.get(1), { item: 'Пицца', price: 500, paid: false, id: 1 });
      assert.equal((await orders.update(1, { paid: true })).paid, true);
      assert.equal(await orders.increment(1, 'price', 50), 550);
      assert.equal((await orders.find({ paid: true })).length, 2);
      assert.deepEqual((await orders.find({ item: 'Суши' })).map((o) => o.id), ['a']);
      assert.deepEqual((await orders.find((o) => o.price > 600)).map((o) => o.id), ['a']);
      assert.equal(await orders.count(), 2);
      assert.equal(await orders.count({ price: 550 }), 1);
      const ids = [];
      for await (const o of orders) ids.push(o.id);
      assert.deepEqual(ids.sort(), [1, 'a'].sort());
      assert.equal(await orders.delete('a'), true);
      assert.equal(await orders.has('a'), false);
      assert.equal(await db.kind(), kind);
      await db.close();
    });
  }

  test('sqlite and json data survive reopening', async () => {
    for (const file of ['p.db', 'p.json']) {
      const path = join(dir, file);
      const a = new Database(path);
      await a.collection('x').set(1, { v: 42 });
      await a.close();
      const b = new Database(path);
      assert.equal((await b.collection('x').get(1)).v, 42, file);
      await b.close();
    }
  });

  test('clear error for an unknown address and a missing driver', async () => {
    await assert.rejects(new Database('ftp://x').connect(), /Не понял адрес/);
    await assert.rejects(new Database('postgres://localhost/db').connect(), /npm install pg/);
  });
});

describe('ctx.user, sessions and scenes out of the box', () => {
  test('users are saved automatically; custom fields persist across restarts', async () => {
    const path = join(dir, 'users.db');
    const make = () => {
      const bot = newBot({ db: path });
      bot.command('pay', (ctx) => {
        ctx.user.balance = (ctx.user.balance ?? 0) + 100;
        return ctx.reply(`Баланс: ${ctx.user.balance}`);
      });
      return bot;
    };
    let bot = make();
    await bot.handleUpdate(textUpdate('/pay', { user: 9, chat: 9 }));
    await bot.handleUpdate(textUpdate('/pay', { user: 9, chat: 9 }));
    await bot.db.close();
    bot = make();
    await bot.handleUpdate(textUpdate('/pay', { user: 9, chat: 9 }));
    assert.equal(last().text, 'Баланс: 300');
    const u = await bot.db.users.get(9);
    assert.equal(u.first_name, 'U');
    assert.equal(u.balance, 300);
    assert.ok(u.firstSeen <= u.lastSeen);
    await bot.db.close();
  });

  test('ctx.session works without setup; bot.scene works without setup', async () => {
    const bot = newBot();
    bot.command('n', (ctx) => ctx.reply(`n=${(ctx.session.n = (ctx.session.n ?? 0) + 1)}`));
    bot.scene('ask').step((ctx) => ctx.reply('Имя?')).step((ctx) => ctx.reply(`Привет, ${ctx.text}`));
    bot.command('ask', (ctx) => ctx.scene.enter('ask'));
    await bot.handleUpdate(textUpdate('/n', { user: 3, chat: 3 }));
    await bot.handleUpdate(textUpdate('/n', { user: 3, chat: 3 }));
    assert.equal(last().text, 'n=2');
    await bot.handleUpdate(textUpdate('/ask', { user: 3, chat: 3 }));
    await bot.handleUpdate(textUpdate('Оля', { user: 3, chat: 3 }));
    assert.equal(last().text, 'Привет, Оля');
  });

  test('broadcast sends to everyone, marks blocked users and skips them next time', async () => {
    const bot = newBot();
    for (const id of [101, 102, 403]) await bot.db.users.set(id, { id, first_name: `u${id}`, firstSeen: 0, lastSeen: 0, language_code: id === 102 ? 'en' : 'ru' });
    let r = await bot.broadcast((u) => `Привет, ${u.first_name}`, { inline: [{ text: 'Сайт', url: 'https://t.me' }] });
    assert.deepEqual(r, { total: 3, sent: 2, blocked: 1, failed: 0 });
    assert.equal((await bot.db.users.get(403)).blocked, true);
    r = await bot.broadcast('Снова');
    assert.equal(r.total, 2);
    r = await bot.broadcast('Только ru', { filter: { language_code: 'ru' } });
    assert.equal(r.total, 1);
  });

  test('token from environment and a clear error without it', () => {
    const saved = process.env.BOT_TOKEN;
    process.env.BOT_TOKEN = '42:env';
    assert.equal(new Bot({ botInfo }).api.token, '42:env');
    delete process.env.BOT_TOKEN;
    assert.throws(() => new Bot(), /BOT_TOKEN/);
    if (saved) process.env.BOT_TOKEN = saved;
  });
});
