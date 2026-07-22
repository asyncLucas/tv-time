import { normalizeLogin } from './library.store';
import {
  isGistId,
  packPublicProfile,
  parsePublicProfile,
  safeHttpsUrl,
  PUBLIC_KIND,
} from './public-profile.service';

/**
 * The handle is typed by a person and then rendered on a page strangers can
 * open, so it is folded into a fixed shape rather than stored as typed.
 */
describe('normalizeLogin', () => {
  it('strips a leading @ and lower-cases', () => {
    expect(normalizeLogin('@LucasSilva')).toBe('lucassilva');
  });

  it('collapses spaces and punctuation into hyphens', () => {
    expect(normalizeLogin('Jo  Smith!')).toBe('jo-smith');
  });

  it('trims the hyphens its own collapsing introduces at the edges', () => {
    expect(normalizeLogin('  hi  ')).toBe('hi');
    expect(normalizeLogin('!!wow!!')).toBe('wow');
  });

  it('keeps the characters a handle is allowed to contain', () => {
    expect(normalizeLogin('a.b_c-1')).toBe('a.b_c-1');
  });

  it('caps the length', () => {
    expect(normalizeLogin('x'.repeat(80)).length).toBe(39);
  });

  it('returns empty when nothing usable survives — callers read that as "clear it"', () => {
    expect(normalizeLogin('   ')).toBe('');
    expect(normalizeLogin('@@@')).toBe('');
  });
});

describe('isGistId', () => {
  it('accepts a GitHub gist id', () => {
    expect(isGistId('aa93bd1b0a5b9c9c62e0f5f4dfe3c2b1')).toBe(true);
  });

  it('rejects anything that could be spliced into a request path', () => {
    expect(isGistId('../../users/someone')).toBe(false);
    expect(isGistId('abc?per_page=100')).toBe(false);
    expect(isGistId('')).toBe(false);
    expect(isGistId(null)).toBe(false);
  });
});

describe('safeHttpsUrl', () => {
  it('passes an https poster URL', () => {
    const url = 'https://artworks.thetvdb.com/banners/posters/1.jpg';
    expect(safeHttpsUrl(url)).toBe(url);
  });

  it('rejects every other scheme', () => {
    expect(safeHttpsUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpsUrl('http://example.com/p.jpg')).toBeNull();
    expect(safeHttpsUrl('/relative.jpg')).toBeNull();
    expect(safeHttpsUrl(42)).toBeNull();
  });
});

describe('packPublicProfile', () => {
  const base = {
    name: 'Lucas',
    login: 'lucas',
    image: null,
    banner: null,
    memberSince: '2014-02-03',
    lifetimeMinutes: 1234.6,
    stats: {
      showsFollowed: 5,
      showsCompleted: 2,
      showsFavorite: 3,
      moviesWatched: 9,
      episodesWatched: 400,
    },
    favoriteShows: [],
    favoriteMovies: [],
    genres: [],
    publishedAt: '2026-07-22T10:00:00.000Z',
  };

  it('stamps the discriminator the reader insists on', () => {
    expect(packPublicProfile(base).kind).toBe(PUBLIC_KIND);
  });

  it('rounds the headline minutes — the page renders a duration, not a fraction', () => {
    expect(packPublicProfile(base).lifetimeMinutes).toBe(1235);
  });

  it('caps the published lists', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      name: `Show ${i}`,
      poster: null,
      year: null,
    }));
    const packed = packPublicProfile({ ...base, favoriteShows: many, favoriteMovies: many });
    expect(packed.favoriteShows.length).toBe(24);
    expect(packed.favoriteMovies.length).toBe(24);
  });

  /**
   * The published file is held to exactly what the consent dialog lists. The
   * timezone was once in here: never rendered, never disclosed, and a location
   * signal — so this asserts the *absence* of a field, which is the only kind
   * of test that catches it being quietly reintroduced.
   */
  it('publishes only the fields the consent dialog names', () => {
    const packed = packPublicProfile({ ...base, timezone: 'Europe/Lisbon' } as any);
    expect(Object.keys(packed).sort()).toEqual(
      [
        'banner',
        'favoriteMovies',
        'favoriteShows',
        'genres',
        'image',
        'kind',
        'lifetimeMinutes',
        'login',
        'memberSince',
        'name',
        'publishedAt',
        'schema',
        'stats',
      ].sort(),
    );
    expect(JSON.stringify(packed)).not.toContain('Europe/Lisbon');
  });
});

/**
 * `parsePublicProfile` reads a file *someone else* wrote — the gist id in the
 * URL can point at any public gist on GitHub. Every field it returns has been
 * checked, so these are the tests that keep the public page from rendering a
 * hand-crafted payload.
 */
describe('parsePublicProfile', () => {
  const valid = {
    kind: PUBLIC_KIND,
    schema: 1,
    publishedAt: '2026-07-22T10:00:00.000Z',
    name: 'Lucas',
    login: '@Lucas',
    image: 'data:image/jpeg;base64,/9j/4AAQ',
    banner: null,
    memberSince: '2014-02-03',
    lifetimeMinutes: 500,
    stats: { showsFollowed: 5, showsCompleted: 2, showsFavorite: 3, moviesWatched: 9, episodesWatched: 400 },
    favoriteShows: [{ name: 'Dark', poster: 'https://img/1.jpg', year: null }],
    favoriteMovies: [],
    genres: [{ name: 'Drama', count: 12, pct: 100 }],
  };

  it('reads back a profile this app published', () => {
    const p = parsePublicProfile(JSON.stringify(valid))!;
    expect(p.name).toBe('Lucas');
    expect(p.login).toBe('lucas'); // normalized on the way in, too
    expect(p.stats.episodesWatched).toBe(400);
    expect(p.favoriteShows[0].poster).toBe('https://img/1.jpg');
  });

  it('refuses a gist that is not one of ours', () => {
    expect(parsePublicProfile('{"kind":"something-else"}')).toBeNull();
    expect(parsePublicProfile('not json at all')).toBeNull();
    expect(parsePublicProfile('null')).toBeNull();
  });

  it('drops an avatar or cover that is not an image data URI', () => {
    const p = parsePublicProfile(
      JSON.stringify({ ...valid, image: 'javascript:alert(1)', banner: 'https://tracker/x.png' }),
    )!;
    expect(p.image).toBeNull();
    expect(p.banner).toBeNull();
  });

  it('drops a poster that is not an https URL', () => {
    const p = parsePublicProfile(
      JSON.stringify({
        ...valid,
        favoriteShows: [{ name: 'Dark', poster: 'javascript:alert(1)', year: null }],
      }),
    )!;
    expect(p.favoriteShows[0].poster).toBeNull();
  });

  it('substitutes zero for stats that are not numbers', () => {
    const p = parsePublicProfile(
      JSON.stringify({ ...valid, lifetimeMinutes: 'lots', stats: { showsFollowed: '9' } }),
    )!;
    expect(p.lifetimeMinutes).toBe(0);
    expect(p.stats.showsFollowed).toBe(0);
    expect(p.stats.episodesWatched).toBe(0);
  });

  it('clamps a genre bar that would otherwise draw outside its track', () => {
    const p = parsePublicProfile(
      JSON.stringify({ ...valid, genres: [{ name: 'Drama', count: 1, pct: 4000 }] }),
    )!;
    expect(p.genres[0].pct).toBe(100);
  });

  it('survives missing sections rather than throwing on a truncated file', () => {
    const p = parsePublicProfile(JSON.stringify({ kind: PUBLIC_KIND }))!;
    expect(p.name).toBe('');
    expect(p.favoriteShows).toEqual([]);
    expect(p.genres).toEqual([]);
    expect(p.stats.moviesWatched).toBe(0);
  });

  it('ignores list entries that are not objects, and unnamed ones', () => {
    const p = parsePublicProfile(
      JSON.stringify({
        ...valid,
        favoriteShows: ['nope', null, { poster: 'https://img/1.jpg' }, { name: 'Dark' }],
        genres: 'not an array',
      }),
    )!;
    expect(p.favoriteShows.map((f) => f.name)).toEqual(['Dark']);
    expect(p.genres).toEqual([]);
  });

  it('truncates free text rather than letting it run down the page', () => {
    const p = parsePublicProfile(JSON.stringify({ ...valid, name: 'n'.repeat(500) }))!;
    expect(p.name.length).toBe(120);
  });

  /**
   * The cap bounds what gets drawn; it must not be spent on entries that were
   * never going to draw. Junk at the head of the list used to swallow it whole,
   * emptying a rail that had real entries sitting right behind the padding.
   */
  it('spends the list cap on usable entries, not on the junk in front of them', () => {
    const padding = Array.from({ length: 24 }, () => ({ poster: 'https://img/x.jpg' }));
    const real = Array.from({ length: 5 }, (_, i) => ({
      name: `Show ${i}`,
      poster: null,
      year: null,
    }));
    const p = parsePublicProfile(
      JSON.stringify({ ...valid, favoriteShows: [...padding, ...real] }),
    )!;
    expect(p.favoriteShows.map((f) => f.name)).toEqual([
      'Show 0',
      'Show 1',
      'Show 2',
      'Show 3',
      'Show 4',
    ]);
  });

  it('still caps a list that is all usable entries', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `Show ${i}` }));
    const p = parsePublicProfile(JSON.stringify({ ...valid, favoriteShows: many }))!;
    expect(p.favoriteShows.length).toBe(24);
  });

  it('drops a timezone left in an older published file rather than reading it back', () => {
    const p = parsePublicProfile(JSON.stringify({ ...valid, timezone: 'Europe/Lisbon' }))!;
    expect((p as any).timezone).toBeUndefined();
  });
});
