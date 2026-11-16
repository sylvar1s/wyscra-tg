import { parseDuration } from './duration.js';

/** Разобранное cron-выражение: минуты, часы, дни месяца, месяцы, дни недели. */
interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  anyDay: boolean;
  anyWeekday: boolean;
}

const ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@hourly': '0 * * * *',
};

function field(expr: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of expr.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    let from = min;
    let to = max;
    if (range !== '*') {
      const [a, b] = range.split('-').map(Number);
      from = a;
      to = b ?? (stepStr ? max : a);
    }
    if ([from, to, step].some((n) => !Number.isInteger(n)) || from < min || to > max || step < 1) {
      throw new Error(`Неверное поле cron "${expr}" (допустимо ${min}-${max})`);
    }
    for (let i = from; i <= to; i += step) out.add(i);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const parts = (ALIASES[expr.trim()] ?? expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron должен состоять из 5 полей: "минуты часы день месяц день_недели", получено "${expr}"`);
  const weekday = field(parts[4], 0, 7);
  if (weekday.has(7)) weekday.add(0);
  return {
    minute: field(parts[0], 0, 59),
    hour: field(parts[1], 0, 23),
    day: field(parts[2], 1, 31),
    month: field(parts[3], 1, 12),
    weekday,
    anyDay: parts[2] === '*',
    anyWeekday: parts[4] === '*',
  };
}

/** Следующий момент (после `from`) по cron в локальном времени сервера. */
export function nextCron(cron: Cron, from = new Date()): Date {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const dayOk =
      cron.anyDay && cron.anyWeekday ? true
      : cron.anyDay ? cron.weekday.has(d.getDay())
      : cron.anyWeekday ? cron.day.has(d.getDate())
      : cron.day.has(d.getDate()) || cron.weekday.has(d.getDay());
    if (cron.month.has(d.getMonth() + 1) && dayOk && cron.hour.has(d.getHours()) && cron.minute.has(d.getMinutes())) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  throw new Error('cron: нет подходящего времени в течение года');
}

export interface Job {
  /** Остановить задачу. */
  stop(): void;
  /** Когда запустится в следующий раз. */
  readonly next?: Date;
}

/** Планировщик задач бота. Ошибки задач не роняют бота. */
export class Scheduler {
  private readonly jobs = new Set<{ stop(): void }>();

  constructor(private readonly onError: (e: unknown, name: string) => void) {}

  private wrap(name: string, fn: () => unknown) {
    return async () => {
      try {
        await fn();
      } catch (e) {
        this.onError(e, name);
      }
    };
  }

  /** Повторять каждые N: `every('10m', fn)`. */
  every(interval: number | string, fn: () => unknown): Job {
    const ms = parseDuration(interval) * 1000;
    if (ms <= 0) throw new Error('Интервал должен быть больше нуля');
    const t = setInterval(this.wrap(`every ${interval}`, fn), ms);
    const job = { stop: () => (clearInterval(t), this.jobs.delete(job)) };
    this.jobs.add(job);
    return job;
  }

  /** По cron-выражению: `cron('0 9 * * 1-5', fn)` — в 9:00 по будням. */
  cron(expr: string, fn: () => unknown): Job {
    const c = parseCron(expr);
    let timer: NodeJS.Timeout | undefined;
    let next: Date;
    const run = this.wrap(`cron ${expr}`, fn);
    const schedule = () => {
      next = nextCron(c);
      // setTimeout max ~24.8 days: re-check in steps
      const wait = Math.min(next.getTime() - Date.now(), 2 ** 31 - 1);
      timer = setTimeout(() => {
        if (Date.now() >= next.getTime() - 1000) void run();
        schedule();
      }, Math.max(0, wait));
    };
    schedule();
    const job = {
      stop: () => (clearTimeout(timer), this.jobs.delete(job)),
      get next() {
        return next;
      },
    };
    this.jobs.add(job);
    return job;
  }

  /** Каждый день в указанное время сервера: `daily('09:30', fn)`. */
  daily(time: string, fn: () => unknown): Job {
    const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
    if (!m) throw new Error(`Время в формате ЧЧ:ММ, например "09:30", получено "${time}"`);
    return this.cron(`${Number(m[2])} ${Number(m[1])} * * *`, fn);
  }

  /** Один раз через N или в указанный момент: `once('5m', fn)`, `once(new Date(...), fn)`. */
  once(when: number | string | Date, fn: () => unknown): Job {
    const ms = when instanceof Date ? when.getTime() - Date.now() : parseDuration(when) * 1000;
    const t = setTimeout(() => {
      this.jobs.delete(job);
      void this.wrap('once', fn)();
    }, Math.max(0, Math.min(ms, 2 ** 31 - 1)));
    const job = { stop: () => (clearTimeout(t), this.jobs.delete(job)) };
    this.jobs.add(job);
    return job;
  }

  stopAll(): void {
    for (const j of [...this.jobs]) j.stop();
  }
}
