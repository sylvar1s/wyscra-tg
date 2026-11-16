// 01. Самый простой бот: повторяет ваши сообщения.
//
// Запуск:
//   1. Создайте файл .env рядом с этим файлом:  BOT_TOKEN=токен_от_@BotFather
//   2. node 01-echo.js
import { Bot } from 'wyscra-tg';

const bot = new Bot();

bot.command('start', (ctx) => ctx.reply(`Привет, ${ctx.from.first_name}! 👋\nНапиши мне что-нибудь — я повторю.`));

bot.on('text', (ctx) => ctx.reply(ctx.text));
bot.on('photo', (ctx) => ctx.reply('Красивое фото! 📸'));
bot.on('sticker', (ctx) => ctx.replyWithSticker(ctx.msg.sticker.file_id));
bot.on('voice', (ctx) => ctx.reply('Голосовые я пока не слушаю 🙉'));

bot.start();
