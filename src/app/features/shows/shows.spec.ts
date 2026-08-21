import { isToday, localTimeToday } from './shows';

/** A local `YYYY-MM-DD` for a day offset from today. */
function localDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * `isToday` decides which airing-soon cards are worth asking TVmaze about. It
 * compares local calendar days, not instants — TMDB's air date is a bare date,
 * so any time-of-day comparison would be inventing precision it doesn't have.
 */
describe('isToday', () => {
  it('accepts today and rejects the days either side of it', () => {
    expect(isToday(localDay(0))).toBe(true);
    expect(isToday(localDay(1))).toBe(false);
    expect(isToday(localDay(-1))).toBe(false);
  });

  it('treats a missing or malformed date as not today', () => {
    expect(isToday(null)).toBe(false);
    expect(isToday('')).toBe(false);
    expect(isToday('tomorrow')).toBe(false);
    expect(isToday('2026-13')).toBe(false);
  });
});

/**
 * `localTimeToday` is what turns a card from "Today" into "Today · 21:00". It
 * only speaks for episodes airing today *here*: a broadcast late in a distant
 * timezone can be today there and tomorrow locally, and a time printed beside
 * a card that doesn't say "Today" would be wrong twice over.
 */
describe('localTimeToday', () => {
  it('formats an instant that lands on today', () => {
    const noonToday = new Date();
    noonToday.setHours(12, 0, 0, 0);
    expect(localTimeToday(noonToday.toISOString())).toBe(
      new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(noonToday),
    );
  });

  it('drops an instant that falls on another local day', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(12, 0, 0, 0);
    expect(localTimeToday(tomorrow.toISOString())).toBeNull();
  });

  it('returns null when there is no stamp, or it does not parse', () => {
    expect(localTimeToday(null)).toBeNull();
    expect(localTimeToday('')).toBeNull();
    expect(localTimeToday('soon')).toBeNull();
  });
});
