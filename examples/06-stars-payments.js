// 06. Продажа доступа за звёзды Telegram (Stars).
// Звёзды работают без платёжного провайдера и регистрации — достаточно токена бота.
// node 06-stars-payments.js
import { Bot } from 'wyscra-tg';

const bot = new Bot({ db: 'premium.db' });
const PRICE = 50;

bot.command('start', (ctx) =>
  ctx.user.premium
    ? ctx.reply('💎 У вас Премиум. Секретный раздел: /secret')
    : ctx.reply(`Премиум открывает /secret.\nЦена: ${PRICE} ⭐ навсегда.`, {
        inline: [{ text: `💎 Купить за ${PRICE} ⭐`, onClick: (c) => c.invoice({ title: 'Премиум', description: 'Доступ к /secret навсегда', stars: PRICE, payload: 'premium' }) }],
      }),
);

// Проверка перед оплатой (необязательно): true — разрешить, строка — отказать с этим текстом
bot.onPreCheckout((ctx, query) => (query.invoice_payload === 'premium' && ctx.user?.premium ? 'У вас уже есть Премиум' : true));

// Успешная оплата (срабатывает всегда, даже после перезапуска бота)
bot.onPayment(async (ctx, payment) => {
  if (payment.invoice_payload !== 'premium') return;
  ctx.user.premium = true;
  ctx.user.chargeId = payment.telegram_payment_charge_id;
  await ctx.reply('Спасибо за покупку! 💎 Премиум активирован: /secret');
});

bot.command('secret', (ctx) => (ctx.user.premium ? ctx.reply('🤫 Секретный контент только для Премиум') : ctx.reply('Только для Премиум 💎 → /start')));

bot.command('refund', async (ctx) => {
  if (!ctx.user.chargeId) return ctx.reply('Нечего возвращать');
  await ctx.refund(ctx.user.chargeId);
  ctx.user.premium = false;
  delete ctx.user.chargeId;
  await ctx.reply('⭐ Звёзды возвращены');
});

// Правила Telegram: у бота с оплатой должна быть команда /paysupport
bot.command('paysupport', (ctx) => ctx.reply('По вопросам оплаты пишите: @wyscra'));

bot.start();
