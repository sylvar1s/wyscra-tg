// Простой магазин: кнопки, база данных, анкета, рассылка.
// Запуск: создайте файл .env со строкой BOT_TOKEN=ваш_токен и выполните: node shop.js
import { Bot } from 'wyscra-tg';

const bot = new Bot({ db: 'shop.db' }); // токен из .env, данные сохраняются в shop.db

const products = { pizza: { name: '🍕 Пицца', price: 500 }, sushi: { name: '🍣 Суши', price: 900 } };

// /start — меню-клавиатура под полем ввода
bot.command('start', 'Главное меню', (ctx) =>
  ctx.reply(`Привет, ${ctx.from.first_name}! Что хотите?`, {
    keyboard: [['🛒 Каталог', '💰 Баланс'], ['📝 Отзыв']],
  }),
);

// Нажали «Каталог» — показываем товары кнопками под сообщением
const catalog = (ctx) =>
  ctx.reply('Выберите товар:', {
    inline: Object.entries(products).map(([id, p]) => ({
      text: `${p.name} — ${p.price}₽`,
      onClick: (ctx) => buy(ctx, id),
    })),
    columns: 1,
  });
bot.hears('🛒 Каталог', catalog);
bot.action('catalog', catalog); // постоянная кнопка из рассылки (работает и после перезапуска)

async function buy(ctx, id) {
  const p = products[id];
  if ((ctx.user.balance ?? 1000) < p.price) return ctx.alert('Недостаточно денег 😢');
  ctx.user.balance = (ctx.user.balance ?? 1000) - p.price; // сохранится в базе само
  await ctx.db.collection('orders').set(Date.now(), { userId: ctx.from.id, product: id, price: p.price });
  await ctx.editText(`✅ Куплено: ${p.name}\nОстаток: ${ctx.user.balance}₽`);
}

bot.hears('💰 Баланс', async (ctx) => {
  const orders = await ctx.db.collection('orders').count({ userId: ctx.from.id });
  await ctx.reply(`Баланс: ${ctx.user.balance ?? 1000}₽\nЗаказов: ${orders}`, {
    inline: [{ text: '➕ Пополнить на 500₽', onClick: (c) => ((c.user.balance = (c.user.balance ?? 1000) + 500), c.editText(`Баланс: ${c.user.balance}₽`)) }],
  });
});

// Анкета из нескольких шагов (переживает перезапуск бота)
bot.scene('review')
  .step((ctx) => ctx.reply('Оцените нас от 1 до 5', { keyboard: ['1', '2', '3', '4', '5'], oneTime: true }))
  .step((ctx) => {
    if (!/^[1-5]$/.test(ctx.text ?? '')) return ctx.scene.stay(), ctx.reply('Нажмите цифру от 1 до 5');
    ctx.scene.data.rating = Number(ctx.text);
    return ctx.reply('Напишите пару слов:', { removeKeyboard: true });
  })
  .step(async (ctx) => {
    await ctx.db.collection('reviews').set(ctx.from.id, { rating: ctx.scene.data.rating, text: ctx.text });
    await ctx.reply('Спасибо за отзыв! 🙏', { keyboard: [['🛒 Каталог', '💰 Баланс'], ['📝 Отзыв']] });
  });
bot.hears('📝 Отзыв', (ctx) => ctx.scene.enter('review'));
bot.command('cancel', 'Отменить', (ctx) => (ctx.scene.leave(), ctx.reply('Отменено')));

// Рассылка (только для админа)
bot.command('news', async (ctx) => {
  if (ctx.from.id !== Number(process.env.ADMIN_ID)) return;
  const r = await bot.broadcast(ctx.args || 'Новинки в каталоге!', { inline: [{ text: 'Открыть каталог', data: 'catalog' }] });
  await ctx.reply(`Отправлено: ${r.sent}, заблокировали бота: ${r.blocked}`);
});

bot.start();
