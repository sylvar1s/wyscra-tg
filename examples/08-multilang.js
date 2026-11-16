// 08. Бот на нескольких языках. Переводы лежат в папке locales/ (ru.json, en.json).
// Язык берётся из настроек Telegram пользователя, его можно сменить кнопкой.
// node 08-multilang.js
import { Bot } from 'wyscra-tg';

const bot = new Bot({
  db: 'multilang.db',
  i18n: { locales: import.meta.dirname + '/locales', defaultLocale: 'ru' },
});

const languageButtons = () => ({
  inline: [
    [
      { text: '🇷🇺 Русский', onClick: (c) => changeLanguage(c, 'ru') },
      { text: '🇬🇧 English', onClick: (c) => changeLanguage(c, 'en') },
    ],
  ],
});

async function changeLanguage(ctx, lang) {
  ctx.setLang(lang); // сохраняется в базе
  await ctx.editText(ctx.t('language_changed'), languageButtons());
}

bot.command('start', (ctx) => ctx.reply(ctx.t('welcome', { name: ctx.from.first_name }), languageButtons()));
bot.command('language', (ctx) => ctx.reply(ctx.t('choose_language'), languageButtons()));

// Формы множественного числа подбираются сами: 1 яблоко, 3 яблока, 5 яблок
bot.command('apples', (ctx) => {
  const count = Number(ctx.args) || Math.ceil(Math.random() * 25);
  return ctx.reply(ctx.t('apples', { count }));
});

bot.on('text', (ctx) => ctx.reply(ctx.t('unknown')));

bot.start();
