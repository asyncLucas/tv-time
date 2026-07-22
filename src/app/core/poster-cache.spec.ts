import { TestBed } from '@angular/core/testing';
import { DocService } from './doc.service';
import { PosterCacheService } from './poster-cache.service';
import { isBearerToken } from './tmdb.service';

/**
 * The poster cache is what makes film covers survive a device with no TMDB key,
 * so the properties worth pinning are: it reads back what it stored, it doesn't
 * confuse the two id spaces, and it doesn't rewrite unchanged values (poster
 * components resolve on every scroll — churn there is churn on the sync wire).
 */
describe('PosterCacheService', () => {
  let docs: DocService;
  let cache: PosterCacheService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [DocService, PosterCacheService] });
    docs = TestBed.inject(DocService);
    cache = TestBed.inject(PosterCacheService);
  });

  it('returns null for a title nobody has resolved', () => {
    expect(cache.url({ imdbId: 'tt1413492' })).toBeNull();
  });

  it('builds an absolute TMDB url from a remembered path', () => {
    cache.remember({ imdbId: 'tt1413492' }, '/poster.jpg');
    expect(cache.url({ imdbId: 'tt1413492' })).toBe('https://image.tmdb.org/t/p/w342/poster.jpg');
  });

  it('honours the requested size', () => {
    cache.remember({ tvdbId: '610' }, '/p.jpg');
    expect(cache.url({ tvdbId: '610' }, 'original')).toBe('https://image.tmdb.org/t/p/original/p.jpg');
  });

  it('keeps show and movie ids in separate namespaces', () => {
    cache.remember({ tvdbId: '610' }, '/show.jpg');
    cache.remember({ imdbId: '610' }, '/movie.jpg');
    expect(cache.url({ tvdbId: '610' })).toContain('/show.jpg');
    expect(cache.url({ imdbId: '610' })).toContain('/movie.jpg');
  });

  it('prefers the IMDb id when a film carries both', () => {
    // List rows hand over both ids for a movie; the TheTVDB one belongs to an
    // unrelated series, so keying (and looking up) by it would be wrong.
    cache.remember({ tvdbId: '610', imdbId: 'tt1413492' }, '/movie.jpg');
    expect(cache.url({ imdbId: 'tt1413492' })).toContain('/movie.jpg');
    expect(cache.url({ tvdbId: '610' })).toBeNull();
  });

  it('ignores a title with no usable id, and an empty path', () => {
    cache.remember({}, '/p.jpg');
    cache.remember({ imdbId: 'tt1' }, null);
    expect(docs.posters.size).toBe(0);
  });

  it('does not rewrite an unchanged path', () => {
    cache.remember({ imdbId: 'tt1' }, '/p.jpg');
    let writes = 0;
    docs.posters.observe(() => writes++);
    cache.remember({ imdbId: 'tt1' }, '/p.jpg');
    expect(writes).toBe(0);
    cache.remember({ imdbId: 'tt1' }, '/newer.jpg');
    expect(writes).toBe(1);
  });

  it('sees paths that arrive from another device', () => {
    docs.posters.set('mv:tt1', '/synced.jpg');
    expect(cache.url({ imdbId: 'tt1' })).toContain('/synced.jpg');
    expect(cache.size()).toBe(1);
  });
});

/**
 * TMDB's settings page offers a v3 key and a v4 read access token side by side.
 * The v4 one is rejected as an `api_key=` param, which used to fail silently and
 * looked exactly like "movie covers are broken" — shows kept their backup
 * artwork, films had none to keep.
 */
describe('isBearerToken', () => {
  it('recognises a v4 read access token', () => {
    expect(isBearerToken('eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJhYmMifQ.c2lnbmF0dXJl')).toBeTrue();
  });

  it('leaves a v3 key on the query-string path', () => {
    expect(isBearerToken('0123456789abcdef0123456789abcdef')).toBeFalse();
  });

  it('is not fooled by a dotted key that is not a JWT', () => {
    expect(isBearerToken('abc.def.ghi')).toBeFalse();
    expect(isBearerToken('ey.two')).toBeFalse();
  });
});

describe('DocService poster import', () => {
  const file = (body: Record<string, unknown>) =>
    JSON.stringify({ kind: 'tvtime-revival-state', ...body });

  it('round-trips poster paths through export/import', () => {
    const source = new DocService();
    source.posters.set('mv:tt1', '/p.jpg');
    const restored = new DocService();
    restored.importJson(source.exportJson());
    expect(restored.posters.get('mv:tt1')).toBe('/p.jpg');
  });

  it('drops anything that is not a TMDB-shaped path', () => {
    const docs = new DocService();
    docs.importJson(
      file({
        posters: {
          'mv:tt1': '/good.jpg',
          'mv:tt2': 'javascript:alert(1)',
          'mv:tt3': 'https://evil.example/x.jpg',
          'mv:tt4': { nope: true },
        },
      }),
    );
    expect(docs.posters.get('mv:tt1')).toBe('/good.jpg');
    expect(docs.posters.size).toBe(1);
  });
});
