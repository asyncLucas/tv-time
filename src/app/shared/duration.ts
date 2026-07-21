/**
 * Watch-time formatting.
 *
 * Lifetime totals get large fast — tens of thousands of minutes read as noise,
 * and a bare day count ("412d") is hard to feel. So totals are broken into
 * years / months / days, the units people actually think in.
 *
 * Months are a fixed 30 days and years a fixed 365: this measures a *duration*
 * (time spent watching), not a span between two calendar dates, so there is no
 * calendar to be exact about. Fixed divisors keep the number stable — it only
 * ever moves when you watch something.
 */
const MIN_PER_HOUR = 60;
const MIN_PER_DAY = MIN_PER_HOUR * 24;
const DAYS_PER_MONTH = 30;
const DAYS_PER_YEAR = 365;

export interface DurationParts {
  years: number;
  months: number;
  days: number;
  hours: number;
  minutes: number;
}

export function durationParts(totalMinutes: number): DurationParts {
  const total = Math.max(0, Math.floor(totalMinutes || 0));
  const totalDays = Math.floor(total / MIN_PER_DAY);
  const restOfDay = total % MIN_PER_DAY;
  const years = Math.floor(totalDays / DAYS_PER_YEAR);
  const afterYears = totalDays % DAYS_PER_YEAR;
  return {
    years,
    months: Math.floor(afterYears / DAYS_PER_MONTH),
    days: afterYears % DAYS_PER_MONTH,
    hours: Math.floor(restOfDay / MIN_PER_HOUR),
    minutes: restOfDay % MIN_PER_HOUR,
  };
}

/**
 * Compact label: the two largest non-zero units, e.g. `1y 2mo`, `3mo 12d`,
 * `5d 4h`. Two units is the sweet spot — enough to feel the scale, short
 * enough to sit inside a stat tile without wrapping.
 */
export function formatDuration(totalMinutes: number): string {
  const p = durationParts(totalMinutes);
  const units: [number, string][] = [
    [p.years, 'y'],
    // 'mo', not 'm' — minutes already own 'm', and "2m" reading as two months
    // in one tile and two minutes in another is worse than one extra character.
    [p.months, 'mo'],
    [p.days, 'd'],
    [p.hours, 'h'],
    [p.minutes, 'm'],
  ];
  // Drop empty units BEFORE taking two, so a zero in the middle ("1y 0mo 5d")
  // costs the label its second unit rather than being silently spent as one.
  const shown = units.filter(([n]) => n > 0).slice(0, 2);
  if (!shown.length) return '0m';
  return shown.map(([n, u]) => `${n}${u}`).join(' ');
}

/** Long form for the profile header, e.g. `1 year, 2 months, 5 days`. */
export function formatDurationLong(totalMinutes: number): string {
  const p = durationParts(totalMinutes);
  const units: [number, string][] = [
    [p.years, 'year'],
    [p.months, 'month'],
    [p.days, 'day'],
  ];
  const named = units.filter(([n]) => n > 0).map(([n, u]) => `${n} ${u}${n === 1 ? '' : 's'}`);
  if (!named.length) return `${p.hours} hour${p.hours === 1 ? '' : 's'}`;
  return named.join(', ');
}
