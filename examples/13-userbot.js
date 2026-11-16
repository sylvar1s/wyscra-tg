// 13. Юзербот: работа от имени вашего аккаунта Telegram (MTProto).
//
// API_ID и API_HASH получите на https://my.telegram.org → API development tools, и добавьте в .env.
// При первом запуске бот спросит номер телефона, код и пароль 2FA прямо в консоли,
// и сохранит сессию в my-account.session.json (храните этот файл в секрете — это доступ к аккаунту).
// node 13-userbot.js
import { TelegramClient, html } from 'wyscra-tg/mtproto';

const client = new TelegramClient({
  apiId: Number(process.env.API_ID),
  apiHash: process.env.API_HASH,
  session: 'my-account',
});

await client.start();

client.on('message', async (msg) => {
  // .ping в любом чате → замер задержки (только для ваших сообщений)
  if (msg.out && msg.text === '.ping') {
    const t = Date.now();
    await msg.edit('🏓');
    await msg.edit(html`🏓 <b>pong</b> — ${Date.now() - t} мс`);
  }

  // Автоответ в личке
  if (msg.isPrivate && !msg.out && /^привет/i.test(msg.text)) {
    await msg.reply('Привет! Я сейчас не у телефона, отвечу позже 🙂');
  }

  // .save ответом на сообщение с файлом → скачать
  if (msg.out && msg.text === '.save' && msg.replyToId) {
    const [orig] = await client.getMessages(msg.chatId, [msg.replyToId]);
    if (orig?.media) await msg.edit(`💾 Сохранено: ${await orig.download(`./download_${orig.id}`)}`);
  }
});

await client.sendMessage('me', html`✅ Юзербот запущен <code>${new Date().toLocaleString('ru-RU')}</code>`);

console.log('Последние диалоги:');
for await (const dialog of client.iterDialogs({ limit: 5 })) console.log(' •', dialog.title);

await client.idle(); // работать до Ctrl+C
