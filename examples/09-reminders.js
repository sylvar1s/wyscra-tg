// 09. Напоминания и задачи по расписанию.
// Напоминания хранятся в базе, поэтому не теряются при перезапуске бота.
// node 09-reminders.js
import { Bot, parseDuration } from 'wyscra-tg';

const bot = new Bot({ db: 'reminders.db' });
const reminders = bot.db.collection('reminders');

bot.command('start', 'Помощь', (ctx) =>
  ctx.reply(
    '⏰ Напоминалка\n\n' +
      '/remind 10m Позвонить маме — через 10 минут\n' +
      '/remind 2h30m Выключить духовку\n' +
      '/list — мои напоминания\n' +
      '/daily — утренняя цитата в 9:00',
  ),
);

bot.command('remind', 'Новое напоминание', async (ctx) => {
  const m = /^(\S+)\s+([\s\S]+)$/.exec(ctx.args);
  if (!m) return ctx.reply('Формат: /remind 30m текст\nВремя: 30s, 10m, 2h, 1d, 1h30m');
  let seconds;
  try {
    seconds = parseDuration(m[1]);
  } catch {
    return ctx.reply('Не понял время. Примеры: 30s, 10m, 2h, 1d');
  }
  const at = Date.now() + seconds * 1000;
  await reminders.set(`${ctx.from.id}:${at}`, { chatId: ctx.chatId, text: m[2], at });
  await ctx.reply(`✅ Напомню ${new Date(at).toLocaleString('ru-RU')}`);
});

bot.command('list', 'Мои напоминания', async (ctx) => {
  const mine = (await reminders.find((r) => r.chatId === ctx.chatId)).sort((a, b) => a.at - b.at);
  if (!mine.length) return ctx.reply('Напоминаний нет');
  await ctx.reply(mine.map((r) => `• ${new Date(r.at).toLocaleString('ru-RU')} — ${r.text}`).join('\n'));
});

// Каждые 10 секунд отправляем наступившие напоминания
bot.every('10s', async () => {
  for (const r of await reminders.find((r) => r.at <= Date.now())) {
    await bot.send(r.chatId, `⏰ Напоминание: ${r.text}`).catch(() => {});
    await reminders.delete(r.id);
  }
});

// Подписка на ежедневную рассылку
bot.command('daily', 'Утренняя цитата', (ctx) => {
  ctx.user.dailyQuote = !ctx.user.dailyQuote;
  return ctx.reply(ctx.user.dailyQuote ? '✅ Буду присылать цитату каждый день в 9:00' : '❌ Подписка выключена');
});

const QUOTES = [
  '«Лучший способ начать — перестать говорить и начать делать.» — Уолт Дисней',
  '«Сложнее всего начать действовать, всё остальное зависит только от упорства.» — Амелия Эрхарт',
  '«Успех — это идти от неудачи к неудаче, не теряя энтузиазма.» — Уинстон Черчилль',
];

// Каждый день в 9:00 (время сервера) — только подписчикам
bot.daily('09:00', () => bot.broadcast(QUOTES[Math.floor(Math.random() * QUOTES.length)], { filter: { dailyQuote: true } }));

// По пятницам в 18:00 (формат cron: минуты часы день месяц день_недели)
bot.cron('0 18 * * 5', () => bot.broadcast('🎉 Пятница! Хороших выходных!', { filter: { dailyQuote: true } }));

bot.start();
