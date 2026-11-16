// 04. Вопросы и анкеты.
// node 04-survey.js
import { Bot } from 'wyscra-tg';

const bot = new Bot({ db: 'survey.db' });

bot.command('start', (ctx) => ctx.reply('/quick — быстрые вопросы (ctx.ask)\n/survey — анкета с проверкой ответов\n/me — мои ответы'));

// Способ 1: ctx.ask — просто спросить и дождаться ответа
bot.command('quick', async (ctx) => {
  const name = await ctx.ask('Как вас зовут?');
  const city = await ctx.ask(`Приятно познакомиться, ${name.text}! Из какого вы города?`);
  await ctx.reply(`Записал: ${name.text} из города ${city.text} 👍`);
});

// Способ 2: сцена — по шагам, с проверкой ввода, продолжается даже после перезапуска бота
bot.scene('survey')
  .step((ctx) => ctx.reply('1/3. Как вас зовут?', { keyboard: [ctx.from.first_name], oneTime: true }))
  .step((ctx) => {
    if (!ctx.text) {
      ctx.scene.stay(); // остаёмся на этом шаге
      return ctx.reply('Напишите имя текстом');
    }
    ctx.scene.data.name = ctx.text; // данные анкеты
    return ctx.reply('2/3. Сколько вам лет?', { removeKeyboard: true });
  })
  .step((ctx) => {
    const age = Number(ctx.text);
    if (!Number.isInteger(age) || age < 5 || age > 120) {
      ctx.scene.stay();
      return ctx.reply('Введите возраст числом, например 25');
    }
    ctx.scene.data.age = age;
    return ctx.reply('3/3. Оцените нас:', { inline: ['1', '2', '3', '4', '5'] });
  })
  .step(async (ctx) => {
    if (!ctx.callbackData) {
      ctx.scene.stay();
      return ctx.reply('Нажмите одну из кнопок выше 👆');
    }
    const { name, age } = ctx.scene.data;
    ctx.user.survey = { name, age, rating: Number(ctx.callbackData) }; // сохраняем в профиль
    await ctx.editText(`Спасибо, ${name}! Ваша оценка: ${'⭐'.repeat(ctx.user.survey.rating)}`);
  });

bot.command('survey', (ctx) => ctx.scene.enter('survey'));
bot.command('cancel', async (ctx) => {
  await ctx.scene.leave();
  await ctx.reply('Анкета отменена', { removeKeyboard: true });
});
bot.command('me', (ctx) => {
  const s = ctx.user.survey;
  return ctx.reply(s ? `Вы: ${s.name}, ${s.age} лет, оценка ${s.rating}/5` : 'Сначала пройдите /survey');
});

bot.start();
