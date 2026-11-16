// 07. Модератор группы: приветствие, бан/мут, предупреждения, антиспам, проверка подписки.
//
// Добавьте бота в группу администратором (права: удалять сообщения, банить).
// Чтобы бот видел все сообщения, отключите Privacy Mode у @BotFather (/setprivacy → Disable) или сделайте его админом.
// Проверка подписки (необязательно): CHANNEL=@my_channel в .env, бот должен быть админом и в канале.
// node 07-group-moderator.js
import { Bot } from 'wyscra-tg';

const bot = new Bot({
  db: 'moderator.db',
  antiFlood: { limit: 5, per: '10s', message: '🛑 Не флудите!' }, // не больше 5 сообщений за 10 секунд
});
const CHANNEL = process.env.CHANNEL;
const STOP_WORDS = /казино|ставки на спорт|crypto bonus/i;

bot.command('start', (ctx) =>
  ctx.reply('🛡 Я модератор. Добавьте меня в группу админом.\n\nКоманды для админов (ответом на сообщение):\n/ban /kick /mute 1h /unmute /warn'),
);

// Приветствие новичков
bot.on('new_chat_members', (ctx) => {
  const names = ctx.msg.new_chat_members.filter((u) => !u.is_bot).map((u) => u.first_name);
  if (names.length) return ctx.reply(`Добро пожаловать, ${names.join(', ')}! 👋 Прочитайте правила в закрепе.`);
});

// Команды только для админов чата
const admin = (handler) => async (ctx) => {
  if (!(await ctx.isAdmin())) return ctx.reply('Только для админов');
  if (!ctx.msg.reply_to_message) return ctx.reply('Ответьте этой командой на сообщение нарушителя');
  return handler(ctx, ctx.msg.reply_to_message.from);
};

bot.command('ban', 'Забанить (ответом)', admin(async (ctx, user) => {
  await ctx.ban();
  await ctx.reply(`🔨 ${user.first_name} забанен`);
}));
bot.command('kick', 'Выгнать (ответом)', admin(async (ctx, user) => {
  await ctx.kick();
  await ctx.reply(`👢 ${user.first_name} выгнан`);
}));
bot.command('mute', 'Замутить: /mute 1h', admin(async (ctx, user) => {
  const time = ctx.args || '1h'; // 30m, 2h, 1d, 1w
  await ctx.mute(undefined, time);
  await ctx.reply(`🔇 ${user.first_name} не может писать ${time}`);
}));
bot.command('unmute', 'Снять мут', admin(async (ctx, user) => {
  await ctx.unmute();
  await ctx.reply(`🔊 ${user.first_name} снова может писать`);
}));

// Предупреждения: 3 предупреждения = бан. Счётчик хранится в базе
bot.command('warn', 'Предупреждение (ответом)', admin(async (ctx, user) => {
  const warns = ctx.db.collection('warns');
  const key = `${ctx.chatId}:${user.id}`;
  const count = await warns.increment(key, 'count');
  if (count >= 3) {
    await ctx.ban(user.id);
    await warns.delete(key);
    return ctx.reply(`⛔ ${user.first_name} получил 3 предупреждения и забанен`);
  }
  await ctx.reply(`⚠️ ${user.first_name}, предупреждение ${count}/3`);
}));

// Фильтр стоп-слов: удалить сообщение и замутить на 10 минут
bot.on('text', async (ctx, next) => {
  if (ctx.isGroup && STOP_WORDS.test(ctx.text) && !(await ctx.isAdmin())) {
    await ctx.deleteMessage();
    await ctx.mute(ctx.from.id, '10m');
    return ctx.reply(`${ctx.from.first_name}, реклама запрещена. Мут на 10 минут.`);
  }
  return next();
});

// Писать могут только подписчики канала
if (CHANNEL) {
  bot.on('message', async (ctx, next) => {
    if (ctx.isGroup && !(await ctx.isAdmin()) && !(await ctx.isSubscribed(CHANNEL))) {
      await ctx.deleteMessage();
      return ctx.reply(`${ctx.from.first_name}, чтобы писать здесь, подпишитесь на ${CHANNEL}`, {
        inline: [{ text: '📢 Подписаться', url: `https://t.me/${CHANNEL.replace('@', '')}` }],
      });
    }
    return next();
  });
}

bot.start();
