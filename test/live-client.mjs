// Live check of TelegramClient against real servers.
// Without credentials: verifies connect + initConnection (expects API_ID_INVALID).
// With credentials:    TG_API_ID=... TG_API_HASH=... [TG_BOT_TOKEN=...] node test/live-client.mjs
//   logs in (bot token, or phone/code/2FA asked in the console), sends a message to Saved Messages,
//   uploads + downloads a file, lists dialogs and waits 20s for incoming messages.
import { MemorySession, TelegramClient, html, RpcError } from '../dist/mtproto/index.js';

const apiId = Number(process.env.TG_API_ID ?? 1);
const apiHash = process.env.TG_API_HASH ?? '00000000000000000000000000000000';
const client = new TelegramClient({ apiId, apiHash, session: process.env.TG_API_ID ? 'live-test' : new MemorySession(), logLevel: 'warn' });

if (!process.env.TG_API_ID) {
  await client.connect();
  try {
    await client.call('help.getNearestDc');
    console.log('unexpected success');
  } catch (e) {
    console.log('server answered:', e instanceof RpcError ? `${e.code} ${e.errorMessage}` : e.message);
  }
  await client.disconnect();
  process.exit(0);
}

const me = await client.start(process.env.TG_BOT_TOKEN ? { botToken: process.env.TG_BOT_TOKEN } : {});
console.log('me:', me.id, me.username, me.bot ? '(bot)' : '');
const config = await client.call('help.getConfig');
console.log('config: this_dc', config.this_dc, 'dc_options', config.dc_options.length);

client.on('message', (m) => console.log('incoming:', m.chatId, JSON.stringify(m.text)));

if (!me.bot) {
  const sent = await client.sendMessage('me', html`wyscra-tg live test <b>${new Date().toISOString()}</b>`);
  console.log('sent message id', sent.id, 'text', JSON.stringify(sent.text));
  const file = await client.sendFile('me', Buffer.from('hello from wyscra-tg\n'.repeat(1000)), { fileName: 'test.txt', caption: 'file test' });
  const back = await file.download();
  console.log('file roundtrip', back.length, 'bytes');
  const dialogs = await client.getDialogs(5);
  console.log('dialogs:', dialogs.map((d) => d.title).join(' | '));
  for await (const m of client.iterMessages('me', { limit: 3 })) console.log('history:', m.id, JSON.stringify(m.text.slice(0, 40)));
}
console.log('waiting 20s for incoming messages...');
await new Promise((r) => setTimeout(r, 20_000));
await client.disconnect();
