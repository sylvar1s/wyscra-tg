import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Bot, MemoryStore, Scene, scenes, session } from '../dist/index.js';
import { startMock, textUpdate } from './mock-server.mjs';

const botInfo = { id: 1, is_bot: true, first_name: 'b', username: 'test_bot' };

describe('throttle', () => {
  let mock;
  before(async () => (mock = await startMock()));
  after(() => mock.close());

  test('spaces messages in one private chat after the burst', async () => {
    const bot = new Bot('1:x', { apiRoot: mock.root, throttle: { perChat: 20, perChatBurst: 2 } });
    const t = Date.now();
    await Promise.all([1, 2, 3, 4].map((i) => bot.api.sendMessage({ chat_id: 777, text: String(i) })));
    const ms = Date.now() - t;
    assert.ok(ms >= 90, `4 messages with burst 2 at 20/s should take ~100ms, took ${ms}`);
    // The first two fit in the burst and go out as parallel HTTP requests (their arrival order may vary);
    // the throttled ones must come strictly after them, in order.
    const order = mock.calls.filter((c) => c.params.chat_id === 777).map((c) => c.params.text);
    assert.deepEqual(order.slice(0, 2).sort(), ['1', '2']);
    assert.deepEqual(order.slice(2), ['3', '4'], 'throttled messages keep their order');
  });

  test('global limit across chats; chat actions are not throttled; paid broadcast bypasses global', async () => {
    const bot = new Bot('1:x', { apiRoot: mock.root, throttle: { global: 20 } });
    let t = Date.now();
    await Promise.all(Array.from({ length: 30 }, (_, i) => bot.api.sendMessage({ chat_id: 1000 + i, text: 'x' })));
    assert.ok(Date.now() - t >= 450, 'extra 10 messages at 20/s ≈ 500ms');

    t = Date.now();
    await Promise.all(Array.from({ length: 30 }, () => bot.api.sendChatAction({ chat_id: 5, action: 'typing' })));
    assert.ok(Date.now() - t < 300, 'sendChatAction is not throttled');

    t = Date.now();
    await Promise.all(Array.from({ length: 30 }, (_, i) => bot.api.sendMessage({ chat_id: 2000 + i, text: 'x', allow_paid_broadcast: true })));
    assert.ok(Date.now() - t < 300, 'paid broadcast is not limited by the global 30/s');
  });
});

describe('scenes', () => {
  let mock;
  before(async () => (mock = await startMock()));
  after(() => mock.close());

  const makeBot = (store, left) => {
    const bot = new Bot('1:x', { apiRoot: mock.root, botInfo, throttle: false });
    const signup = new Scene('signup')
      .step((ctx) => ctx.reply('Name?'))
      .step((ctx) => {
        ctx.scene.data.name = ctx.text;
        return ctx.reply('Age?');
      })
      .step(async (ctx) => {
        if (!/^\d+$/.test(ctx.text ?? '')) {
          ctx.scene.stay();
          return ctx.reply('Digits please');
        }
        await ctx.reply(`Saved ${ctx.scene.data.name}, ${ctx.text}`);
      })
      .onLeave(() => left.push('signup'));
    bot.use(session({ store }), scenes(signup));
    bot.command('signup', (ctx) => ctx.scene.enter('signup'));
    bot.command('cancel', async (ctx) => {
      await ctx.scene.leave();
      await ctx.reply('Cancelled');
    });
    bot.on('text', (ctx) => ctx.reply(`echo ${ctx.text}`));
    return bot;
  };
  const sent = () => mock.calls.filter((c) => c.method === 'sendMessage').map((c) => c.params.text);

  test('a scene continues after a restart with the same store', async () => {
    const store = new MemoryStore();
    const left = [];
    let bot = makeBot(store, left);
    await bot.handleUpdate(textUpdate('/signup', { chat: 50, user: 50 }));
    await bot.handleUpdate(textUpdate('Alice', { chat: 50, user: 50 }));
    assert.deepEqual(sent().slice(-2), ['Name?', 'Age?']);

    bot = makeBot(store, left); // "restart"
    await bot.handleUpdate(textUpdate('abc', { chat: 50, user: 50 }));
    await bot.handleUpdate(textUpdate('30', { chat: 50, user: 50 }));
    assert.deepEqual(sent().slice(-2), ['Digits please', 'Saved Alice, 30']);
    assert.deepEqual(left, ['signup']);

    await bot.handleUpdate(textUpdate('after', { chat: 50, user: 50 }));
    assert.equal(sent().at(-1), 'echo after', 'normal handlers work after leaving');
  });

  test('commands go to normal handlers so /cancel works; other users are unaffected', async () => {
    const left = [];
    const bot = makeBot(new MemoryStore(), left);
    await bot.handleUpdate(textUpdate('/signup', { chat: 60, user: 60 }));
    await bot.handleUpdate(textUpdate('hi', { chat: 61, user: 61 }));
    assert.equal(sent().at(-1), 'echo hi');
    await bot.handleUpdate(textUpdate('/cancel', { chat: 60, user: 60 }));
    assert.equal(sent().at(-1), 'Cancelled');
    await bot.handleUpdate(textUpdate('Bob', { chat: 60, user: 60 }));
    assert.equal(sent().at(-1), 'echo Bob');
  });
});

describe('fetchHandler (Bun / Deno / serverless)', () => {
  test('checks secret and processes the update before responding', async () => {
    const mock = await startMock();
    const bot = new Bot('1:x', { apiRoot: mock.root, botInfo, throttle: false });
    const got = [];
    bot.on('text', (ctx) => got.push(ctx.text));
    const handle = bot.fetchHandler({ secretToken: 'abc' });
    const req = (secret) =>
      new Request('https://x/bot', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(textUpdate('serverless')) });
    assert.equal((await handle(req('bad'))).status, 401);
    assert.equal((await handle(req('abc'))).status, 200);
    assert.deepEqual(got, ['serverless']);
    assert.equal((await handle(new Request('https://x/bot'))).status, 405);
    await mock.close();
  });
});
