// 10. Inline-режим: бот работает в любом чате через «@имя_бота запрос».
// Включите режим у @BotFather: /setinline → выберите бота → введите подсказку.
// node 10-inline-mode.js
import { Bot } from 'wyscra-tg';

const bot = new Bot();

const ANIMALS = { кот: '🐱', собака: '🐶', лиса: '🦊', панда: '🐼', тигр: '🐯', коала: '🐨', лев: '🦁', пингвин: '🐧' };

bot.command('start', (ctx) =>
  ctx.reply('Напишите в любом чате @' + bot.me.username + ' кот', {
    inline: [
      [{ text: '🔍 Попробовать здесь', inlineHere: 'кот' }],
      [{ text: '📤 Отправить в другой чат', share: 'лиса' }],
    ],
  }),
);

bot.on('inline_query', (ctx) => {
  const query = ctx.inlineQuery.query.trim().toLowerCase();
  const results = Object.entries(ANIMALS)
    .filter(([name]) => name.includes(query))
    .map(([name, emoji]) => ({
      id: name,
      title: `${emoji} ${name}`,
      description: 'Нажмите, чтобы отправить',
      text: `${emoji} Это ${name}!`,
    }));

  if (query) {
    results.unshift({ id: 'shout', title: `📣 ${query.toUpperCase()}`, description: 'Крикнуть', text: `📣 ${query.toUpperCase()}!` });
    results.push({ id: 'pic', title: 'Случайная картинка', photo: `https://picsum.photos/seed/${encodeURIComponent(query)}/600/400` });
  }

  return ctx.answerInline(results, { cache: '10s' });
});

bot.start();
