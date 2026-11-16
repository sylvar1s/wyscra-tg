// Runs examples/05-shop.js as a real process against the mock Bot API and clicks through it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { callbackUpdate, startMock, textUpdate, until } from './mock-server.mjs';

test('examples/05-shop.js works end to end', async () => {
  const mock = await startMock();
  const cwd = mkdtempSync(join(tmpdir(), 'shop-'));
  const child = spawn(process.execPath, [resolve('examples/05-shop.js')], {
    cwd,
    env: { ...process.env, BOT_TOKEN: '1:x', BOT_API_ROOT: mock.root, ADMIN_ID: '20' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  try {
    await until(() => out.includes('База данных: sqlite'), 10_000);
    assert.match(out, /Telegram @wyscra/);
    const sent = () => mock.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
    const lastSent = () => sent().at(-1).params;

    mock.push(textUpdate('/start'));
    await until(() => sent().length >= 1);
    assert.equal(lastSent().reply_markup.keyboard[0][0].text, '🛒 Каталог');

    mock.push(textUpdate('🛒 Каталог'));
    await until(() => sent().length >= 2);
    const buttons = lastSent().reply_markup.inline_keyboard;
    assert.equal(buttons.length, 2, 'one product per row');

    mock.push(callbackUpdate(buttons[0][0].callback_data));
    await until(() => sent().some((c) => /Куплено/.test(c.params.text)));
    assert.match(lastSent().text, /Остаток: 500₽/);

    mock.push(textUpdate('💰 Баланс'));
    await until(() => /Баланс: 500₽\nЗаказов: 1/.test(lastSent().text ?? ''));

    mock.push(textUpdate('📝 Отзыв'));
    await until(() => /Оцените/.test(lastSent().text ?? ''));
    mock.push(textUpdate('9'));
    await until(() => /цифру/.test(lastSent().text ?? ''));
    mock.push(textUpdate('5'));
    await until(() => /пару слов/.test(lastSent().text ?? ''));
    mock.push(textUpdate('Отлично'));
    await until(() => /Спасибо/.test(lastSent().text ?? ''));

    mock.push(textUpdate('/news Скидки'));
    await until(() => /Отправлено: 1/.test(lastSent().text ?? ''));
  } catch (e) {
    const texts = mock.calls.filter((c) => c.params?.text).map((c) => `${c.method}: ${c.params.text}`);
    throw new Error(`${e.message}\n--- bot output ---\n${out}\n--- last API calls ---\n${texts.slice(-6).join('\n')}`);
  } finally {
    child.kill();
    await mock.close();
    await new Promise((r) => setTimeout(r, 200));
    rmSync(cwd, { recursive: true, force: true });
  }
});
