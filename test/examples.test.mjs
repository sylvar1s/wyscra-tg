// Runs every example as a real process against the mock Bot API and walks through its scenario.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { startMock, until } from './mock-server.mjs';

let uid = 1_000_000;
const user = (id = 20, extra = {}) => ({ id, is_bot: false, first_name: 'Ann', ...extra });

async function runExample(file, script, { env = {}, handlers = {} } = {}) {
  const mock = await startMock(handlers);
  const cwd = mkdtempSync(join(tmpdir(), 'ex-'));
  const child = spawn(process.execPath, [resolve('examples', file)], {
    cwd,
    env: { ...process.env, BOT_TOKEN: '123:TEST', BOT_API_ROOT: mock.root, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const texts = () => mock.calls.filter((c) => c.params?.text !== undefined && c.method !== 'getUpdates');
  const last = () => texts().at(-1)?.params ?? {};
  const h = {
    mock,
    calls: (m) => mock.calls.filter((c) => c.method === m),
    send(text, { from = user(), chat, entities, extra = {} } = {}) {
      const message = { message_id: ++uid, date: Math.floor(Date.now() / 1000), chat: chat ?? { id: from.id, type: 'private' }, from, text, ...extra };
      if (text?.startsWith('/')) message.entities = entities ?? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }];
      if (text === undefined) delete message.text;
      mock.push({ update_id: ++uid, message });
    },
    click(data, { from = user(), chatId } = {}) {
      mock.push({ update_id: ++uid, callback_query: { id: String(++uid), from, chat_instance: 'c', data, message: { message_id: 5, date: 1, chat: { id: chatId ?? from.id, type: 'private' }, text: 'x' } } });
    },
    push: (u) => mock.push({ update_id: ++uid, ...u }),
    async expect(re, ms = 5000) {
      await until(() => texts().some((c) => re.test(c.params.text)), ms);
      return texts().filter((c) => re.test(c.params.text)).at(-1).params;
    },
    last,
    /** inline buttons of the last message that had them */
    buttons() {
      const withKb = mock.calls.filter((c) => c.params?.reply_markup?.inline_keyboard?.length).at(-1);
      return withKb.params.reply_markup.inline_keyboard.flat();
    },
    button(text) {
      const b = h.buttons().find((x) => x.text.includes(text));
      if (!b) throw new Error(`No button "${text}" in ${JSON.stringify(h.buttons().map((x) => x.text))}`);
      return b.callback_data;
    },
  };
  try {
    await until(() => out.includes('запущен'), 10_000);
    await script(h);
  } catch (e) {
    const recent = mock.calls.filter((c) => c.method !== 'getUpdates').slice(-8).map((c) => `${c.method}: ${c.params?.text ?? ''}`);
    throw new Error(`${e.message}\n--- output ---\n${out}\n--- last calls ---\n${recent.join('\n')}`);
  } finally {
    child.kill();
    await mock.close();
    await new Promise((r) => setTimeout(r, 150));
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('examples', { concurrency: 4 }, () => {
  test('01-echo', () =>
    runExample('01-echo.js', async (h) => {
      h.send('/start');
      await h.expect(/Привет, Ann/);
      h.send('как дела?');
      await h.expect(/^как дела\?$/);
    }));

  test('02-buttons', () =>
    runExample('02-buttons.js', async (h) => {
      h.send('🔘 Кнопки под сообщением');
      await h.expect(/Нравится библиотека/);
      h.click(h.button('👍 Да'));
      await h.expect(/Спасибо! ❤️/);
      h.send('🔢 Счётчик');
      await h.expect(/^Счётчик: 0$/);
      h.click(h.button('➕'));
      await h.expect(/^Счётчик: 1$/);
      h.send('/vote');
      await h.expect(/любимый язык/);
      h.click('Python');
      await h.expect(/Вы выбрали: Python/);
      h.send('⌨️ Цифры');
      await h.expect(/Нажмите цифру/);
      assert.equal(h.last().reply_markup.keyboard.length, 3, '9 buttons in 3 rows');
    }));

  test('03-database', () =>
    runExample('03-database.js', async (h) => {
      h.send('/add купить молоко');
      await h.expect(/Сохранено. У вас заметок: 1/);
      h.send('/add позвонить');
      await h.expect(/заметок: 2/);
      h.send('/list');
      await h.expect(/Ваши заметки \(2\)/);
      h.click(h.button('купить молоко'));
      await h.expect(/📝 купить молоко/);
      h.click(h.button('Удалить'));
      await h.expect(/Удалено/);
      h.send('/stats');
      await h.expect(/Заметок всего: 1/);
    }));

  test('04-survey', () =>
    runExample('04-survey.js', async (h) => {
      h.send('/survey');
      await h.expect(/1\/3/);
      h.send('Ann');
      await h.expect(/2\/3/);
      h.send('много');
      await h.expect(/Введите возраст числом/);
      h.send('30');
      await h.expect(/3\/3/);
      h.click('5');
      await h.expect(/Спасибо, Ann! Ваша оценка: ⭐⭐⭐⭐⭐/);
      h.send('/me');
      await h.expect(/Ann, 30 лет, оценка 5\/5/);
    }));

  test('05-shop (smoke)', () =>
    runExample('05-shop.js', async (h) => {
      h.send('/start');
      await h.expect(/Что хотите/);
    }));

  test('06-stars-payments', () =>
    runExample('06-stars-payments.js', async (h) => {
      h.send('/start');
      await h.expect(/Цена: 50/);
      h.click(h.button('Купить'));
      await until(() => h.calls('sendInvoice').length === 1);
      assert.equal(h.calls('sendInvoice')[0].params.currency, 'XTR');
      h.push({ pre_checkout_query: { id: 'pq', from: user(), currency: 'XTR', total_amount: 50, invoice_payload: 'premium' } });
      await until(() => h.calls('answerPreCheckoutQuery').length === 1);
      assert.equal(h.calls('answerPreCheckoutQuery')[0].params.ok, true);
      h.send(undefined, { extra: { successful_payment: { currency: 'XTR', total_amount: 50, invoice_payload: 'premium', telegram_payment_charge_id: 'ch1', provider_payment_charge_id: '' } } });
      await h.expect(/Премиум активирован/);
      h.send('/secret');
      await h.expect(/Секретный контент/);
      h.send('/refund');
      await h.expect(/Звёзды возвращены/);
      assert.equal(h.calls('refundStarPayment')[0].params.telegram_payment_charge_id, 'ch1');
    }));

  test('07-group-moderator', () =>
    runExample(
      '07-group-moderator.js',
      async (h) => {
        const chat = { id: -100500, type: 'supergroup', title: 'Группа' };
        const admin = user(500, { first_name: 'Админ' });
        const bad = { message_id: 77, date: 1, chat, from: user(31, { first_name: 'Спамер' }), text: 'привет' };
        h.send('/warn', { from: admin, chat, extra: { reply_to_message: bad } });
        await h.expect(/Спамер, предупреждение 1\/3/);
        h.send('/mute 2h', { from: admin, chat, extra: { reply_to_message: bad } });
        await h.expect(/не может писать 2h/);
        h.send('/ban', { from: user(31), chat, extra: { reply_to_message: bad } });
        await h.expect(/Только для админов/);
        h.send('Лучшее казино тут', { from: user(32, { first_name: 'Бот' }), chat });
        await h.expect(/реклама запрещена/);
        assert.ok(h.calls('deleteMessage').length >= 1);
        h.send(undefined, { chat, extra: { new_chat_members: [user(33, { first_name: 'Новичок' })] } });
        await h.expect(/Добро пожаловать, Новичок/);
      },
      { handlers: { getChatAdministrators: () => [{ status: 'creator', user: user(500) }] } },
    ));

  test('08-multilang', () =>
    runExample('08-multilang.js', async (h) => {
      h.send('/start', { from: user(20, { language_code: 'en' }) });
      await h.expect(/Hi, Ann!/);
      h.click(h.button('Русский'));
      await h.expect(/Язык: русский/);
      h.send('/apples 5');
      await h.expect(/У вас 5 яблок/);
      h.send('/apples 3');
      await h.expect(/У вас 3 яблока/);
    }));

  test('09-reminders', () =>
    runExample('09-reminders.js', async (h) => {
      h.send('/remind 1s полить цветы');
      await h.expect(/Напомню/);
      h.send('/list');
      await h.expect(/полить цветы/);
      await h.expect(/⏰ Напоминание: полить цветы/, 15_000);
      h.send('/remind завтра');
      await h.expect(/Не понял время|Формат/);
    }));

  test('10-inline-mode', () =>
    runExample('10-inline-mode.js', async (h) => {
      h.push({ inline_query: { id: 'iq', from: user(), query: 'ко', offset: '' } });
      await until(() => h.calls('answerInlineQuery').length === 1);
      const titles = h.calls('answerInlineQuery')[0].params.results.map((r) => r.title);
      assert.ok(titles.includes('🐱 кот') && titles.includes('🐨 коала'), titles.join(','));
      h.send('/start');
      await h.expect(/@test_bot кот/);
    }));

  test('11-mini-app', async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    await runExample(
      '11-mini-app.js',
      async (h) => {
        h.send('/start');
        await h.expect(/Откройте мини-приложение/);
        assert.equal(h.buttons()[0].web_app.url, 'https://example.com/app');
        const page = await fetch(`http://127.0.0.1:${port}/`);
        assert.match(await page.text(), /telegram-web-app\.js/);
        const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 42, first_name: 'Иван' }) };
        const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
        const secret = createHmac('sha256', 'WebAppData').update('123:TEST').digest();
        const initData = new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString();
        const r = await fetch(`http://127.0.0.1:${port}/api/click`, { method: 'POST', body: initData });
        assert.deepEqual(await r.json(), { name: 'Иван', clicks: 1 });
        const fake = await fetch(`http://127.0.0.1:${port}/api/click`, { method: 'POST', body: initData.replace('42', '43') });
        assert.equal(fake.status, 401);
      },
      { env: { WEBAPP_URL: 'https://example.com/app', PORT: String(port) } },
    );
  });

  test('12-admin-panel', () =>
    runExample(
      '12-admin-panel.js',
      async (h) => {
        h.send('/start', { from: user(900) });
        await h.expect(/Ваш Telegram id: 900/);
        h.send('/admin', { from: user(900) });
        await h.expect(/Админ-панель/);
        h.click(h.button('Статистика'), { from: user(900) });
        await h.expect(/Всего пользователей: 1/);
        h.send('/stats', { from: user(901) });
        await h.expect(/Пользователей: 2/);
      },
      { env: { ADMIN_ID: '900' } },
    ));

  test('13-userbot and TypeScript examples compile', () => {
    execFileSync(process.execPath, ['--check', resolve('examples/13-userbot.js')]);
    execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', resolve('examples/typescript/tsconfig.json')]);
  });
});
