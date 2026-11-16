import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Bot, I18n, checkLoginWidget, file, nextCron, parseCron, parseDuration, validateWebAppData, validateWebAppSignature } from '../dist/index.js';
import { callbackUpdate, startMock, textUpdate, until, wait } from './mock-server.mjs';

const botInfo = { id: 1, is_bot: true, first_name: 'b', username: 'test_bot' };
const TOKEN = '123456:TEST-TOKEN';
const dir = mkdtempSync(join(tmpdir(), 'wyscra-all-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let mock;
let adminCalls = 0;
before(async () => {
  mock = await startMock({
    getChatAdministrators: () => (adminCalls++, [{ status: 'creator', user: { id: 500, is_bot: false, first_name: 'Boss' } }]),
    getChatMember: (p) => ({ status: Number(p.user_id) === 600 ? 'member' : Number(p.user_id) === 601 ? 'left' : 'kicked', user: { id: Number(p.user_id) } }),
    sendPhoto: (p) => ({ message_id: 1, date: 1, chat: { id: Number(p.chat_id), type: 'private' }, photo: [{ file_id: 'SMALL', file_unique_id: 's', width: 1, height: 1 }, { file_id: 'BIG_FILE_ID', file_unique_id: 'b', width: 9, height: 9 }] }),
  });
});
after(() => mock.close());

const newBot = (opts = {}) => new Bot('1:x', { apiRoot: mock.root, botInfo, throttle: false, ...opts });
const calls = (m) => mock.calls.filter((c) => c.method === m);
const last = (m = 'sendMessage') => calls(m).at(-1)?.params;
const groupMsg = (text, { user = 20, replyTo } = {}) => {
  const u = textUpdate(text, { chat: -100, user });
  u.message.chat = { id: -100, type: 'supergroup', title: 'G' };
  if (replyTo) u.message.reply_to_message = { message_id: 3, date: 1, chat: u.message.chat, from: { id: replyTo, is_bot: false, first_name: 'Bad' } };
  return u;
};

describe('управление группой', () => {
  test('ban/mute/kick по ответу, сроки строкой', async () => {
    const bot = newBot();
    bot.command('ban', (ctx) => ctx.ban(undefined, { for: '1d' }));
    bot.command('mute', (ctx) => ctx.mute(undefined, '30m'));
    bot.command('kick', (ctx) => ctx.kick());
    bot.command('unmute', (ctx) => ctx.unmute());
    const now = Math.floor(Date.now() / 1000);
    await bot.handleUpdate(groupMsg('/ban', { replyTo: 77 }));
    assert.equal(last('banChatMember').user_id, 77);
    assert.ok(Math.abs(last('banChatMember').until_date - (now + 86400)) < 5);
    await bot.handleUpdate(groupMsg('/mute', { replyTo: 78 }));
    assert.equal(last('restrictChatMember').permissions.can_send_messages, false);
    assert.ok(Math.abs(last('restrictChatMember').until_date - (now + 1800)) < 5);
    await bot.handleUpdate(groupMsg('/unmute', { replyTo: 78 }));
    assert.equal(last('restrictChatMember').permissions.can_send_messages, true);
    await bot.handleUpdate(groupMsg('/kick', { replyTo: 79 }));
    assert.equal(last('unbanChatMember').user_id, 79);
  });

  test('isAdmin с кэшем, onlyAdmins, isSubscribed', async () => {
    const bot = newBot();
    const seen = [];
    bot.onlyAdmins((ctx, next) => (ctx.text === '/secret' ? ctx.reply('ok admin') : next()));
    bot.on('text', async (ctx) => seen.push(`${ctx.from.id}:${await ctx.isAdmin()}`));
    adminCalls = 0;
    await bot.handleUpdate(groupMsg('/secret', { user: 500 }));
    assert.equal(last().text, 'ok admin');
    await bot.handleUpdate(groupMsg('/secret', { user: 20 }));
    await bot.handleUpdate(groupMsg('hi', { user: 21 }));
    assert.deepEqual(seen, ['20:false', '21:false']);
    assert.equal(adminCalls, 1, 'admin list is cached');

    const sub = newBot();
    const res = [];
    sub.on('text', async (ctx) => res.push(await ctx.isSubscribed('@chan')));
    await sub.handleUpdate(textUpdate('a', { user: 600 }));
    await sub.handleUpdate(textUpdate('b', { user: 601 }));
    await sub.handleUpdate(textUpdate('c', { user: 602 }));
    assert.deepEqual(res, [true, false, false]);
  });
});

describe('мини-приложения и вход через Telegram', () => {
  const signWebApp = (fields, token = TOKEN) => {
    const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(token).digest();
    const hash = createHmac('sha256', secret).update(check).digest('hex');
    return new URLSearchParams({ ...fields, hash }).toString();
  };
  const fields = () => ({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAE', user: JSON.stringify({ id: 42, first_name: 'Иван' }) });

  test('validateWebAppData: подлинные, поддельные, устаревшие', () => {
    const data = validateWebAppData(signWebApp(fields()), TOKEN);
    assert.equal(data.user.id, 42);
    assert.equal(data.user.first_name, 'Иван');
    assert.throws(() => validateWebAppData(signWebApp(fields()).replace('42', '43'), TOKEN), /поддельные/);
    assert.throws(() => validateWebAppData(signWebApp(fields(), 'other:token'), TOKEN), /поддельные/);
    const old = { ...fields(), auth_date: String(Math.floor(Date.now() / 1000) - 200000) };
    assert.throws(() => validateWebAppData(signWebApp(old), TOKEN), /устарели/);
  });

  test('validateWebAppSignature (Ed25519, без токена)', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'jwk' }).x;
    const f = fields();
    const check = `777:WebAppData\n` + Object.keys(f).sort().map((k) => `${k}=${f[k]}`).join('\n');
    const signature = sign(null, Buffer.from(check), privateKey).toString('base64url');
    const init = new URLSearchParams({ ...f, signature, hash: 'x' }).toString();
    const pk = Buffer.from(raw, 'base64url').toString('hex');
    assert.equal(validateWebAppSignature(init, 777, { publicKey: pk }).user.id, 42);
    assert.throws(() => validateWebAppSignature(init, 778, { publicKey: pk }), /signature/);
  });

  test('checkLoginWidget', () => {
    const d = { id: 42, first_name: 'Иван', username: 'ivan', auth_date: Math.floor(Date.now() / 1000) };
    const check = Object.keys(d).sort().map((k) => `${k}=${d[k]}`).join('\n');
    const hash = createHmac('sha256', createHash('sha256').update(TOKEN).digest()).update(check).digest('hex');
    assert.equal(checkLoginWidget({ ...d, hash }, TOKEN).id, 42);
    assert.throws(() => checkLoginWidget({ ...d, id: 43, hash }, TOKEN), /поддельные/);
  });
});

describe('оплата звёздами', () => {
  const paymentUpdate = (payload) => {
    const u = textUpdate('x', { user: 30, chat: 30 });
    delete u.message.text;
    u.message.successful_payment = { currency: 'XTR', total_amount: 100, invoice_payload: payload, telegram_payment_charge_id: 'ch_1', provider_payment_charge_id: '' };
    return u;
  };
  test('invoice + onPaid + автоподтверждение + refund', async () => {
    const bot = newBot();
    const paid = [];
    bot.command('buy', (ctx) => ctx.invoice({ title: 'Премиум', stars: 100, onPaid: (c, p) => ((c.user.premium = true), paid.push(p.total_amount)) }));
    bot.onPayment((ctx) => ctx.refund());
    await bot.handleUpdate(textUpdate('/buy', { user: 30, chat: 30 }));
    const inv = last('sendInvoice');
    assert.equal(inv.currency, 'XTR');
    assert.deepEqual(inv.prices, [{ label: 'Премиум', amount: 100 }]);

    await bot.handleUpdate({ update_id: 9001, pre_checkout_query: { id: 'pq1', from: { id: 30, is_bot: false, first_name: 'U' }, currency: 'XTR', total_amount: 100, invoice_payload: inv.payload } });
    assert.equal(last('answerPreCheckoutQuery').ok, true);

    await bot.handleUpdate(paymentUpdate(inv.payload));
    assert.deepEqual(paid, [100]);
    assert.equal((await bot.db.users.get(30)).premium, true);
    assert.equal(last('refundStarPayment').telegram_payment_charge_id, 'ch_1');
  });
  test('onPreCheckout может отказать', async () => {
    const bot = newBot();
    bot.onPreCheckout(() => 'Товар закончился');
    await bot.handleUpdate({ update_id: 9002, pre_checkout_query: { id: 'pq2', from: { id: 31, is_bot: false, first_name: 'U' }, currency: 'XTR', total_amount: 5, invoice_payload: 'p' } });
    assert.deepEqual([last('answerPreCheckoutQuery').ok, last('answerPreCheckoutQuery').error_message], [false, 'Товар закончился']);
    assert.equal(calls('answerPreCheckoutQuery').filter((c) => c.params.pre_checkout_query_id === 'pq2').length, 1, 'answered once');
  });
});

describe('inline-режим и листалка', () => {
  test('answerInline простыми объектами', async () => {
    const bot = newBot();
    bot.on('inline_query', (ctx) =>
      ctx.answerInline([{ title: 'Привет', text: 'Всем привет', inline: [{ text: 'Сайт', url: 'https://t.me' }] }, { photo: 'https://x/cat.jpg' }], { cache: '1m' }),
    );
    await bot.handleUpdate({ update_id: 9100, inline_query: { id: 'iq', from: { id: 1, is_bot: false, first_name: 'U' }, query: 'q', offset: '' } });
    const p = last('answerInlineQuery');
    assert.equal(p.cache_time, 60);
    assert.deepEqual([p.results[0].type, p.results[0].input_message_content.message_text, p.results[0].reply_markup.inline_keyboard[0][0].url], ['article', 'Всем привет', 'https://t.me']);
    assert.deepEqual([p.results[1].type, p.results[1].id], ['photo', '1']);
  });

  test('paginate текстом и кнопками', async () => {
    const bot = newBot();
    const items = Array.from({ length: 25 }, (_, i) => `Товар ${i + 1}`);
    const picked = [];
    bot.command('list', (ctx) => ctx.paginate(items, { format: (x, i) => `${i + 1}) ${x}` }));
    bot.command('pick', (ctx) => ctx.paginate(items, { perPage: 5, onSelect: (c, x) => picked.push(x) }));
    await bot.handleUpdate(textUpdate('/list'));
    let m = last();
    assert.match(m.text, /^Страница 1 из 3\n1\) Товар 1/);
    assert.ok(!m.text.includes('Товар 11'));
    const nav = m.reply_markup.inline_keyboard.at(-1);
    assert.equal(nav[1].text, '1/3');
    await bot.handleUpdate(callbackUpdate(nav[2].callback_data));
    assert.match(last('editMessageText').text, /11\) Товар 11/);

    await bot.handleUpdate(textUpdate('/pick'));
    m = last();
    assert.equal(m.reply_markup.inline_keyboard.length, 6, '5 items + nav');
    await bot.handleUpdate(callbackUpdate(m.reply_markup.inline_keyboard[2][0].callback_data));
    assert.deepEqual(picked, ['Товар 3']);
  });
});

describe('переводы', () => {
  const locales = {
    ru: { hello: 'Привет, {name}!', apples: { one: '{count} яблоко', few: '{count} яблока', many: '{count} яблок', other: '{count} яблока' }, menu: { title: 'Меню' } },
    en: { hello: 'Hello, {name}!', apples: { one: '{count} apple', other: '{count} apples' } },
  };
  test('I18n: переменные, формы множественного числа, запасной язык', () => {
    const i = new I18n({ locales, defaultLocale: 'ru' });
    assert.equal(i.t('en-US', 'hello', { name: 'Ann' }), 'Hello, Ann!');
    assert.deepEqual([1, 3, 5, 21].map((n) => i.t('ru', 'apples', { count: n })), ['1 яблоко', '3 яблока', '5 яблок', '21 яблоко']);
    assert.equal(i.t('en', 'menu.title'), 'Меню', 'falls back to default locale');
    assert.equal(i.t('fr', 'hello', { name: 'X' }), 'Привет, X!');
    assert.equal(i.t('ru', 'nope'), 'nope');
  });
  test('ctx.t, ctx.setLang сохраняется, переводы из папки', async () => {
    const ldir = join(dir, 'locales');
    mkdirSync(ldir);
    writeFileSync(join(ldir, 'ru.json'), JSON.stringify(locales.ru));
    writeFileSync(join(ldir, 'en.json'), JSON.stringify(locales.en));
    const bot = newBot({ i18n: { locales: ldir, defaultLocale: 'ru' } });
    bot.command('hi', (ctx) => ctx.reply(ctx.t('hello', { name: ctx.from.first_name })));
    bot.command('en', (ctx) => ctx.setLang('en'));
    const u = textUpdate('/hi', { user: 40, chat: 40 });
    u.message.from.language_code = 'ru';
    await bot.handleUpdate(u);
    assert.equal(last().text, 'Привет, U!');
    await bot.handleUpdate(textUpdate('/en', { user: 40, chat: 40 }));
    await bot.handleUpdate(textUpdate('/hi', { user: 40, chat: 40 }));
    assert.equal(last().text, 'Hello, U!');
    assert.equal(bot.t('en', 'apples', { count: 2 }), '2 apples');
  });
});

describe('антиспам, расписание, длительности', () => {
  test('antiFlood пропускает лимит и предупреждает один раз', async () => {
    const bot = newBot({ antiFlood: { limit: 3, per: '10s', message: 'Не так быстро!' } });
    let handled = 0;
    bot.on('text', () => void handled++);
    for (let i = 0; i < 6; i++) await bot.handleUpdate(textUpdate(`m${i}`, { user: 50, chat: 50 }));
    await bot.handleUpdate(textUpdate('other user', { user: 51, chat: 51 }));
    assert.equal(handled, 4);
    assert.equal(calls('sendMessage').filter((c) => c.params.text === 'Не так быстро!').length, 1);
  });

  test('parseDuration и cron', () => {
    assert.equal(parseDuration('1h30m'), 5400);
    assert.equal(parseDuration('10мин'), 600);
    assert.equal(parseDuration(15), 15);
    assert.throws(() => parseDuration('soon'), /Не понял/);
    const sat = new Date(2026, 10, 14, 12, 0); // Saturday
    const next = nextCron(parseCron('0 9 * * 1-5'), sat);
    assert.deepEqual([next.getDay(), next.getHours(), next.getMinutes()], [1, 9, 0]);
    assert.equal(nextCron(parseCron('*/15 * * * *'), new Date(2026, 0, 1, 10, 7)).getMinutes(), 15);
    assert.throws(() => parseCron('61 * * * *'), /cron/);
  });

  test('every / once / stop', async () => {
    const bot = newBot();
    let n = 0;
    let fired = false;
    bot.every(0.05, () => void n++);
    bot.once(new Date(Date.now() + 30), () => (fired = true));
    bot.every('1h', () => {
      throw new Error('не роняет бота');
    });
    await wait(180);
    assert.ok(n >= 2, `every fired ${n} times`);
    assert.ok(fired);
    await bot.stop();
    const before = n;
    await wait(120);
    assert.equal(n, before, 'stopped with the bot');
  });
});

describe('статистика и админ-панель', () => {
  test('bot.stats и /admin', async () => {
    const bot = newBot();
    bot.admin({ ids: [900] });
    await bot.handleUpdate(textUpdate('hello', { user: 901, chat: 901 }));
    await bot.handleUpdate(textUpdate('/admin', { user: 901, chat: 901 }));
    assert.notEqual(last().text, '⚙️ Админ-панель', 'non-admins do not get the panel');
    await bot.handleUpdate(textUpdate('/admin', { user: 900, chat: 900 }));
    const m = last();
    assert.equal(m.text, '⚙️ Админ-панель');
    await bot.handleUpdate(callbackUpdate(m.reply_markup.inline_keyboard[0][0].callback_data, { user: 900, chat: 900 }));
    assert.match(last('editMessageText').text, /Всего пользователей: 2/);
    const s = await bot.stats();
    assert.equal(s.activeToday, 2);
    await bot.handleUpdate(callbackUpdate(m.reply_markup.inline_keyboard[3][0].callback_data, { user: 900, chat: 900 }));
    const doc = calls('sendDocument').at(-1);
    assert.match(doc.files.document.name, /^users_.*\.csv$/);
    assert.match(doc.files.document.text, /id,first_name/);
  });
});

describe('кэш файлов и генератор проекта', () => {
  test('повторная отправка файла с диска использует file_id', async () => {
    const bot = newBot();
    const path = join(dir, 'pic.jpg');
    writeFileSync(path, 'JPEGDATA');
    await bot.sendPhoto(1, file(path));
    assert.ok(calls('sendPhoto').at(-1).files.photo, 'first time uploaded');
    await wait(10);
    await bot.sendPhoto(2, file(path));
    assert.equal(last('sendPhoto').photo, 'BIG_FILE_ID');
    writeFileSync(path, 'CHANGED-CONTENT');
    await bot.sendPhoto(3, file(path));
    assert.ok(calls('sendPhoto').at(-1).files.photo, 'changed file is uploaded again');
  });

  test('npx wyscra-tg init создаёт рабочий проект', () => {
    const target = join(dir, 'new-bot');
    const out = execFileSync(process.execPath, [resolve('bin/wyscra-tg.mjs'), 'init', target, '--no-install'], { env: { ...process.env, BOT_TOKEN: '1:abc' }, encoding: 'utf8' });
    assert.match(out, /Готово/);
    for (const f of ['package.json', '.env', '.gitignore', 'bot.js']) assert.ok(existsSync(join(target, f)), f);
    assert.match(readFileSync(join(target, '.env'), 'utf8'), /BOT_TOKEN=1:abc/);
    execFileSync(process.execPath, ['--check', join(target, 'bot.js')]);
    assert.equal(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).type, 'module');
  });
});
