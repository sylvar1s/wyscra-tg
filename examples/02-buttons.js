// 02. Все виды кнопок.
// node 02-buttons.js
import { Bot } from 'wyscra-tg';

const bot = new Bot();

// Клавиатура вместо обычной: массив строк — один ряд, массив массивов — несколько рядов
bot.command('start', (ctx) =>
  ctx.reply('Выберите, что показать:', {
    keyboard: [
      ['🔘 Кнопки под сообщением', '🔢 Счётчик'],
      ['⌨️ Цифры', '📱 Мой номер'],
    ],
  }),
);

// 1. Кнопки под сообщением: что делать при нажатии — пишется прямо в кнопке
bot.hears('🔘 Кнопки под сообщением', (ctx) =>
  ctx.reply('Нравится библиотека?', {
    inline: [
      [
        { text: '👍 Да', onClick: (ctx) => ctx.editText('Спасибо! ❤️') },
        { text: '👎 Нет', onClick: (ctx) => ctx.editText('Напишите, что улучшить: @wyscra') },
      ],
      [{ text: '🔔 Всплывающее окно', onClick: (ctx) => ctx.alert('Это окно с текстом!') }],
      [
        { text: '🌐 Ссылка', url: 'https://t.me/wyscra' },
        { text: '📋 Скопировать промокод', copy: 'WYSCRA2026' },
      ],
    ],
  }),
);

// 2. Кнопки, которые меняют сообщение
bot.hears('🔢 Счётчик', (ctx) => {
  let count = 0;
  const buttons = () => ({
    inline: [
      [
        { text: '➖', onClick: (c) => (count--, c.editText(`Счётчик: ${count}`, buttons())) },
        { text: '➕', onClick: (c) => (count++, c.editText(`Счётчик: ${count}`, buttons())) },
      ],
      [{ text: '✖️ Закрыть', onClick: (c) => c.deleteMessage() }],
    ],
  });
  return ctx.reply('Счётчик: 0', buttons());
});

// 3. Постоянные кнопки: работают и после перезапуска бота (ловятся через bot.action)
bot.command('vote', (ctx) => ctx.reply('Ваш любимый язык?', { inline: ['JavaScript', 'TypeScript', 'Python'] }));
bot.action(['JavaScript', 'TypeScript', 'Python'], (ctx) => ctx.editText(`Вы выбрали: ${ctx.callbackData} ✅`));

// 4. Много кнопок, разложенных по рядам автоматически
bot.hears('⌨️ Цифры', (ctx) => ctx.reply('Нажмите цифру:', { keyboard: ['1', '2', '3', '4', '5', '6', '7', '8', '9'], columns: 3 }));
bot.hears(/^[1-9]$/, (ctx) => ctx.reply(`Вы нажали ${ctx.text}`, { removeKeyboard: true }));

// 5. Кнопка запроса номера телефона
bot.hears('📱 Мой номер', (ctx) =>
  ctx.reply('Нажмите кнопку ниже 👇', { keyboard: [{ text: '📱 Поделиться номером', contact: true }], oneTime: true }),
);
bot.on('contact', (ctx) => ctx.reply(`Ваш номер: ${ctx.msg.contact.phone_number}`, { removeKeyboard: true }));

bot.start();
