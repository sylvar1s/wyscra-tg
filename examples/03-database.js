// 03. База данных: бот-записная книжка.
// Данные сохраняются в файл notes.db (SQLite, ничего устанавливать не нужно).
// Хотите PostgreSQL? Замените 'notes.db' на 'postgres://user:pass@host/db' — код не меняется.
// node 03-database.js
import { Bot } from 'wyscra-tg';

const bot = new Bot({ db: 'notes.db' });
const notes = bot.db.collection('notes'); // своя «таблица»

bot.command('start', 'Помощь', (ctx) =>
  ctx.reply('📒 Я сохраняю заметки.\n\n/add текст — добавить\n/list — мои заметки\n/stats — статистика'),
);

bot.command('add', 'Добавить заметку', async (ctx) => {
  if (!ctx.args) return ctx.reply('Напишите так: /add купить молоко');
  await notes.set(`${ctx.from.id}:${Date.now()}`, { userId: ctx.from.id, text: ctx.args, createdAt: Date.now() });

  // ctx.user — профиль пользователя в базе, изменения сохраняются сами
  ctx.user.notesCount = (ctx.user.notesCount ?? 0) + 1;
  await ctx.reply(`✅ Сохранено. У вас заметок: ${ctx.user.notesCount}`);
});

bot.command('list', 'Мои заметки', async (ctx) => {
  const mine = await notes.find({ userId: ctx.from.id }); // поиск по полю
  if (!mine.length) return ctx.reply('Заметок пока нет. Добавьте: /add текст');

  // Список со страницами: нажатие на заметку открывает её
  await ctx.paginate(mine, {
    perPage: 5,
    title: (page, pages) => `📒 Ваши заметки (${mine.length}), стр. ${page}/${pages}`,
    label: (note) => note.text.slice(0, 40),
    onSelect: (c, note) =>
      c.reply(`📝 ${note.text}\n\n🕒 ${new Date(note.createdAt).toLocaleString('ru-RU')}`, {
        inline: [
          {
            text: '🗑 Удалить',
            onClick: async (cc) => {
              await notes.delete(note.id);
              cc.user.notesCount = Math.max(0, (cc.user.notesCount ?? 1) - 1);
              await cc.editText('🗑 Удалено');
            },
          },
        ],
      }),
  });
});

bot.command('stats', 'Статистика', async (ctx) =>
  ctx.reply(
    `👥 Пользователей бота: ${await bot.db.users.count()}\n` +
      `📝 Заметок всего: ${await notes.count()}\n` +
      `🙋 Ваших: ${await notes.count({ userId: ctx.from.id })}`,
  ),
);

bot.start();
