<div align="center">

<img src="https://raw.githubusercontent.com/sylvar1s/wyscra-tg/main/assets/banner.svg" alt="wyscra-tg" width="100%">

<br>

[![npm](https://img.shields.io/npm/v/wyscra-tg?color=2aabee&label=npm)](https://www.npmjs.com/package/wyscra-tg)
[![CI](https://github.com/sylvar1s/wyscra-tg/actions/workflows/ci.yml/badge.svg)](https://github.com/sylvar1s/wyscra-tg/actions/workflows/ci.yml)
[![Bot API](https://img.shields.io/badge/Bot%20API-10.4-2aabee)](https://core.telegram.org/bots/api)
[![node](https://img.shields.io/badge/node-%E2%89%A522.13-43853d)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/зависимости-0-brightgreen)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**[Быстрый старт](#-быстрый-старт)** · **[Примеры](#-примеры)** · **[Документация](#-документация)** · **[Сравнение](#-сравнение)** · **[Telegram @wyscra](https://t.me/wyscra)**

</div>

<br>

```js
import { Bot } from 'wyscra-tg';

const bot = new Bot({ db: 'bot.db' });

bot.command('start', (ctx) =>
  ctx.reply('Удалить сообщение?', {
    inline: [
      { text: '✅ Да', onClick: (ctx) => ctx.editText('Удалено') },
      { text: '❌ Нет', onClick: (ctx) => ctx.editText('Отменено') },
    ],
  }),
);

bot.start();
```

## ✨ Почему wyscra-tg

<table>
<tr>
<td width="50%" valign="top">

### 🧩 Просто
Кнопки — обычные массивы, а что делает кнопка, пишется прямо в ней. Токен сам берётся из `.env`, сессии и профили пользователей работают без настройки.

</td>
<td width="50%" valign="top">

### 💾 База данных одной строкой
`db: 'bot.db'` — и всё сохраняется. SQLite встроен в Node.js. PostgreSQL, MySQL, MongoDB, Redis подключаются той же строкой, код не меняется.

</td>
</tr>
<tr>
<td valign="top">

### 🔋 Всё нужное уже внутри
Анкеты, рассылка, админ-панель, оплата звёздами, модерация групп, переводы, расписание, антиспам, мини-приложения — без плагинов.

</td>
<td valign="top">

### ⚡ Быстро и полно
В 1,5–2,3 раза быстрее grammY и Telegraf. Все 193 метода Bot API 10.4 и MTProto для юзерботов. Ноль зависимостей.

</td>
</tr>
</table>

## 🚀 Быстрый старт

Нужен [Node.js](https://nodejs.org) 22.13 или новее.

**Вариант 1 — готовый проект одной командой** (меню, кнопки, база, анкета, админ-панель):

```bash
npx wyscra-tg init my-bot
```
```bash
cd my-bot
```
```bash
npm start
```

**Вариант 2 — вручную:**

```bash
npm install wyscra-tg
```

Создайте файл `.env` с токеном от [@BotFather](https://t.me/BotFather):

```env
BOT_TOKEN=123456:ABC-ваш-токен
```

И файл `bot.js`:

```js
import { Bot } from 'wyscra-tg';

const bot = new Bot({ db: 'bot.db' });

bot.command('start', (ctx) => ctx.reply(`Привет, ${ctx.from.first_name}!`));
bot.on('text', (ctx) => ctx.reply(`Вы написали: ${ctx.text}`));

bot.start();
```

```bash
node bot.js
```

```
wyscra-tg v0.1.0 · Telegram @wyscra
✔ Бот @your_bot запущен (long polling)
✔ База данных: sqlite
```

## 📚 Примеры

Готовые боты в папке [examples](examples). Каждый проверяется автотестами по своему сценарию.

| | Пример | Что внутри |
|:-:|---|---|
| 👋 | [Эхо-бот](examples/01-echo.js) | Самый простой бот |
| 🔘 | [Кнопки](examples/02-buttons.js) | Все виды кнопок, счётчик, запрос номера |
| 📒 | [Записная книжка](examples/03-database.js) | База данных, список со страницами |
| 📝 | [Анкета](examples/04-survey.js) | Вопросы, проверка ответов, сцены |
| 🛒 | [Магазин](examples/05-shop.js) | Каталог, баланс, заказы, отзывы, рассылка |
| ⭐ | [Оплата звёздами](examples/06-stars-payments.js) | Продажа доступа за Telegram Stars |
| 🛡 | [Модератор группы](examples/07-group-moderator.js) | Бан, мут, предупреждения, антиспам, подписка на канал |
| 🌍 | [Несколько языков](examples/08-multilang.js) | Переводы, смена языка, склонения |
| ⏰ | [Напоминалка](examples/09-reminders.js) | Задачи по расписанию |
| 🔍 | [Inline-режим](examples/10-inline-mode.js) | `@бот запрос` в любом чате |
| 📱 | [Мини-приложение](examples/11-mini-app.js) | Web App со своим сервером |
| ⚙️ | [Админ-панель](examples/12-admin-panel.js) | Статистика, рассылка, выгрузка в CSV |
| 👤 | [Юзербот](examples/13-userbot.js) | Работа от имени аккаунта (MTProto) |
| 🔷 | [TypeScript](examples/typescript) | Те же возможности с подсказками типов |

## 📖 Документация

<table>
<tr><td valign="top">

**Основы**
- [Команды и текст](#команды-и-текст)
- [Кнопки под сообщением](#кнопки-под-сообщением)
- [Клавиатура](#клавиатура)
- [Опции сообщений](#опции-сообщений)
- [Фото и файлы](#фото-и-файлы)
- [События](#события)

</td><td valign="top">

**Диалоги и данные**
- [Вопрос — ответ](#вопрос--ответ)
- [Анкеты (сцены)](#анкеты-сцены)
- [Данные пользователя](#данные-пользователя)
- [Своя таблица](#своя-таблица)
- [Подключить базу](#подключить-базу)

</td><td valign="top">

**Возможности**
- [Рассылка](#рассылка)
- [Админ-панель](#админ-панель)
- [Модерация групп](#модерация-групп)
- [Оплата звёздами](#оплата-звёздами)
- [Inline-режим](#inline-режим)
- [Списки со страницами](#списки-со-страницами)

</td><td valign="top">

**Ещё**
- [Несколько языков](#несколько-языков)
- [Расписание](#расписание)
- [Антиспам](#антиспам)
- [Мини-приложения](#мини-приложения)
- [Запуск на сервере](#запуск-на-сервере)
- [Шпаргалка](#-шпаргалка)

</td></tr>
</table>

### Команды и текст

```js
bot.command('help', (ctx) => ctx.reply('Чем помочь?'));
bot.command('start', 'Начать работу', (ctx) => ctx.reply('Привет!')); // с описанием → появится в меню Telegram

bot.hears('Привет', (ctx) => ctx.reply('И тебе привет!'));           // точный текст
bot.hears(/цена (\w+)/i, (ctx) => ctx.reply(`Ищу ${ctx.match[1]}`));  // регулярное выражение
bot.on('text', (ctx) => ctx.reply(ctx.text));                          // любой текст
```

`/start ref123` → в `ctx.args` будет `'ref123'`, это удобно для реферальных ссылок.

> [!TIP]
> Обработчики проверяются сверху вниз, срабатывает первый подходящий. Поэтому общие (`bot.on('text')`) ставьте в конец.

### Кнопки под сообщением

```js
ctx.reply('Вы уверены?', {
  inline: [
    { text: '✅ Да', onClick: (ctx) => ctx.editText('Удалено') },
    { text: '❌ Нет', onClick: (ctx) => ctx.editText('Отменено') },
  ],
});
```

Один массив — один ряд. Несколько рядов — массив массивов. Разложить автоматически: `{ inline: buttons, columns: 2 }`.

```js
inline: [
  [{ text: '1', onClick: one }, { text: '2', onClick: two }],  // ряд 1
  [{ text: '🌐 Сайт', url: 'https://example.com' }],          // ряд 2
]
```

| Кнопка | Что делает |
|---|---|
| `{ text, onClick: ctx => … }` | выполняет функцию |
| `{ text, data: 'buy:42' }` или просто `'Текст'` | ловится `bot.action('buy:42', …)` или `bot.action(/buy:(\d+)/, …)` |
| `{ text, url }` | открывает ссылку |
| `{ text, webApp: url }` | открывает мини-приложение |
| `{ text, copy: 'PROMO' }` | копирует текст |
| `{ text, share: 'текст' }` | предлагает выбрать чат и поделиться |

В обработчике нажатия есть всё нужное:
- `ctx.editText('…', { inline })` — изменить сообщение;
- `ctx.editButtons([...])` — изменить только кнопки;
- `ctx.alert('…')` — окно с текстом, `ctx.answer('…')` — короткая подсказка;
- `ctx.deleteMessage()` — удалить сообщение.

Если ничего не ответить, «часики» на кнопке погаснут сами.

> [!NOTE]
> Кнопки с `onClick` работают, пока бот запущен. После перезапуска старая кнопка ответит «Кнопка устарела». Для постоянных кнопок используйте `data` и `bot.action`.

### Клавиатура

```js
ctx.reply('Главное меню', {
  keyboard: [
    ['🛒 Каталог', '💰 Баланс'],
    ['📞 Помощь'],
  ],
});

bot.hears('🛒 Каталог', (ctx) => ctx.reply('Каталог…'));  // нажатие отправляет текст кнопки
```

```js
{ keyboard: [{ text: '📱 Отправить номер', contact: true }] }  // → bot.on('contact', …)
{ keyboard: [{ text: '📍 Где я', location: true }] }            // → bot.on('location', …)
{ keyboard: ['Да', 'Нет'], oneTime: true }                      // спрятать после нажатия
{ keyboard: [...], placeholder: 'Выберите пункт' }              // подсказка в поле ввода
{ removeKeyboard: true }                                        // убрать клавиатуру
```

### Опции сообщений

```js
ctx.reply('<b>Жирный</b>', { html: true });
ctx.reply('Тихо', { silent: true });         // без звука
ctx.reply('Ответ', { replyTo: messageId });  // ответом на сообщение
ctx.reply('Ссылка', { noPreview: true });    // без превью
ctx.reply('Секрет', { protect: true });      // запретить пересылку
```

Безопасная вставка пользовательского текста (экранирование автоматическое):

```js
import { html, fmt } from 'wyscra-tg';
ctx.reply(html`Привет, <b>${ctx.from.first_name}</b>! Код: ${fmt.code('A1B2')}`);
```

### Фото и файлы

```js
import { file } from 'wyscra-tg';

ctx.replyWithPhoto('https://example.com/cat.jpg', { caption: 'Котик' });
ctx.replyWithPhoto(file('./cat.jpg'));            // с диска
ctx.replyWithDocument(file(buffer, 'отчёт.pdf')); // из памяти
ctx.replyWithVideo(file('./video.mp4'), { inline: [{ text: 'Ещё', onClick: more }] });

bot.on('photo', async (ctx) => {
  await ctx.download(`./photos/${Date.now()}.jpg`); // скачать присланное
});
```

Ещё есть `replyWithAudio`, `Voice`, `Sticker`, `Animation`, `MediaGroup`, `Location`, `Contact`, `Poll`, `Dice`. Если отправить тот же файл с диска ещё раз, он не загружается заново: используется `file_id`.

### События

```js
bot.on('photo', …)   bot.on('video', …)   bot.on('voice', …)   bot.on('document', …)
bot.on('sticker', …) bot.on('contact', …) bot.on('location', …) bot.on(['photo', 'video'], …)
bot.on('new_chat_members', (ctx) => ctx.reply('Добро пожаловать!'))
bot.on('chat_join_request', (ctx) => ctx.approveJoin())
bot.reaction('👍', …)
bot.chatType('private', …)
```

### Вопрос — ответ

```js
bot.command('anketa', async (ctx) => {
  const name = await ctx.ask('Как вас зовут?');
  const city = await ctx.ask(`${name.text}, откуда вы?`);
  await ctx.reply(`Записал: ${name.text}, ${city.text}`);
});
```

### Анкеты (сцены)

Шаги анкеты хранятся в базе: если бот перезапустится, анкета продолжится с того же места.

```js
bot.scene('signup')
  .step((ctx) => ctx.reply('Как вас зовут?'))
  .step((ctx) => {
    ctx.scene.data.name = ctx.text;
    return ctx.reply('Сколько вам лет?');
  })
  .step((ctx) => {
    if (isNaN(ctx.text)) {
      ctx.scene.stay();                   // повторить шаг
      return ctx.reply('Введите число');
    }
    ctx.user.name = ctx.scene.data.name;  // сохранить в профиль
    ctx.user.age = Number(ctx.text);
    return ctx.reply('Готово!');
  });

bot.command('signup', (ctx) => ctx.scene.enter('signup'));
bot.command('cancel', (ctx) => ctx.scene.leave());
```

Команды вроде `/cancel` работают и внутри анкеты. Ещё есть `ctx.scene.goto(n)`, `ctx.scene.back()` и автовыход по таймауту: `bot.scene('id', { ttl: 600_000 })`.

### Данные пользователя

Каждый, кто пишет боту, сохраняется в базу сам. Свои поля просто присваивайте:

```js
bot.command('bonus', (ctx) => {
  ctx.user.balance = (ctx.user.balance ?? 0) + 100;   // сохранится автоматически
  return ctx.reply(`Баланс: ${ctx.user.balance}`);
});
```

В `ctx.user` уже есть `id`, `first_name`, `username`, `language_code`, `firstSeen`, `lastSeen`. Для временных данных разговора есть `ctx.session`.

### Своя таблица

```js
const orders = bot.db.collection('orders');   // в обработчике: ctx.db.collection('orders')

await orders.set(1, { product: 'Пицца', price: 500, paid: false });
await orders.get(1);                           // { id: 1, product: 'Пицца', … }
await orders.update(1, { paid: true });
await orders.increment(1, 'price', 50);
await orders.find({ paid: false });            // поиск по полям (выполняется в самой БД)
await orders.find((o) => o.price > 300);       // поиск по условию
await orders.findOne({ product: 'Пицца' });
await orders.count({ paid: true });
await orders.delete(1);
for await (const o of orders) console.log(o);
```

Пользователи лежат в `bot.db.users`, группы с ботом — в `bot.db.chats`.

### Подключить базу

| База | Строка | Установить |
|---|---|---|
| SQLite | `'bot.db'` | ничего, встроен в Node.js ✅ |
| JSON-файл | `'data.json'` | ничего |
| PostgreSQL | `'postgres://user:pass@host:5432/db'` | `npm i pg` |
| MySQL / MariaDB | `'mysql://user:pass@host:3306/db'` | `npm i mysql2` |
| MongoDB | `'mongodb://host:27017/db'` | `npm i mongodb` |
| Redis | `'redis://host:6379'` | `npm i redis` |
| В памяти | не указывать | — |

```js
new Bot({ db: 'bot.db' });
```

Код работы с данными одинаковый для всех баз. Для своих SQL-запросов есть `await bot.db.raw()`, он возвращает исходное подключение.

### Рассылка

```js
const r = await bot.broadcast('🔥 Новая акция!', { inline: [{ text: 'Подробнее', url: 'https://…' }] });
// { total, sent, blocked, failed }

await bot.broadcast((user) => `Привет, ${user.first_name}!`);
await bot.broadcast('Только для русских', { filter: { language_code: 'ru' } });
```

Скорость сама подстраивается под лимиты Telegram, заблокировавшие бота пропускаются. Отправить одному: `bot.send(userId, 'текст', { inline })`.

### Админ-панель

```js
bot.admin({ ids: [123456789] });   // или ADMIN_ID=123456789 в .env и bot.admin()
```

Команда `/admin`: 📊 статистика · 📢 рассылка с подтверждением и прогрессом · 👥 пользователи · 📤 выгрузка в CSV. В коде статистика доступна через `await bot.stats()`.

### Модерация групп

```js
bot.command('ban', (ctx) => ctx.ban());                   // ответом на сообщение нарушителя
bot.command('mute', (ctx) => ctx.mute(undefined, '1h'));  // '30m', '2d', '1w', '10мин'
bot.command('kick', (ctx) => ctx.kick());
ctx.ban(userId, { for: '7d', deleteMessages: true });

if (await ctx.isAdmin()) { … }
bot.onlyAdmins((ctx, next) => …);
if (!(await ctx.isSubscribed('@my_channel'))) return ctx.reply('Подпишитесь на @my_channel');
```

### Оплата звёздами

```js
bot.command('premium', (ctx) =>
  ctx.invoice({
    title: 'Премиум на месяц',
    stars: 100,
    onPaid: (ctx) => {
      ctx.user.premium = true;
      return ctx.reply('Спасибо! ⭐');
    },
  }),
);

bot.onPreCheckout((ctx, q) => (inStock(q.invoice_payload) ? true : 'Товар закончился')); // необязательно
bot.onPayment((ctx, payment) => …);  // все оплаты, в том числе после перезапуска
ctx.refund();                        // вернуть звёзды
```

### Inline-режим

```js
bot.on('inline_query', (ctx) =>
  ctx.answerInline([
    { title: 'Привет', text: 'Всем привет!' },
    { title: 'Котик', photo: 'https://example.com/cat.jpg' },
  ], { cache: '1m' }),
);
```

### Списки со страницами

```js
ctx.paginate(orders, { format: (o, i) => `${i + 1}. ${o.title}` });                  // текстом, ◀️ 1/5 ▶️
ctx.paginate(products, { label: (p) => p.name, onSelect: (ctx, p) => ctx.reply(p.price) }); // кнопками
```

### Несколько языков

```json
// locales/ru.json
{ "hello": "Привет, {name}!", "items": { "one": "{count} товар", "few": "{count} товара", "many": "{count} товаров" } }
```

```js
const bot = new Bot({ i18n: { locales: './locales', defaultLocale: 'ru' } });

ctx.t('hello', { name: ctx.from.first_name });
ctx.t('items', { count: 5 });  // «5 товаров»
ctx.setLang('en');             // сохраняется в базе
```

### Расписание

```js
bot.every('1h', () => updatePrices());
bot.daily('09:00', () => bot.broadcast('Доброе утро! ☀️'));
bot.cron('0 18 * * 5', () => bot.broadcast('Хороших выходных!'));  // пятница 18:00
bot.once('10m', () => …);
```

### Антиспам

```js
new Bot({ antiFlood: { limit: 5, per: '10s', message: 'Не так быстро! ⏳' } });
```

### Мини-приложения

```js
import { validateWebAppData, checkLoginWidget } from 'wyscra-tg';

const { user } = validateWebAppData(initData, process.env.BOT_TOKEN);  // данные из Telegram.WebApp.initData
const site = checkLoginWidget(req.query, process.env.BOT_TOKEN);       // вход на сайт через Telegram
```

Поддельные или устаревшие данные вызывают ошибку. Полный пример с сервером — [11-mini-app.js](examples/11-mini-app.js).

### Запуск на сервере

```js
bot.start();                                                             // long polling: работает везде
await bot.startWebhook({ url: 'https://your-domain.com/bot', port: 3000 }); // вебхук со своим сервером
app.post('/bot', bot.webhookCallback());                                 // Express / Fastify
export const POST = bot.fetchHandler();                                  // Vercel, Next.js, Cloudflare, Deno, Bun
```

Ошибки обработчиков ловятся через `bot.catch((err, ctx) => …)`. Лимиты Telegram и повторы при ошибке 429 работают автоматически.

## 📋 Шпаргалка

| Что | Как |
|---|---|
| Текст, команда, аргументы | `ctx.text`, `ctx.command`, `ctx.args` |
| Кто и где | `ctx.from`, `ctx.chatId`, `ctx.isPrivate`, `ctx.isGroup` |
| Нажатая кнопка | `ctx.callbackData` |
| Профиль, сессия, база | `ctx.user`, `ctx.session`, `ctx.db` |
| Ответить | `ctx.reply`, `ctx.replyWithPhoto`, `ctx.quote`, `ctx.react('🔥')` |
| Изменить, удалить | `ctx.editText`, `ctx.editButtons`, `ctx.deleteMessage` |
| Ответ на кнопку | `ctx.answer('…')`, `ctx.alert('…')` |
| Спросить | `await ctx.ask('…')`, `ctx.scene.enter('id')` |
| Модерация | `ctx.ban()`, `ctx.mute(id, '1h')`, `ctx.kick()`, `await ctx.isAdmin()`, `await ctx.isSubscribed('@канал')` |
| Оплата | `ctx.invoice({ title, stars, onPaid })`, `ctx.refund()` |
| Перевод | `ctx.t('ключ', { … })`, `ctx.setLang('en')` |
| Любой метод Telegram | `ctx.api.названиеМетода({ … })` — все 193 метода с подсказками |

## ⚡ Скорость

200 000 апдейтов без сети, одинаковый сценарий (сессия, команда, регэксп, фото, кнопки, текст), медиана трёх запусков, Node 24. Повторить: `npm run bench`.

| | wyscra-tg | grammY 1.46 | Telegraf 4.16 |
|---|---:|---:|---:|
| Последовательно | **361 000/с** | 245 000/с | 173 000/с |
| Параллельно | **140 000/с** | 61 000/с | 44 000/с |

При этом wyscra-tg ведёт учёт пользователей в базе, а при параллельной обработке сохраняет порядок сообщений внутри каждого чата.

## 🆚 Сравнение

| | wyscra-tg | grammY | Telegraf |
|---|:-:|:-:|:-:|
| Кнопки с обработчиком внутри (`onClick`) | ✅ | плагин | — |
| База данных и профили пользователей | ✅ встроено | адаптеры сессий | — |
| Рассылка с учётом заблокировавших | ✅ | — | — |
| Админ-панель и статистика | ✅ | — | — |
| Анкеты / диалоги | ✅ | плагин | ✅ |
| Переводы (i18n) | ✅ | плагин | сторонний пакет |
| Соблюдение лимитов Telegram | ✅ | плагин | — |
| Оплата звёздами в одну строку | ✅ | — | — |
| Расписание задач | ✅ | — | — |
| Юзерботы (MTProto) | ✅ | — | — |
| Зависимости | 0 | несколько | несколько |

<details>
<summary><b>🔧 Для продвинутых</b></summary>

<br>

- **Фильтры с типами**: `bot.on('message:photo')`, `bot.on('callback_query:data')`, `bot.on('message:entities:url')`. Внутри фильтра TypeScript знает, какие поля есть.
- **Middleware**: `bot.use(async (ctx, next) => { …; await next(); })`, `bot.filter(…)`, `bot.branch(…)`, `new Composer()` для разбиения на модули.
- **Билдеры клавиатур**: `new InlineKeyboard().text('A', 'a').row().url(…)`, `new Keyboard()…`.
- **Прямые вызовы API**: `bot.api.sendMessage({ chat_id, text })`, обёртки через `bot.api.use(…)`.
- **Своя база**: передайте в `db` объект с методами `get/set/delete/list/count/close`.
- **Типизация своих полей**:
  ```ts
  declare module 'wyscra-tg' {
    interface UserData { balance: number }
    interface SessionData { step: number }
  }
  ```
- **Лимиты**: `new Bot({ throttle: { global: 30, perChat: 1, perGroupPerMinute: 20 } })` или `throttle: false`.
- **Опции**: `apiRoot` / `BOT_API_ROOT` (свой Bot API сервер, файлы до 2 ГБ), `testEnv`, `parseMode`, `session: false`, `trackUsers: false`, `autoAnswerCallbacks: false`, `cacheFiles: false`.
- **Обновить API Telegram**: `npm run update-api` перегенерирует типы и методы из официальной спецификации.

</details>

<details>
<summary><b>👤 Юзерботы (MTProto)</b></summary>

<br>

Работа от имени обычного аккаунта. `api_id` и `api_hash` берутся на [my.telegram.org](https://my.telegram.org).

```js
import { TelegramClient } from 'wyscra-tg/mtproto';

const client = new TelegramClient({ apiId: 123456, apiHash: '…' });
await client.start(); // номер, код и пароль спросит в консоли; сессия сохранится в файл

client.on('message', async (msg) => {
  if (msg.text === 'ping') await msg.reply('pong');
});

await client.sendMessage('@username', 'Привет!');
await client.sendFile('me', './photo.jpg', { caption: 'Фото' });
for await (const m of client.iterMessages('@channel', { limit: 10 })) console.log(m.text);
await client.idle();
```

- Вход ботом: `client.start({ botToken })`. Сессия в строке: `client.exportSession()` → `new StringSession(str)`.
- Методы: `sendMessage`, `editMessage`, `deleteMessages`, `forwardMessages`, `sendFile`, `downloadMedia`, `getMessages`, `iterMessages`, `iterDialogs`, `iterParticipants`, `sendReaction`, `markAsRead`, `resolvePeer`, `getEntity`.
- Все 877 методов Telegram (слой 233) с подсказками: `client.api.messages.getDialogs({ … })`.
- Само обрабатывает переходы между дата-центрами, FLOOD_WAIT, переподключение, пропущенные обновления. Поддерживает прокси SOCKS5 и MTProxy.

</details>

<details>
<summary><b>⚠️ Ограничения</b></summary>

<br>

- Драйверы PostgreSQL, MySQL, MongoDB и Redis написаны по документации драйверов. Память, JSON и SQLite покрыты тестами.
- Вход через MTProto собран по спецификации. Проверить на своём аккаунте: `TG_API_ID=… TG_API_HASH=… node test/live-client.mjs`.
- MTProxy с секретами `ee…` (fake-TLS) пока не поддерживается.
- Кнопки с `onClick` и `ctx.ask` живут, пока бот запущен. Для постоянных используйте `data` + `bot.action` и сцены.

</details>

## 🤝 Участие

Ошибки и предложения — в [Issues](https://github.com/sylvar1s/wyscra-tg/issues) или в Telegram [@wyscra](https://t.me/wyscra). История изменений — в [CHANGELOG.md](CHANGELOG.md).

```bash
npm test        # сборка и тесты
npm run bench   # сравнение скорости с grammY и Telegraf
```

<div align="center">

<br>

[MIT](LICENSE) © [sylvar1s](https://github.com/sylvar1s) · Telegram [@wyscra](https://t.me/wyscra)

</div>
