// 12. Админ-панель: статистика, рассылка, список пользователей, выгрузка в CSV.
// Укажите свой Telegram id в .env:  ADMIN_ID=123456789  (узнать id: напишите боту /start)
// node 12-admin-panel.js
import { Bot } from 'wyscra-tg';

const bot = new Bot({ db: 'bot.db' });

if (process.env.ADMIN_ID) bot.admin(); // команда /admin для админов из ADMIN_ID
else console.log('Добавьте ADMIN_ID=ваш_id в .env, чтобы включить /admin');

bot.command('start', (ctx) => ctx.reply(`Привет! Ваш Telegram id: ${ctx.from.id}\n\nУкажите его в .env как ADMIN_ID и откройте /admin`));

// Статистика доступна и в коде
bot.command('stats', async (ctx) => {
  const s = await bot.stats();
  await ctx.reply(`👥 Пользователей: ${s.users}\n🟢 Активны сегодня: ${s.activeToday}\n🆕 Новых за неделю: ${s.newWeek}`);
});

// Отчёт в консоль раз в час
bot.every('1h', async () => {
  const s = await bot.stats();
  console.log(`[${new Date().toLocaleTimeString('ru-RU')}] пользователей: ${s.users}, активных за сутки: ${s.activeToday}`);
});

bot.on('text', (ctx) => ctx.reply('Я тестовый бот. Админ-панель: /admin'));

bot.start();
