import { dropBulkTicks, finiteOr, safeImageSrc } from './library.store';

/**
 * These two guard values that arrive from a synced peer or an imported file —
 * i.e. from outside this device's control — before they reach the UI.
 */
describe('safeImageSrc', () => {
  it('passes through an avatar data URI, the only form the app writes', () => {
    const uri = 'data:image/jpeg;base64,/9j/4AAQ';
    expect(safeImageSrc(uri)).toBe(uri);
  });

  it('rejects script and other non-image URLs', () => {
    expect(safeImageSrc('javascript:alert(1)')).toBeNull();
    expect(safeImageSrc('https://example.com/tracker.png')).toBeNull();
    expect(safeImageSrc('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(safeImageSrc(42)).toBeNull();
    expect(safeImageSrc({ toString: () => 'data:image/png,x' })).toBeNull();
  });

  it('distinguishes "cleared" from "not edited"', () => {
    expect(safeImageSrc(null)).toBeNull(); // cleared → override the seed
    expect(safeImageSrc(undefined)).toBeUndefined(); // untouched → fall back to seed
  });
});

describe('finiteOr', () => {
  it('accepts non-negative finite numbers', () => {
    expect(finiteOr(0)).toBe(0);
    expect(finiteOr(1234)).toBe(1234);
  });

  it('rejects values that would poison derived stats', () => {
    expect(finiteOr(NaN)).toBeUndefined();
    expect(finiteOr(Infinity)).toBeUndefined();
    expect(finiteOr(-5)).toBeUndefined();
    expect(finiteOr('1234')).toBeUndefined();
    expect(finiteOr(null)).toBeUndefined();
    expect(finiteOr(undefined)).toBeUndefined();
  });
});

/**
 * Guards the watch timeline against timestamps that record bookkeeping rather
 * than viewing — a season marked in one go, or an import stamping every dateless
 * row with the moment it ran.
 */
describe('dropBulkTicks', () => {
  const MIN = 60_000;
  const point = (atMinutes: number, minutes = 42) => ({
    at: atMinutes * MIN,
    minutes,
    titleKey: 'show:1',
  });

  it('keeps a binge, where each episode is ticked as it finishes', () => {
    const binge = Array.from({ length: 12 }, (_, i) => point(i * 42));
    expect(dropBulkTicks(binge).length).toBe(12);
  });

  it('keeps a short catch-up — a few episodes ticked off at the end of a night', () => {
    const evening = Array.from({ length: 4 }, () => point(0));
    expect(dropBulkTicks(evening).length).toBe(4);
  });

  it('drops a season marked in one go, whole rather than trimmed', () => {
    const season = Array.from({ length: 22 }, () => point(0));
    const later = point(600);
    expect(dropBulkTicks([...season, later])).toEqual([later]);
  });

  it('drops an import stamping hundreds of rows across a few minutes', () => {
    const imported = Array.from({ length: 300 }, (_, i) => point(i / 100));
    expect(dropBulkTicks(imported)).toEqual([]);
  });

  it('judges each burst separately, so a catch-up does not take the day with it', () => {
    const bulk = Array.from({ length: 30 }, () => point(0));
    const evening = [point(600), point(645), point(690)];
    expect(dropBulkTicks([...bulk, ...evening])).toEqual(evening);
  });

  it('returns what it keeps in time order, whatever order it was given', () => {
    const log = [point(30), point(10), point(20)];
    expect(dropBulkTicks(log).map((p) => p.at)).toEqual([10 * MIN, 20 * MIN, 30 * MIN]);
  });
});
