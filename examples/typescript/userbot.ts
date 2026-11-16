// Userbot via MTProto. Get API_ID / API_HASH at https://my.telegram.org
// First run asks for phone, code and 2FA password in the console; the session is saved to my-account.session.json
import { TelegramClient, html } from 'wyscra-tg/mtproto';

const client = new TelegramClient({
  apiId: Number(process.env.API_ID),
  apiHash: process.env.API_HASH!,
  session: 'my-account',
});

await client.start();

client.on('message', async (msg) => {
  if (msg.out && msg.text === '.ping') {
    const t = Date.now();
    await msg.edit(html`🏓 <b>pong</b> ${Date.now() - t} ms`);
  }
  if (msg.isPrivate && !msg.out && msg.text.toLowerCase() === 'привет') {
    await msg.reply('Привет! Это автоответ от wyscra-tg');
  }
  if (msg.out && msg.command === 'save' && msg.replyToId) {
    const [orig] = await client.getMessages(msg.chatId, [msg.replyToId]);
    if (orig?.media) console.log('Saved to', await orig.download(`./download_${orig.id}`));
  }
});

client.on('deleteMessages', ({ chatId, ids }) => console.log('Deleted', ids, 'in', chatId ?? 'private/group'));

await client.sendMessage('me', html`Userbot started at <code>${new Date().toLocaleString()}</code>`);
await client.sendFile('me', Buffer.from('hello'), { fileName: 'hello.txt', caption: 'File upload works' });

for await (const dialog of client.iterDialogs({ limit: 10 })) console.log(dialog.id, dialog.title);
for await (const m of client.iterMessages('@telegram', { limit: 3 })) console.log(m.date.toISOString(), m.text.slice(0, 60));

// Any raw API method with full typing:
const full = await client.api.users.getFullUser({ id: { _: 'inputUserSelf' } });
console.log('About:', full.full_user.about);

await client.idle(); // keep running until Ctrl+C
