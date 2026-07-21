import { finiteOr, safeImageSrc } from './library.store';

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
