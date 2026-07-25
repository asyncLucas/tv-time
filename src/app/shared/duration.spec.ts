import { durationParts, formatDuration } from './duration';

const DAY = 60 * 24;

describe('durationParts', () => {
  it('splits a total into years, months, days and the leftover clock time', () => {
    const p = durationParts((365 + 2 * 30 + 5) * DAY + 3 * 60 + 7);
    expect(p).toEqual({ years: 1, months: 2, days: 5, hours: 3, minutes: 7 });
  });

  it('floors garbage and negatives to zero rather than emitting NaN', () => {
    expect(durationParts(NaN as number)).toEqual({ years: 0, months: 0, days: 0, hours: 0, minutes: 0 });
    expect(durationParts(-500)).toEqual({ years: 0, months: 0, days: 0, hours: 0, minutes: 0 });
  });
});

describe('formatDuration', () => {
  it('keeps the two largest non-zero units', () => {
    expect(formatDuration((365 + 2 * 30 + 5) * DAY)).toBe('1y 2mo');
    expect(formatDuration((3 * 30 + 12) * DAY)).toBe('3mo 12d');
    expect(formatDuration(5 * DAY + 4 * 60)).toBe('5d 4h');
  });

  it('skips units that are zero instead of padding with them', () => {
    expect(formatDuration(365 * DAY + 5 * DAY)).toBe('1y 5d');
  });

  it('degrades to minutes for small and empty totals', () => {
    expect(formatDuration(42)).toBe('42m');
    expect(formatDuration(0)).toBe('0m');
  });
});
