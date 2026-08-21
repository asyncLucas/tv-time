import {
  byWatchRecency,
  dropBulkTicks,
  finiteOr,
  mirrorDone,
  safeImageSrc,
  supersededUuids,
  watchlistIntent,
} from './library.store';
import { blamesSession } from './tmdb.service';
import type { ShowStatus } from './models';

/**
 * The Recently watched feed is a slice off the top of this ordering, so what
 * the comparator does with equal timestamps decides which five episodes the
 * home page shows — and a season marked watched in one go gives every episode
 * the same timestamp.
 */
describe('byWatchRecency', () => {
  const w = (watchedAt: string, season: number, episode: number, name = 'Vikings') => ({
    watchedAt,
    season,
    episode,
    show: { name },
  });
  const order = (rows: ReturnType<typeof w>[]) =>
    [...rows].sort(byWatchRecency).map((r) => `${r.show.name} S${r.season}E${r.episode}`);

  const BULK = '2026-07-22T20:25:52.109Z';

  it('puts the most recent watch first, whatever its episode number', () => {
    expect(order([w('2026-07-01T10:00:00Z', 1, 9), w('2026-07-20T10:00:00Z', 1, 2)])).toEqual([
      'Vikings S1E2',
      'Vikings S1E9',
    ]);
  });

  it('reads a bulk-marked season back from its finale, not its premiere', () => {
    // Every episode shares one timestamp, so only the fallback can order them.
    const season = [1, 2, 3, 4, 5].map((e) => w(BULK, 1, e));
    expect(order(season)).toEqual([
      'Vikings S1E5',
      'Vikings S1E4',
      'Vikings S1E3',
      'Vikings S1E2',
      'Vikings S1E1',
    ]);
  });

  it('ranks a later season above an earlier one stamped at the same moment', () => {
    expect(order([w(BULK, 1, 20), w(BULK, 2, 1)])).toEqual(['Vikings S2E1', 'Vikings S1E20']);
  });

  it('settles a tie between two shows by name, so the order never shifts', () => {
    const rows = [w(BULK, 1, 1, 'Narcos'), w(BULK, 1, 1, 'Dynasty')];
    expect(order(rows)).toEqual(['Dynasty S1E1', 'Narcos S1E1']);
    expect(order([...rows].reverse())).toEqual(['Dynasty S1E1', 'Narcos S1E1']);
  });
});

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

/**
 * The catalog wins when a user adds a title they already had, so the added
 * entry's own `tmdb:show:<id>` uuid stops resolving. Anything still addressing a
 * title by that uuid — a Trending card, a link from another device — has to be
 * pointed at the entry that survived, or it lands on a detail page convinced the
 * title is unknown and offers to add it a second time.
 */
describe('supersededUuids', () => {
  const catalog = [
    { uuid: 'catalog-breaking-bad', id: '81189' },
    { uuid: 'catalog-the-wire', id: '79126' },
  ];

  it('maps an added title onto the catalog entry that absorbed it', () => {
    const added = [{ uuid: 'tmdb:show:1396', id: '81189' }];
    expect(supersededUuids(catalog, added).get('tmdb:show:1396')).toBe('catalog-breaking-bad');
  });

  it('leaves a genuinely new title alone — it is the entry that resolves', () => {
    const added = [{ uuid: 'tmdb:show:1399', id: '121361' }];
    expect(supersededUuids(catalog, added).has('tmdb:show:1399')).toBeFalse();
  });

  it('never supersedes a title with no source id, which cannot be matched', () => {
    const added = [{ uuid: 'tmdb:show:1396', id: null }];
    expect(supersededUuids(catalog, added).size).toBe(0);
  });

  it('ignores catalog entries with no source id rather than colliding on null', () => {
    const partial = [{ uuid: 'catalog-unknown-id', id: null }];
    expect(supersededUuids(partial, [{ uuid: 'tmdb:show:1396', id: null }]).size).toBe(0);
  });

  it('never maps a uuid to itself, which would be a redirect loop', () => {
    const shared = [{ uuid: 'tmdb:show:1396', id: '81189' }];
    expect(supersededUuids(shared, shared).size).toBe(0);
  });

  it('handles the empty library', () => {
    expect(supersededUuids([], []).size).toBe(0);
  });
});

/**
 * The one rule that decides whether a local status change reaches someone's
 * TMDB profile. Getting it wrong is not a rendering bug — it silently
 * rearranges an account on another service — so the mapping is pinned here
 * rather than left to be discovered by clicking through the status menu.
 */
describe('watchlistIntent', () => {
  /** A title the user added from TMDB, which the add already put on the list. */
  const added = (from: ShowStatus, to: ShowStatus) => watchlistIntent(from, to, true);
  /** A title from the imported backup, which nothing has mirrored anywhere. */
  const catalog = (from: ShowStatus, to: ShowStatus) => watchlistIntent(from, to, false);

  it('puts a watchlisted show on the TMDB watchlist', () => {
    expect(catalog('none', 'watchlist')).toBeTrue();
    expect(added('watching', 'watchlist')).toBeTrue();
  });

  it('leaves TMDB alone for the states it has no shelf for', () => {
    // TMDB knows nothing about being partway through a series, and starting a
    // show is not a reason to rearrange a profile elsewhere.
    expect(catalog('watchlist', 'watching')).toBeNull();
    expect(catalog('watching', 'paused')).toBeNull();
    expect(catalog('watching', 'completed')).toBeNull();
  });

  it('takes a show off the list when it was the one we put there', () => {
    expect(catalog('watchlist', 'none')).toBeFalse();
    expect(catalog('watchlist', 'dropped')).toBeFalse();
    // Adding a title mirrors it onto the watchlist, so any exit removes it.
    expect(added('watching', 'dropped')).toBeFalse();
  });

  it('does not claim to remove a catalog show that was never mirrored', () => {
    // Shelving a backup show never touched TMDB, so neither should dropping it
    // — the toast is the only evidence the user gets, and it would be false.
    expect(catalog('watching', 'dropped')).toBeNull();
    expect(catalog('completed', 'none')).toBeNull();
  });

  it('ignores a status set to what it already was', () => {
    expect(added('watchlist', 'watchlist')).toBeNull();
    expect(catalog('none', 'none')).toBeNull();
  });
});

/** The toast is the only evidence a mirror happened, so it has to say which way. */
describe('mirrorDone', () => {
  it('names the direction, not just the field', () => {
    expect(mirrorDone('watchlist', true)).toContain('Added');
    expect(mirrorDone('watchlist', false)).toContain('Removed');
    expect(mirrorDone('favorite', true)).toContain('favorites');
    expect(mirrorDone('favorite', false)).toContain('Removed');
  });

  it('reads a cleared rating as a withdrawal rather than a score of nothing', () => {
    expect(mirrorDone('rating', null)).toBe('Rating withdrawn from TMDB.');
    expect(mirrorDone('rating', 8)).toBe('Rated 8/10 on TMDB.');
  });
});

/**
 * Mirroring now fires on ordinary actions, so a 401 is something a user with a
 * mistyped or rotated key meets on their next click — and reading that as "your
 * session died" would unlink a TMDB account that was never the problem.
 */
describe('blamesSession', () => {
  it('keeps the account linked when TMDB blames the API key', () => {
    expect(
      blamesSession({ data: { status_code: 7, status_message: 'Invalid API key.' } }),
    ).toBeFalse();
  });

  it('drops the session when TMDB blames the session', () => {
    expect(blamesSession({ data: { status_code: 3 } })).toBeTrue();
    expect(blamesSession({ data: { status_code: 14 } })).toBeTrue();
  });

  it('treats an unreadable refusal as a session failure, which self-heals', () => {
    expect(blamesSession({ data: null })).toBeTrue();
    expect(blamesSession({ data: {} })).toBeTrue();
  });
});
