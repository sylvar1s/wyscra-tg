// TypeScript example. Run: npx tsx examples/bot.ts (BOT_TOKEN in .env)
import { Bot, file, html } from 'wyscra-tg';

// Подсказки редактора для своих полей:
declare module 'wyscra-tg' {
  interface UserData {
    clicks?: number;
    name?: string;
  }
}

const bot = new Bot({ db: 'bot.db' });

bot.command('start', 'Начать', (ctx) =>
  ctx.reply(html`Привет, <b>${ctx.from?.first_name}</b>!`, {
    inline: [
      [{ text: '👍 Нажми', onClick: (c) => c.editText(`Нажатий: ${(c.user.clicks = (c.user.clicks ?? 0) + 1)}`) }],
      [{ text: 'Канал', url: 'https://t.me/wyscra' }],
    ],
  }),
);

bot.command('name', 'Познакомиться', async (ctx) => {
  const answer = await ctx.ask('Как тебя зовут?');
  ctx.user.name = answer.text;
  await ctx.reply(`Приятно познакомиться, ${answer.text}!`);
});

bot.command('menu', 'Меню', (ctx) =>
  ctx.reply('Выбери:', { keyboard: [['Фото', 'Кубик'], [{ text: '📱 Телефон', contact: true }]] }),
);
bot.hears('Фото', (ctx) => ctx.replyWithPhoto('https://picsum.photos/600', { caption: 'Случайное фото' }));
bot.hears('Кубик', (ctx) => ctx.replyWithDice('🎲'));
bot.on('contact', (ctx) => ctx.reply(`Телефон: ${ctx.msg.contact.phone_number}`, { removeKeyboard: true }));

// Типы сужаются: здесь ctx.message.photo точно есть
bot.on('message:photo', async (ctx) => {
  const largest = ctx.message.photo.at(-1)!;
  await ctx.download(`./photo_${largest.file_unique_id}.jpg`);
  await ctx.reply(`Сохранил фото ${largest.width}×${largest.height}`);
});

bot.command('doc', (ctx) => ctx.replyWithDocument(file(Buffer.from('hello'), 'hello.txt')));
bot.on('text', (ctx) => ctx.reply(ctx.text));

bot.start();
