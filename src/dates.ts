export class InputError extends Error {}

export function validDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) &&
    new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
}

export function dayAt(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function clockAt(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant);
}

export function parseTime(text: string): string | undefined {
  const match = text.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return undefined;
  let hour = Number(match[1]); const minute = Number(match[2] ?? 0), period = match[3];
  if (minute > 59 || (period ? hour < 1 || hour > 12 : hour > 23)) return undefined;
  if (period) hour = hour % 12 + (period === 'pm' ? 12 : 0);
  return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
}

export function addDays(day: string, amount: number): string {
  if (!validDay(day)) throw new InputError('Use a real calendar date in YYYY-MM-DD format.');
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}

export function monday(day: string): string {
  return addDays(day, -((new Date(day + 'T12:00:00Z').getUTCDay() + 6) % 7));
}

export function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86400000);
}

export function resolveDay(value: string | undefined, reference: string, today: string, createdDay?: string): string {
  const raw = value?.trim().toLowerCase();
  const day = !raw || raw === 'today' ? reference : raw === 'yesterday' ? addDays(reference, -1) : raw;
  if (!validDay(day)) throw new InputError('Use today, yesterday, or a real date such as 2026-10-18.');
  if (day > today) throw new InputError('Future days cannot be marked complete.');
  if (createdDay && day < createdDay) throw new InputError('That date is before this habit was created.');
  return day;
}

export function dailyStreak(dates: string[], today: string): number {
  const set = new Set(dates.filter(d => d <= today));
  let cursor = set.has(today) ? today : addDays(today, -1), count = 0;
  while (set.has(cursor)) { count++; cursor = addDays(cursor, -1); }
  return count;
}

export function weeklyTarget(target: number, createdDay: string, week: string): number {
  const firstDay = createdDay > week ? createdDay : week;
  return Math.max(0, Math.min(target, daysBetween(firstDay, addDays(week, 6)) + 1));
}

export function weeklyStreak(dates: string[], today: string, target: number, createdDay: string): number {
  const counts = new Map<string, number>();
  for (const day of new Set(dates.filter(d => d <= today))) {
    const week = monday(day); counts.set(week, (counts.get(week) ?? 0) + 1);
  }
  let cursor = monday(today), count = 0;
  const hit = (week: string) => (counts.get(week) ?? 0) >= weeklyTarget(target, createdDay, week) && week >= monday(createdDay);
  if (!hit(cursor)) cursor = addDays(cursor, -7);
  while (hit(cursor)) { count++; cursor = addDays(cursor, -7); }
  return count;
}
