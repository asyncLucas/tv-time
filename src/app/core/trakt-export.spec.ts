import { movieItem, showItem, traktDate, traktId, traktRating } from './trakt-export.service';
import type { MovieView, ShowView } from './models';

/**
 * The import file is read by someone else's parser: a field that is subtly
 * wrong (a non-ISO date, a rating out of range, an id with no namespace) is
 * rejected silently, item by item. These cover the projection rules.
 */

const NOW = '2026-07-22T12:00:00.000Z';

function movie(over: Partial<MovieView> = {}, state: Partial<MovieView['state']> = {}): MovieView {
  return {
    uuid: 'm1',
    name: 'The Godfather',
    imdbId: 'tt0068646',
    tvdbId: null,
    genres: [],
    firstReleaseDate: null,
    overview: null,
    followedAt: null,
    watchedAt: null,
    favorite: false,
    ...over,
    state: {
      watched: false,
      watchedAt: null,
      watchlist: false,
      favorite: false,
      rating: null,
      updatedAt: null,
      ...state,
    },
  };
}

function show(over: Partial<ShowView> = {}, state: Partial<ShowView['state']> = {}): ShowView {
  return {
    uuid: 's1',
    name: 'Severance',
    tvdbId: '371980',
    genres: [],
    firstReleaseDate: null,
    overview: null,
    followedAt: null,
    showWatchedAt: null,
    isEnded: null,
    dayOfWeek: null,
    network: null,
    country: null,
    hashtag: null,
    cachedPoster: null,
    favorite: false,
    watchedEpisodeCount: 0,
    ...over,
    state: {
      status: 'none',
      favorite: false,
      rating: null,
      addedAt: null,
      updatedAt: null,
      ...state,
    },
  };
}

describe('traktDate', () => {
  it('passes ISO stamps through', () => {
    expect(traktDate('2019-09-03T10:32:47Z')).toBe('2019-09-03T10:32:47.000Z');
  });

  it('normalizes the space-separated form TV Time backups use', () => {
    expect(traktDate('2019-09-03 10:32:47')).toMatch(/^2019-09-03T\d{2}:32:47\.000Z$/);
  });

  it('rejects anything unparseable rather than emitting it', () => {
    expect(traktDate('someday')).toBeNull();
    expect(traktDate('')).toBeNull();
    expect(traktDate(null)).toBeNull();
    expect(traktDate(1568111567)).toBeNull();
  });
});

describe('traktRating', () => {
  it('accepts whole 1–10 ratings', () => {
    expect(traktRating(1)).toBe(1);
    expect(traktRating(10)).toBe(10);
    expect(traktRating(7.4)).toBe(7);
  });

  it('drops out-of-range and non-numeric ratings', () => {
    expect(traktRating(0)).toBeUndefined();
    expect(traktRating(11)).toBeUndefined();
    expect(traktRating(null)).toBeUndefined();
    expect(traktRating('8')).toBeUndefined();
  });
});

describe('traktId', () => {
  it('prefers the external ids the backup carries', () => {
    expect(traktId('m1', { imdbId: 'tt0068646' })).toEqual({ imdb_id: 'tt0068646' });
    expect(traktId('s1', { tvdbId: '371980' })).toEqual({ tvdb_id: '371980' });
  });

  it('falls back to the TMDB id encoded in an added title uuid', () => {
    expect(traktId('tmdb:movie:550', {})).toEqual({ tmdb_id: '550' });
  });

  it('returns null when no id Trakt accepts exists', () => {
    expect(traktId('legacy-uuid', { imdbId: null, tvdbId: null })).toBeNull();
  });
});

describe('movieItem', () => {
  it('carries watch, watchlist and rating on one item', () => {
    const item = movieItem(
      movie(
        { followedAt: '2024-10-01T10:00:00Z' },
        {
          watched: true,
          watchedAt: '2024-10-25T20:00:00Z',
          watchlist: true,
          rating: 6,
          updatedAt: '2024-10-26T21:00:00Z',
        },
      ),
      NOW,
    );
    expect(item).toEqual({
      imdb_id: 'tt0068646',
      type: 'movie',
      watched_at: '2024-10-25T20:00:00.000Z',
      watchlisted_at: '2024-10-01T10:00:00.000Z',
      rating: 6,
      rated_at: '2024-10-26T21:00:00.000Z',
    });
  });

  it('marks a watch with no date as unknown instead of dropping it', () => {
    expect(movieItem(movie({}, { watched: true }), NOW)?.watched_at).toBe('unknown');
  });

  it('dates an undated watchlist entry at export time — the format has no "unknown" there', () => {
    expect(movieItem(movie({}, { watchlist: true }), NOW)?.watchlisted_at).toBe(NOW);
  });

  it('emits nothing for a film the format cannot describe', () => {
    expect(movieItem(movie({}, { favorite: true }), NOW)).toBeNull(); // favorites have no field
    expect(movieItem(movie({ imdbId: null }, { watched: true }), NOW)).toBeNull(); // no usable id
  });
});

describe('showItem', () => {
  it('exports a watchlisted show with its follow date', () => {
    const item = showItem(
      show({ followedAt: '2025-02-01T00:00:00Z' }, { status: 'watchlist' }),
      false,
      NOW,
    );
    expect(item).toEqual({
      tvdb_id: '371980',
      type: 'show',
      watchlisted_at: '2025-02-01T00:00:00.000Z',
    });
  });

  it('never sets a show-level watch date when episode rows exist', () => {
    // A show-level watched_at marks EVERY episode watched on Trakt, which would
    // bulldoze the precise per-episode history exported alongside it.
    const item = showItem(show({}, { status: 'completed', rating: 9 }), true, NOW);
    expect(item?.watched_at).toBeUndefined();
    expect(item?.rating).toBe(9);
  });

  it('keeps whole-show completion when there is no episode history to carry it', () => {
    const item = showItem(
      show({ showWatchedAt: '2023-05-01T00:00:00Z' }, { status: 'completed' }),
      false,
      NOW,
    );
    expect(item?.watched_at).toBe('2023-05-01T00:00:00.000Z');
  });

  it('emits nothing for a merely-followed show', () => {
    expect(showItem(show({}, { status: 'watching' }), false, NOW)).toBeNull();
  });
});
