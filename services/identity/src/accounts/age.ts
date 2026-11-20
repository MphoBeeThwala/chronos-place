/**
 * The 18+ rule (ADR-0018). No under-18s under any circumstance: this is a constant in code, not
 * configuration, and nothing in the service can lower or bypass it.
 */
export const MINIMUM_AGE = 18;

/** Ages are worked out on the calendar date in South Africa, the launch market. */
const ZONE = 'Africa/Johannesburg';

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/** True when the parts form a real calendar date (no 31 April, 29 February only in leap years). */
export function isRealDate({ year, month, day }: CalendarDate): boolean {
  if (![year, month, day].every(Number.isInteger)) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function todayInSouthAfrica(now: Date): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-ZA', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: part('year'), month: part('month'), day: part('day') };
}

/** Whole years between two dates. Someone born on 29 February turns a year older on 1 March. */
export function ageOn(dateOfBirth: CalendarDate, today: CalendarDate): number {
  const hadBirthday =
    today.month > dateOfBirth.month ||
    (today.month === dateOfBirth.month && today.day >= dateOfBirth.day);
  return today.year - dateOfBirth.year - (hadBirthday ? 0 : 1);
}

export function isAdult(dateOfBirth: CalendarDate, now: Date): boolean {
  return ageOn(dateOfBirth, todayInSouthAfrica(now)) >= MINIMUM_AGE;
}

export function toIsoDate({ year, month, day }: CalendarDate): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Earliest year accepted, to reject typos such as 0199. */
export const EARLIEST_BIRTH_YEAR = 1900;
