// Routing throughput benchmark (no network): node test/bench.mjs
import { Bot, session } from '../dist/index.js';

const bot = new Bot('1:x', { botInfo: { id: 1, is_bot: true, first_name: 'b', username: 'b' } });
let handled = 0;
bot.use(session());
bot.command('start', () => { handled++; });
bot.hears(/^ping (\d+)$/, () => { handled++; });
bot.on('photo', () => { handled++; });
bot.action(/^x:/, () => { handled++; });
bot.on('text', (ctx) => { ctx.session.n = (ctx.session.n ?? 0) + 1; handled++; });

const N = 200_000;
const updates = Array.from({ length: N }, (_, i) => ({
  update_id: i,
  message: { message_id: i, date: 1, chat: { id: i % 1000, type: 'private' }, from: { id: i % 1000, is_bot: false, first_name: 'u' }, text: i % 3 ? `hello ${i}` : `ping ${i}` },
}));
const t = performance.now();
await Promise.all(updates.map((u) => bot.handleUpdate(u)));
const ms = performance.now() - t;
console.log(`${N} updates, ${handled} handled in ${ms.toFixed(0)} ms → ${Math.round(N / (ms / 1000)).toLocaleString('en')} updates/s`);
