import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Bot, InlineKeyboard, InputFile, Keyboard, TelegramError, fmt, html, md, session } from '../dist/index.js';
import { callbackUpdate, startMock, textUpdate, until, wait } from './mock-server.mjs';

describe('Api', () => {
  let mock;
  let flood = 0;
  before(async () => {
    mock = await startMock({
      sendDice: () => (flood++ < 1 ? { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0.05 } } : { message_id: 1, date: 1, chat: { id: 1, type: 'private' } }),
      banChatMember: () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }),
    });
  });
  after(() => mock.close());

  test('JSON request, default parse mode, html template escaping', async () => {
    const bot = new Bot('123:abc', { throttle: false, apiRoot: mock.root, parseMode: 'HTML' });
    await bot.api.sendMessage({ chat_id: 1, text: 'plain' });
    let c = mock.calls.at(-1);
    assert.equal(c.method, 'sendMessage');
    assert.equal(c.params.parse_mode, 'HTML');
    assert.match(c.contentType, /application\/json/);

    const bot2 = new Bot('123:abc', { throttle: false, apiRoot: mock.root });
    await bot2.api.sendMessage({ chat_id: 1, text: html`Hi <b>${'<script>&'}</b> ${fmt.code('x<y')}` });
    c = mock.calls.at(-1);
    assert.equal(c.params.text, 'Hi <b>&lt;script&gt;&amp;</b> <code>x&lt;y</code>');
    assert.equal(c.params.parse_mode, 'HTML');

    await bot2.api.sendPoll({ chat_id: 1, question: md`Why_${'a.b'}?`, options: [{ text: 'a' }, { text: 'b' }] });
    c = mock.calls.at(-1);
    assert.equal(c.params.question, 'Why_a\\.b?');
    assert.equal(c.params.question_parse_mode, 'MarkdownV2');
  });

  test('multipart upload incl. nested attach:// files', async () => {
    const bot = new Bot('123:abc', { throttle: false, apiRoot: mock.root });
    await bot.api.sendPhoto({ chat_id: 1, photo: new InputFile(Buffer.from('PHOTO'), 'p.jpg'), caption: 'c' });
    let c = mock.calls.at(-1);
    assert.match(c.contentType, /multipart/);
    assert.deepEqual(c.files.photo, { name: 'p.jpg', size: 5, text: 'PHOTO' });
    assert.equal(c.params.caption, 'c');

    await bot.api.sendMediaGroup({
      chat_id: 1,
      media: [
        { type: 'photo', media: new InputFile(Buffer.from('A'), 'a.jpg') },
        { type: 'photo', media: 'FILE_ID' },
        { type: 'photo', media: new InputFile(Buffer.from('BB'), 'b.jpg') },
      ],
    });
    c = mock.calls.at(-1);
    const media = JSON.parse(c.params.media);
    assert.deepEqual(media.map((m) => m.media), ['attach://file0', 'FILE_ID', 'attach://file1']);
    assert.equal(c.files.file0.text, 'A');
    assert.equal(c.files.file1.text, 'BB');
  });

  test('retries flood wait (429) automatically', async () => {
    const bot = new Bot('123:abc', { throttle: false, apiRoot: mock.root });
    const m = await bot.api.sendDice({ chat_id: 1 });
    assert.equal(m.message_id, 1);
    assert.equal(mock.calls.filter((c) => c.method === 'sendDice').length, 2);
  });

  test('TelegramError carries code and description', async () => {
    const bot = new Bot('123:abc', { throttle: false, apiRoot: mock.root });
    await assert.rejects(bot.api.banChatMember({ chat_id: 1, user_id: 2 }), (e) => {
      assert.ok(e instanceof TelegramError);
      assert.equal(e.code, 403);
      assert.equal(e.isForbidden, true);
      return true;
    });
  });

  test('transformers wrap calls', async () => {
    const bot = new Bot('123:abc', { throttle: false, apiRoot: mock.root });
    const seen = [];
    bot.api.use(async (method, params, next) => {
      seen.push(method);
      return next(method, { ...params, disable_notification: true });
    });
    await bot.api.sendMessage({ chat_id: 1, text: 'x' });
    assert.deepEqual(seen, ['sendMessage']);
    assert.equal(mock.calls.at(-1).params.disable_notification, true);
  });
});

describe('Keyboards', () => {
  test('inline keyboard builder', () => {
    const kb = new InlineKeyboard().text('A', 'a').text('B').row().url('U', 'https://t.me').row();
    assert.deepEqual(JSON.parse(JSON.stringify(kb)), {
      inline_keyboard: [
        [{ text: 'A', callback_data: 'a' }, { text: 'B', callback_data: 'B' }],
        [{ text: 'U', url: 'https://t.me' }],
      ],
    });
    assert.deepEqual(new InlineKeyboard().text('1').text('2').text('3').columns(2).toJSON().inline_keyboard.map((r) => r.length), [2, 1]);
  });
  test('reply keyboard builder', () => {
    const kb = Keyboard.from([['A', 'B'], ['C']]).resized().oneTime();
    assert.deepEqual(JSON.parse(JSON.stringify(kb)), {
      keyboard: [[{ text: 'A' }, { text: 'B' }], [{ text: 'C' }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    });
  });
});

describe('Bot (polling)', () => {
  let mock, bot;
  const log = [];
  before(async () => {
    mock = await startMock();
    bot = new Bot('123:abc', { throttle: false, apiRoot: mock.root });
    bot.use(session({ initial: () => ({ n: 0 }) }));
    bot.command('start', 'Start the bot', (ctx) => ctx.reply(`start:${ctx.args}`));
    bot.command('count', (ctx) => ctx.reply(`n=${++ctx.session.n}`));
    bot.command('name', async (ctx) => {
      const a = await ctx.ask('Your name?');
      await ctx.reply(`Hi ${a.text}`);
    });
    bot.command('slow', async (ctx) => {
      await wait(100);
      log.push(`slow:${ctx.chatId}`);
    });
    bot.hears(/^ping (\d+)$/, (ctx) => ctx.reply(`pong ${ctx.match[1]}`));
    bot.action('noanswer', () => {});
    bot.action(/^item:(\d+)$/, (ctx) => ctx.answer(`item ${ctx.match[1]}`));
    bot.command('boom', () => {
      throw new Error('boom');
    });
    bot.on('text', (ctx) => {
      log.push(`text:${ctx.chatId}:${ctx.text}`);
    });
    bot.catch((err, ctx) => ctx.reply(`error: ${err.message}`));
    await bot.start({ handleSignals: false, timeout: 1 });
  });
  after(async () => {
    await bot.stop();
    await mock.close();
  });

  const sent = () => mock.calls.filter((c) => c.method === 'sendMessage').map((c) => c.params.text);

  test('startup: deleteWebhook, setMyCommands, all update types requested', async () => {
    await until(() => mock.calls.some((c) => c.method === 'getUpdates'));
    const cmds = mock.calls.find((c) => c.method === 'setMyCommands');
    assert.deepEqual(cmds.params.commands, [{ command: 'start', description: 'Start the bot' }]);
    const gu = mock.calls.find((c) => c.method === 'getUpdates');
    assert.ok(gu.params.allowed_updates.includes('chat_member'));
    assert.ok(gu.params.allowed_updates.includes('message_reaction'));
    assert.equal(bot.me.username, 'test_bot');
  });

  test('commands with args, @mention and hears', async () => {
    mock.push(textUpdate('/start ref42'), textUpdate('/start@test_bot x'), textUpdate('/start@other_bot y'), textUpdate('ping 7'));
    await until(() => sent().includes('pong 7'));
    assert.ok(sent().includes('start:ref42'));
    assert.ok(sent().includes('start:x'));
    assert.ok(!sent().includes('start:y'));
    assert.ok(log.includes('text:10:/start@other_bot y'), 'command for another bot falls through to text handler');
  });

  test('session persists per user', async () => {
    mock.push(textUpdate('/count'), textUpdate('/count'), textUpdate('/count', { user: 99 }));
    await until(() => sent().filter((t) => t?.startsWith('n=')).length === 3);
    assert.deepEqual(sent().filter((t) => t.startsWith('n=')), ['n=1', 'n=2', 'n=1']);
  });

  test('ctx.ask waits for the next message from the same user', async () => {
    mock.push(textUpdate('/name', { chat: 30, user: 31 }));
    await until(() => sent().includes('Your name?'));
    mock.push(textUpdate('Alice', { chat: 30, user: 99 })); // another user: not the answer
    mock.push(textUpdate('Bob', { chat: 30, user: 31 }));
    await until(() => sent().includes('Hi Bob'));
    assert.ok(log.includes('text:30:Alice'));
    assert.ok(!log.includes('text:30:Bob'), 'answer is consumed by ask()');
  });

  test('callback queries: regex match + auto answer', async () => {
    mock.push(callbackUpdate('item:5'), callbackUpdate('noanswer'));
    await until(() => mock.calls.filter((c) => c.method === 'answerCallbackQuery').length >= 2);
    const answers = mock.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.params.text ?? null);
    assert.ok(answers.includes('item 5'));
    assert.ok(answers.includes(null));
  });

  test('one chat is sequential, different chats run in parallel', async () => {
    log.length = 0;
    mock.push(textUpdate('/slow', { chat: 1 }), textUpdate('after', { chat: 1 }), textUpdate('other', { chat: 2 }));
    await until(() => log.includes('text:1:after'));
    assert.ok(log.indexOf('text:2:other') < log.indexOf('slow:1'), 'chat 2 is not blocked by chat 1');
    assert.ok(log.indexOf('slow:1') < log.indexOf('text:1:after'), 'chat 1 keeps order');
  });

  test('errors go to bot.catch', async () => {
    mock.push(textUpdate('/boom'));
    await until(() => sent().includes('error: boom'));
  });
});

describe('Webhook', () => {
  test('webhookCallback checks the secret and dispatches', async () => {
    const mock = await startMock();
    const bot = new Bot('123:abc', { throttle: false, apiRoot: mock.root });
    const got = [];
    bot.on('message', (ctx) => got.push(ctx.message.text));
    const handler = bot.webhookCallback({ secretToken: 's3cret', waitForHandlers: true });
    const { createServer } = await import('node:http');
    const server = createServer(handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const body = JSON.stringify(textUpdate('hook'));
    const bad = await fetch(url, { method: 'POST', body, headers: { 'x-telegram-bot-api-secret-token': 'nope' } });
    assert.equal(bad.status, 401);
    const ok = await fetch(url, { method: 'POST', body, headers: { 'x-telegram-bot-api-secret-token': 's3cret' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(got, ['hook']);
    server.closeAllConnections();
    server.close();
    await mock.close();
  });
});
