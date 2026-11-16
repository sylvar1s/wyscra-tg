#!/usr/bin/env node
// npx wyscra-tg init [папка] [--no-install]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const cmd = args[0];

if (cmd !== 'init') {
  console.log(`wyscra-tg v${pkg.version} · Telegram @wyscra

Команды:
  npx wyscra-tg init [папка]   создать новый проект бота
    --no-install               не устанавливать зависимости`);
  process.exit(cmd ? 1 : 0);
}

const dir = resolve(args.find((a, i) => i > 0 && !a.startsWith('--')) ?? 'my-bot');
const install = !args.includes('--no-install');
if (existsSync(join(dir, 'bot.js'))) {
  console.error(`В папке ${dir} уже есть bot.js — выберите другую папку.`);
  process.exit(1);
}

let token = process.env.BOT_TOKEN ?? '';
if (!token && process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  token = (await rl.question('Токен бота от @BotFather (можно оставить пустым и вписать потом в .env): ')).trim();
  rl.close();
}

mkdirSync(dir, { recursive: true });
const write = (name, content) => {
  writeFileSync(join(dir, name), content);
  console.log(`  + ${name}`);
};

console.log(`\nСоздаю проект в ${dir}`);
write(
  'package.json',
  JSON.stringify(
    {
      name: basename(dir).toLowerCase().replace(/[^a-z0-9-_]/g, '-') || 'my-bot',
      version: '1.0.0',
      private: true,
      type: 'module',
      scripts: { start: 'node bot.js', dev: 'node --watch bot.js' },
      dependencies: { 'wyscra-tg': `^${pkg.version}` },
    },
    null,
    2,
  ) + '\n',
);
write('.env', `# Токен от @BotFather\nBOT_TOKEN=${token}\n# Ваш Telegram id для /admin (узнать: @userinfobot)\nADMIN_ID=\n`);
write('.gitignore', 'node_modules/\n.env\n*.db\n*.db-*\n');
write(
  'bot.js',
  `import { Bot } from 'wyscra-tg';

// Токен берётся из .env, данные сохраняются в bot.db
const bot = new Bot({ db: 'bot.db' });

// /start — приветствие и меню
bot.command('start', 'Главное меню', (ctx) =>
  ctx.reply(\`Привет, \${ctx.from.first_name}! 👋\`, {
    keyboard: [['📋 Меню', '👤 Профиль'], ['❓ Помощь']],
  }),
);

// Кнопки под сообщением
bot.hears('📋 Меню', (ctx) =>
  ctx.reply('Выберите пункт:', {
    inline: [
      [{ text: '⭐ Нажми меня', onClick: (ctx) => ctx.alert('Кнопка работает!') }],
      [{ text: '🌐 Сайт', url: 'https://t.me/wyscra' }],
    ],
  }),
);

// Данные пользователя хранятся в базе автоматически
bot.hears('👤 Профиль', (ctx) => {
  ctx.user.visits = (ctx.user.visits ?? 0) + 1;
  return ctx.reply(\`Имя: \${ctx.user.name ?? ctx.from.first_name}\\nВизитов в профиль: \${ctx.user.visits}\`, {
    inline: [{ text: '✏️ Изменить имя', onClick: (ctx) => ctx.scene.enter('rename') }],
  });
});

// Анкета из нескольких шагов
bot.scene('rename')
  .step((ctx) => ctx.reply('Как вас называть?'))
  .step((ctx) => {
    ctx.user.name = ctx.text;
    return ctx.reply(\`Готово, \${ctx.text}!\`);
  });

bot.hears('❓ Помощь', (ctx) => ctx.reply('Напишите что-нибудь — я повторю.'));
bot.command('cancel', 'Отмена', (ctx) => (ctx.scene.leave(), ctx.reply('Отменено')));

// Админ-панель /admin (статистика, рассылка, пользователи). Укажите ADMIN_ID в .env
if (process.env.ADMIN_ID) bot.admin();

bot.on('text', (ctx) => ctx.reply(ctx.text));

bot.start();
`,
);

if (install) {
  console.log('\nУстанавливаю зависимости (npm install)...');
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-fund', '--no-audit'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) console.log('Не получилось установить автоматически — выполните npm install в папке проекта.');
}

const rel = basename(dir);
console.log(`
Готово! Дальше:
  cd ${rel}${token ? '' : '\n  (впишите BOT_TOKEN в файл .env)'}${install ? '' : '\n  npm install'}
  npm start

Документация: https://github.com/sylvar1s/wyscra-tg · Telegram @wyscra
`);
