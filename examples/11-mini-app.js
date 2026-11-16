// 11. Мини-приложение (Web App) с проверкой пользователя на сервере.
//
// Telegram открывает мини-приложения только по HTTPS. Для разработки подойдёт туннель:
//   npx cloudflared tunnel --url http://localhost:8080      (или ngrok http 8080)
// и полученный https-адрес укажите в .env:  WEBAPP_URL=https://....trycloudflare.com
// node 11-mini-app.js
import { createServer } from 'node:http';
import { Bot, validateWebAppData } from 'wyscra-tg';

const bot = new Bot({ db: 'miniapp.db' });
const WEBAPP_URL = process.env.WEBAPP_URL;
const PORT = Number(process.env.PORT ?? 8080);

bot.command('start', (ctx) =>
  WEBAPP_URL
    ? ctx.reply('Откройте мини-приложение 👇', { inline: [{ text: '🚀 Открыть', webApp: WEBAPP_URL }] })
    : ctx.reply('Укажите WEBAPP_URL в .env (https-адрес вашего сервера)'),
);

// Страница мини-приложения
const page = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  body { font-family: system-ui, sans-serif; text-align: center; padding: 40px 16px;
         background: var(--tg-theme-bg-color, #fff); color: var(--tg-theme-text-color, #000); }
  button { font-size: 20px; padding: 14px 32px; border: 0; border-radius: 12px;
           background: var(--tg-theme-button-color, #2481cc); color: var(--tg-theme-button-text-color, #fff); }
</style></head>
<body>
  <h2 id="hello">Загрузка…</h2>
  <p>Нажатий: <b id="clicks">0</b></p>
  <button id="btn">Нажми меня</button>
  <script>
    const tg = Telegram.WebApp; tg.ready(); tg.expand();
    const call = (path) => fetch(path, { method: 'POST', body: tg.initData }).then((r) => r.json());
    const show = (d) => { hello.textContent = 'Привет, ' + d.name + '!'; clicks.textContent = d.clicks; };
    call('/api/me').then(show).catch(() => (hello.textContent = 'Откройте через Telegram'));
    btn.onclick = () => call('/api/click').then(show);
  </script>
</body></html>`;

// Сервер: отдаёт страницу и проверяет, что запросы пришли от настоящего пользователя Telegram
createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(page);
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    const { user } = validateWebAppData(body, bot.api.token); // поддельные данные → ошибка
    const record = await bot.db.users.update(user.id, (cur) => ({
      first_name: user.first_name,
      clicks: (cur?.clicks ?? 0) + (req.url === '/api/click' ? 1 : 0),
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: user.first_name, clicks: record.clicks }));
  } catch {
    res.writeHead(401).end();
  }
}).listen(PORT, () => console.log(`Мини-приложение: http://localhost:${PORT}`));

bot.start();
