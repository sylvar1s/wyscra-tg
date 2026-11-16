// Fair routing benchmark: same handlers + in-memory session, no network, separate process per library.
// node test/bench-compare.mjs            → runs all libraries and prints a table
// node test/bench-compare.mjs <lib> <mode>  (internal)
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const N = 200_000;
const WARMUP = 20_000;
const botInfo = { id: 1, is_bot: true, first_name: 'b', username: 'bench_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };

function makeUpdates(n, offset = 0) {
  return Array.from({ length: n }, (_, k) => {
    const i = k + offset;
    const chat = { id: i % 1000, type: 'private' };
    const from = { id: i % 1000, is_bot: false, first_name: 'u' };
    const kind = i % 5;
    if (kind === 4) return { update_id: i, callback_query: { id: String(i), from, chat_instance: 'c', data: `x:${i}`, message: { message_id: 1, date: 1, chat } } };
    const text = kind === 0 ? '/start' : kind === 1 ? `ping ${i}` : `hello ${i}`;
    const message = { message_id: i, date: 1, chat, from, text };
    if (kind === 0) message.entities = [{ type: 'bot_command', offset: 0, length: 6 }];
    if (kind === 3) (delete message.text, (message.photo = [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }]));
    return { update_id: i, message };
  });
}

async function setup(lib) {
  let handled = 0;
  const hit = () => void handled++;
  if (lib === 'wyscra-tg') {
    // Idiomatic usage: built-in session (no setup). Users are also tracked in the DB, which the others don't do.
    const { Bot } = await import('../dist/index.js');
    const bot = new Bot('1:x', { botInfo, autoAnswerCallbacks: false, session: { initial: () => ({ n: 0 }) } });
    bot.command('start', hit);
    bot.hears(/^ping (\d+)$/, hit);
    bot.on('photo', hit);
    bot.action(/^x:/, hit);
    bot.on('text', (ctx) => (ctx.session.n++, hit()));
    return { handle: (u) => bot.handleUpdate(u), count: () => handled };
  }
  if (lib === 'grammy') {
    const { Bot, session } = await import('grammy');
    const bot = new Bot('1:x', { botInfo });
    bot.use(session({ initial: () => ({ n: 0 }) }));
    bot.command('start', hit);
    bot.hears(/^ping (\d+)$/, hit);
    bot.on('message:photo', hit);
    bot.callbackQuery(/^x:/, hit);
    bot.on('message:text', (ctx) => (ctx.session.n++, hit()));
    return { handle: (u) => bot.handleUpdate(u), count: () => handled };
  }
  if (lib === 'telegraf') {
    const { Telegraf, session } = await import('telegraf');
    const { message } = await import('telegraf/filters');
    const bot = new Telegraf('1:x');
    bot.botInfo = botInfo;
    bot.use(session({ defaultSession: () => ({ n: 0 }) }));
    bot.command('start', hit);
    bot.hears(/^ping (\d+)$/, hit);
    bot.on(message('photo'), hit);
    bot.action(/^x:/, hit);
    bot.on(message('text'), (ctx) => (ctx.session.n++, hit()));
    return { handle: (u) => bot.handleUpdate(u), count: () => handled };
  }
  throw new Error(lib);
}

async function run(lib, mode) {
  const { handle, count } = await setup(lib);
  const warm = makeUpdates(WARMUP, 10_000_000);
  for (const u of warm) await handle(u);
  const updates = makeUpdates(N);
  global.gc?.();
  const before = count();
  const heap0 = process.memoryUsage().heapUsed;
  const t = performance.now();
  if (mode === 'parallel') await Promise.all(updates.map(handle));
  else for (const u of updates) await handle(u);
  const ms = performance.now() - t;
  const heapMb = (process.memoryUsage().heapUsed - heap0) / 1048576;
  console.log(JSON.stringify({ lib, mode, ms, perSec: N / (ms / 1000), handled: count() - before, heapMb }));
}

if (process.argv[2]) {
  await run(process.argv[2], process.argv[3]);
} else {
  const self = fileURLToPath(import.meta.url);
  const rows = [];
  for (const mode of ['sequential', 'parallel']) {
    for (const lib of ['wyscra-tg', 'grammy', 'telegraf']) {
      const results = [];
      for (let r = 0; r < 3; r++) results.push(JSON.parse(execFileSync(process.execPath, ['--expose-gc', self, lib, mode], { encoding: 'utf8' }).trim().split('\n').pop()));
      results.sort((a, b) => a.ms - b.ms);
      rows.push(results[1]); // median of 3
    }
  }
  console.log(`\n${N.toLocaleString('en')} updates (5 handler kinds + session), median of 3 runs, Node ${process.version}\n`);
  console.log('| mode | library | updates/s | time | handled |');
  console.log('|---|---|---:|---:|---:|');
  for (const r of rows) console.log(`| ${r.mode} | ${r.lib} | ${Math.round(r.perSec).toLocaleString('en')} | ${r.ms.toFixed(0)} ms | ${r.handled.toLocaleString('en')} |`);
}
