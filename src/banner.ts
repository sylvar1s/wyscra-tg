import { VERSION } from './version.js';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

let shown = false;

/** Prints the wyscra-tg banner once per process. */
export function printBanner(): void {
  if (shown) return;
  shown = true;
  console.log(`${c('1;36', 'wyscra-tg')} ${c('2', `v${VERSION}`)} ${c('2', '·')} ${c('1', 'Telegram @wyscra')}`);
}

/** Prints a status line under the banner. */
export function printStatus(text: string): void {
  printBanner();
  console.log(`${c('32', '✔')} ${text}`);
}
