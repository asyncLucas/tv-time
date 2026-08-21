import { comparator, defaultSort } from './movies';
import type { MovieView } from '../../core/models';

/** Just the fields the comparators read — the rest of a MovieView is noise here. */
function movie(
  name: string,
  fields: {
    firstReleaseDate?: string | null;
    followedAt?: string | null;
    watchedAt?: string | null;
  },
): MovieView {
  return {
    name,
    firstReleaseDate: fields.firstReleaseDate ?? null,
    followedAt: fields.followedAt ?? null,
    state: { watchedAt: fields.watchedAt ?? null },
  } as unknown as MovieView;
}

/** Names in the order the grid would render them. */
function order(ms: MovieView[], sort: Parameters<typeof comparator>[0]): string[] {
  return [...ms].sort(comparator(sort)).map((m) => m.name);
}

describe('movie grid sorting', () => {
  const films = [
    movie('Beta', {
      firstReleaseDate: '1999-05-01',
      followedAt: '2026-01-02',
      watchedAt: '2026-03-01',
    }),
    movie('Alpha', { firstReleaseDate: '2024-11-20', followedAt: '2025-06-30', watchedAt: null }),
    movie('Gamma', { firstReleaseDate: null, followedAt: null, watchedAt: '2026-08-01' }),
  ];

  it('sorts by name alphabetically', () => {
    expect(order(films, 'name')).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('sorts by release date, newest first, undated last', () => {
    expect(order(films, 'release')).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('sorts by when the film joined the library, newest first', () => {
    expect(order(films, 'added')).toEqual(['Beta', 'Alpha', 'Gamma']);
  });

  it('sorts by when it was watched, unwatched last', () => {
    expect(order(films, 'watched')).toEqual(['Gamma', 'Beta', 'Alpha']);
  });
});

/**
 * Each tab opens in the order that suits it: the Watched tab reads as a
 * history, every other tab as a shelf.
 */
describe('defaultSort', () => {
  it('opens the Watched tab on watch date and the rest on name', () => {
    expect(defaultSort('watched')).toBe('watched');
    expect(defaultSort('all')).toBe('name');
    expect(defaultSort('watchlist')).toBe('name');
    expect(defaultSort('favorites')).toBe('name');
  });
});
