import { addDays, buildWeek, compareWeek, startOfDay } from './screen-time';
import type { WatchPoint } from '../../core/models';

/** A watch at a local wall-clock time, so the buckets are tested in the user's zone. */
function at(date: Date, hour: number, minutes = 42, titleKey = 'show:1'): WatchPoint {
  const d = new Date(date);
  d.setHours(hour, 0, 0, 0);
  return { at: d.getTime(), minutes, titleKey };
}

describe('buildWeek', () => {
  const today = startOfDay(new Date(2026, 6, 22)); // Wed Jul 22 2026, local

  it('buckets watches into the seven days ending on the last day', () => {
    const week = buildWeek(
      [at(today, 20), at(today, 21), at(addDays(today, -6), 9), at(addDays(today, -3), 13)],
      today,
      today,
    );

    expect(week.days.length).toBe(7);
    expect(week.days.map((d) => d.minutes)).toEqual([42, 0, 0, 42, 0, 0, 84]);
    expect(week.total).toBe(168);
    expect(week.average).toBe(24);
    expect(week.peak).toBe(84);
  });

  it('ignores watches outside the window, so the whole timeline can be passed', () => {
    const week = buildWeek([at(addDays(today, -7), 12), at(addDays(today, 1), 12)], today, today);
    expect(week.total).toBe(0);
    expect(week.titles).toBe(0);
  });

  it('splits by local time of day, with night wrapping midnight', () => {
    const week = buildWeek(
      [at(today, 8), at(today, 14), at(today, 19), at(today, 23), at(today, 2)],
      today,
      today,
    );
    expect(week.bands.map((b) => b.minutes)).toEqual([42, 42, 42, 84]);
  });

  it('counts distinct titles, not watches', () => {
    const week = buildWeek(
      [at(today, 20, 42, 'show:1'), at(today, 21, 42, 'show:1'), at(today, 22, 115, 'movie:x')],
      today,
      today,
    );
    expect(week.titles).toBe(2);
  });

  it('labels the current day "Today" and the rest by weekday', () => {
    const week = buildWeek([], today, today);
    expect(week.days[6].label).toBe('Today');
    expect(week.days[5].label).not.toBe('Today');
  });

  it('labels no day "Today" once the window is scrolled back', () => {
    const week = buildWeek([], addDays(today, -7), today);
    expect(week.days.some((d) => d.label === 'Today')).toBe(false);
  });

  it('measures screen time against waking hours, not the whole day', () => {
    const week = buildWeek([at(today, 20, 16 * 60 * 7)], today, today);
    expect(week.wakingPct).toBe(100);
  });
});

describe('compareWeek', () => {
  it('reports direction in words as well as a glyph', () => {
    expect(compareWeek(120, 100)).toEqual({ glyph: '▲', label: 'Up 20%', dir: 'up' });
    expect(compareWeek(50, 100)).toEqual({ glyph: '▼', label: 'Down 50%', dir: 'down' });
  });

  it('treats an equal pair as no change, including two empty weeks', () => {
    expect(compareWeek(0, 0).label).toBe('No change');
    expect(compareWeek(100, 100).dir).toBe('flat');
  });

  it('avoids dividing by an empty previous week', () => {
    expect(compareWeek(42, 0).label).toBe('New activity');
    expect(compareWeek(0, 42).label).toBe('Nothing this week');
  });

  it('does not round a real change down to "0%"', () => {
    expect(compareWeek(1000.4, 1000).label).toBe('Up <1%');
  });
});
