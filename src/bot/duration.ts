const UNITS: Record<string, number> = {
  s: 1, sec: 1, с: 1, сек: 1,
  m: 60, min: 60, м: 60, мин: 60,
  h: 3600, ч: 3600,
  d: 86400, д: 86400,
  w: 604800, н: 604800,
};

/**
 * Длительность в секундах: число секунд или строка '30s', '10m', '1h', '2d', '1w', '1h30m', '10мин', '2ч'.
 */
export function parseDuration(value: number | string): number {
  if (typeof value === 'number') return value;
  const s = value.trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0;
  let matched = '';
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*([a-zа-я]+)/g)) {
    const unit = UNITS[m[2]];
    if (!unit) throw new Error(`Не понял единицу времени "${m[2]}" в "${value}". Примеры: 30s, 10m, 1h, 2d`);
    total += Number(m[1]) * unit;
    matched += m[0];
  }
  if (!matched || matched.replace(/\s/g, '') !== s.replace(/\s/g, '')) throw new Error(`Не понял длительность "${value}". Примеры: 30s, 10m, 1h, 2d`);
  return Math.round(total);
}

/** Unix-время «сейчас + длительность» (для until_date). */
export const untilDate = (d: number | string) => Math.floor(Date.now() / 1000) + parseDuration(d);
